// Segment Secure Layer — собственный слой E2EE.
//
// ⚠️ ПРОТОТИП-ФУНДАМЕНТ, НЕ ГОТОВАЯ К БОЮ КРИПТА. Требует независимого аудита
// перед использованием в проде. Мы НЕ изобретаем криптопримитивы — только
// собираем протокол из стандартных, проверенных примитивов WebCrypto:
//   • AES-256-GCM  — шифрование (конфиденциальность + аутентичность);
//   • ECDH P-256   — обмен ключами между устройствами;
//   • HKDF-SHA-256 — вывод ключей и ratchet-цепочки.
//
// Работает и в браузере, и в Node 20+ (глобальный WebCrypto). Никаких сторонних
// крипто-библиотек — это «наш» слой.
//
// Что уже есть: forward secrecy (у каждого сообщения свой ключ, цепочка
// проматывается вперёд). Чего пока нет (TODO): DH-ratchet (post-compromise
// security), prekeys без онлайна, ротация ключей комнаты, пост-квантовая часть.

const subtle = globalThis.crypto.subtle;
const enc = new TextEncoder();
const dec = new TextDecoder();

const ECDH = { name: 'ECDH', namedCurve: 'P-256' };
const SIGN = { name: 'ECDSA', namedCurve: 'P-256' };
const ZERO32 = new Uint8Array(32);
const b2a = (u8) => Array.from(u8);
const a2b = (arr) => new Uint8Array(arr);

function concat(...arrs) {
  const total = arrs.reduce((s, a) => s + a.length, 0);
  const out = new Uint8Array(total);
  let o = 0;
  for (const a of arrs) { out.set(a, o); o += a.length; }
  return out;
}

async function exportRaw(publicKey) {
  return b2a(new Uint8Array(await subtle.exportKey('raw', publicKey)));
}

async function importVerify(raw) {
  return subtle.importKey('raw', a2b(raw), SIGN, true, ['verify']);
}

// ── примитивы ──

export async function generateIdentity() {
  return subtle.generateKey(ECDH, true, ['deriveBits']);
}

export async function exportPublic(publicKey) {
  return b2a(new Uint8Array(await subtle.exportKey('raw', publicKey)));
}

export async function importPublic(raw) {
  return subtle.importKey('raw', a2b(raw), ECDH, true, []);
}

async function ecdh(privateKey, publicKey) {
  return new Uint8Array(await subtle.deriveBits({ name: 'ECDH', public: publicKey }, privateKey, 256));
}

// HKDF: из ключевого материала выводим нужное число байт под метку (с солью).
async function hkdfBits(ikm, info, salt, bytes) {
  const base = await subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']);
  const bits = await subtle.deriveBits(
    { name: 'HKDF', hash: 'SHA-256', salt, info: enc.encode(info) },
    base,
    bytes * 8,
  );
  return new Uint8Array(bits);
}

// 32 байта под метку (нулевая соль) — для sender-key и вывода общего секрета.
async function hkdf(ikm, info) {
  return hkdfBits(ikm, info, ZERO32, 32);
}

// KDF корневого ключа (Double Ratchet): соль = текущий root, ikm = выход DH.
async function kdfRoot(rk, dhOut) {
  const out = await hkdfBits(dhOut, 'segment-dr-root', rk, 64);
  return [out.slice(0, 32), out.slice(32, 64)]; // [newRootKey, chainKey]
}

// KDF цепочки: из ключа цепочки — ключ сообщения и следующий ключ цепочки.
async function kdfChain(ck) {
  const messageKey = await hkdfBits(ck, 'segment-dr-msg', ZERO32, 32);
  const nextChain = await hkdfBits(ck, 'segment-dr-chain', ZERO32, 32);
  return [nextChain, messageKey];
}

async function aesKey(raw) {
  return subtle.importKey('raw', raw, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
}

// Шифрование одним ключом (низкий уровень). Возвращает переносимый объект.
export async function seal(keyRaw, plaintext) {
  const iv = globalThis.crypto.getRandomValues(new Uint8Array(12));
  const key = await aesKey(keyRaw);
  const ct = new Uint8Array(await subtle.encrypt({ name: 'AES-GCM', iv }, key, enc.encode(plaintext)));
  return { iv: b2a(iv), ct: b2a(ct) };
}

export async function open(keyRaw, box) {
  const key = await aesKey(keyRaw);
  const pt = await subtle.decrypt({ name: 'AES-GCM', iv: a2b(box.iv) }, key, a2b(box.ct));
  return dec.decode(pt);
}

// Одна ступень храповика: из состояния цепочки выводим ключ сообщения и
// следующее состояние. Старое состояние затирается вызывающим — отсюда forward
// secrecy.
async function ratchetStep(chain) {
  const messageKey = await hkdf(chain, 'segment-msg');
  const nextChain = await hkdf(chain, 'segment-chain');
  return { messageKey, nextChain };
}

// ── 1-на-1: сессия с симметричным храповиком ──

export class Session {
  // sharedSecret — общий секрет ECDH; initiator — кто начал (для разведения
  // направлений send/recv у двух сторон).
  static async establish(sharedSecret, initiator) {
    const root = await hkdf(sharedSecret, 'segment-root');
    const a2bChain = await hkdf(root, 'segment-a2b');
    const b2aChain = await hkdf(root, 'segment-b2a');
    const s = new Session();
    s._send = initiator ? a2bChain : b2aChain;
    s._recv = initiator ? b2aChain : a2bChain;
    s._sendN = 0;
    s._recvN = 0;
    return s;
  }

  // Удобный конструктор: сразу из ключей ECDH.
  static async fromKeys(myPrivate, theirPublic, initiator) {
    return Session.establish(await ecdh(myPrivate, theirPublic), initiator);
  }

  async encrypt(text) {
    const { messageKey, nextChain } = await ratchetStep(this._send);
    this._send = nextChain;
    const box = await seal(messageKey, text);
    return { n: this._sendN++, ...box };
  }

  async decrypt(msg) {
    // догоняем цепочку до номера сообщения (простая обработка пропусков)
    while (this._recvN < msg.n) {
      this._recv = (await ratchetStep(this._recv)).nextChain;
      this._recvN++;
    }
    const { messageKey, nextChain } = await ratchetStep(this._recv);
    this._recv = nextChain;
    this._recvN++;
    return open(messageKey, msg);
  }
}

// ── комнаты: sender-key ──
//
// У каждого отправителя своя цепочка. Её стартовое состояние (export()) он
// раздаёт остальным участникам по личным Session-каналам — сервер его не видит.

export class SenderKey {
  static create() {
    const s = new SenderKey();
    s._chain = globalThis.crypto.getRandomValues(new Uint8Array(32));
    s._n = 0;
    return s;
  }

  // Стартовое состояние для раздачи участникам (передавать только через E2EE).
  export() {
    return { chain: b2a(this._chain), n: this._n };
  }

  async encrypt(text) {
    const { messageKey, nextChain } = await ratchetStep(this._chain);
    this._chain = nextChain;
    const box = await seal(messageKey, text);
    return { n: this._n++, ...box };
  }
}

export class SenderKeyView {
  static from(state) {
    const v = new SenderKeyView();
    v._chain = a2b(state.chain);
    v._n = state.n;
    return v;
  }

  async decrypt(msg) {
    while (this._n < msg.n) {
      this._chain = (await ratchetStep(this._chain)).nextChain;
      this._n++;
    }
    const { messageKey, nextChain } = await ratchetStep(this._chain);
    this._chain = nextChain;
    this._n++;
    return open(messageKey, msg);
  }
}

// ── Double Ratchet (двойной храповик) ──
//
// Даёт не только forward secrecy, но и post-compromise security: на каждый
// обмен направлениями подмешивается новый DH — после утечки ключей канал
// «самовосстанавливается». Сообщение несёт заголовок { dh, pn, n }.

const MAX_SKIP = 256;

export class DoubleRatchet {
  // Инициатор: знает общий секрет sk (из X3DH) и публичный signed-prekey ответчика.
  static async initInitiator(sk, theirSignedPreKeyPub) {
    const r = new DoubleRatchet();
    r.DHs = await subtle.generateKey(ECDH, true, ['deriveBits']);
    r.DHr = theirSignedPreKeyPub;
    const [rk, cks] = await kdfRoot(sk, await ecdh(r.DHs.privateKey, r.DHr));
    r.RK = rk; r.CKs = cks; r.CKr = null;
    r.Ns = 0; r.Nr = 0; r.PN = 0; r.skipped = new Map();
    return r;
  }

  // Ответчик: sk (тот же) и его signed-prekey ПАРА (её публичную часть использовал инициатор).
  static async initResponder(sk, signedPreKeyPair) {
    const r = new DoubleRatchet();
    r.DHs = signedPreKeyPair;
    r.DHr = null;
    r.RK = sk; r.CKs = null; r.CKr = null;
    r.Ns = 0; r.Nr = 0; r.PN = 0; r.skipped = new Map();
    return r;
  }

  async encrypt(plaintext) {
    const [cks, mk] = await kdfChain(this.CKs);
    this.CKs = cks;
    const header = { dh: await exportRaw(this.DHs.publicKey), pn: this.PN, n: this.Ns };
    this.Ns++;
    const box = await seal(mk, plaintext);
    return { header, iv: box.iv, ct: box.ct };
  }

  async decrypt(msg) {
    const h = msg.header;
    const dhKey = h.dh.join(',');
    const skipKey = `${dhKey}|${h.n}`;
    if (this.skipped.has(skipKey)) {
      const mk = this.skipped.get(skipKey);
      this.skipped.delete(skipKey);
      return open(mk, msg);
    }
    const curDhr = this.DHr ? (await exportRaw(this.DHr)).join(',') : null;
    if (curDhr !== dhKey) {
      await this._skip(h.pn);
      await this._dhRatchet(h);
    }
    await this._skip(h.n);
    const [ckr, mk] = await kdfChain(this.CKr);
    this.CKr = ckr;
    this.Nr++;
    return open(mk, msg);
  }

  async _skip(until) {
    if (this.CKr == null) return;
    if (until - this.Nr > MAX_SKIP) throw new Error('too many skipped messages');
    const dhKey = (await exportRaw(this.DHr)).join(',');
    while (this.Nr < until) {
      const [ckr, mk] = await kdfChain(this.CKr);
      this.CKr = ckr;
      this.skipped.set(`${dhKey}|${this.Nr}`, mk);
      this.Nr++;
    }
  }

  async _dhRatchet(h) {
    this.PN = this.Ns;
    this.Ns = 0;
    this.Nr = 0;
    this.DHr = await importPublic(h.dh);
    [this.RK, this.CKr] = await kdfRoot(this.RK, await ecdh(this.DHs.privateKey, this.DHr));
    this.DHs = await subtle.generateKey(ECDH, true, ['deriveBits']);
    [this.RK, this.CKs] = await kdfRoot(this.RK, await ecdh(this.DHs.privateKey, this.DHr));
  }
}

// ── X3DH: установление сессии без онлайна собеседника ──
//
// Каждый публикует prekey-бандл (идентификационные ключи + подписанный prekey +
// одноразовые prekeys). Инициатор берёт бандл (сервер отдаёт один одноразовый
// prekey) и выводит общий секрет; ответчик выводит тот же секрет из первого
// сообщения — быть онлайн ему не нужно.

// Создаёт бандл. Приватная часть (secret) хранится у владельца, публичная
// (bundle) — публикуется. oneTime — сколько одноразовых prekeys сгенерировать.
export async function createPreKeyBundle(oneTime = 8, kem = null) {
  const idDh = await subtle.generateKey(ECDH, true, ['deriveBits']);
  const idSign = await subtle.generateKey(SIGN, true, ['sign', 'verify']);
  const spk = await subtle.generateKey(ECDH, true, ['deriveBits']);
  const spkRaw = new Uint8Array(await subtle.exportKey('raw', spk.publicKey));
  const spkSig = new Uint8Array(await subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, idSign.privateKey, spkRaw));

  const opks = [];
  for (let i = 0; i < oneTime; i++) {
    opks.push({ id: globalThis.crypto.randomUUID(), pair: await subtle.generateKey(ECDH, true, ['deriveBits']) });
  }

  const secret = { idDh, idSign, spk, opks };
  const bundle = {
    idDh: await exportRaw(idDh.publicKey),
    idSign: await exportRaw(idSign.publicKey),
    spk: b2a(spkRaw),
    spkSig: b2a(spkSig),
    opks: await Promise.all(opks.map(async (o) => ({ id: o.id, key: await exportRaw(o.pair.publicKey) }))),
  };

  // гибрид: если передан пост-квантовый KEM — кладём его публичный ключ в бандл
  if (kem) {
    const pair = await kem.generate();
    secret.kem = pair.secret;
    bundle.kem = b2a(pair.publicKey);
  }
  return { secret, bundle };
}

// Общий секрет X3DH. `pq` — необязательный пост-квантовый секрет (гибрид PQXDH):
// подмешивается к классическим DH, чтобы стойкость держалась, даже если один из
// механизмов будет взломан (в т.ч. квантовым компьютером).
async function x3dhSecret(dhs, pq) {
  return hkdf(pq ? concat(...dhs, pq) : concat(...dhs), 'segment-x3dh');
}

// Инициатор: из своего secret и бандла собеседника (bundle с одним opk от сервера).
// `kem` — необязательный пост-квантовый механизм инкапсуляции (см. ниже).
// Возвращает готовый Double Ratchet и заголовок x3dh для первого сообщения.
export async function x3dhInitiate(mySecret, theirBundle, kem = null) {
  const idSignPub = await importVerify(theirBundle.idSign);
  const good = await subtle.verify(
    { name: 'ECDSA', hash: 'SHA-256' }, idSignPub, a2b(theirBundle.spkSig), a2b(theirBundle.spk),
  );
  if (!good) throw new Error('подпись signed-prekey неверна');

  const theirIdDh = await importPublic(theirBundle.idDh);
  const theirSpk = await importPublic(theirBundle.spk);
  const ek = await subtle.generateKey(ECDH, true, ['deriveBits']);

  const dhs = [
    await ecdh(mySecret.idDh.privateKey, theirSpk), // DH1: IK_a · SPK_b
    await ecdh(ek.privateKey, theirIdDh),           // DH2: EK_a · IK_b
    await ecdh(ek.privateKey, theirSpk),            // DH3: EK_a · SPK_b
  ];
  const opk = theirBundle.opks && theirBundle.opks[0];
  if (opk) dhs.push(await ecdh(ek.privateKey, await importPublic(opk.key))); // DH4: EK_a · OPK_b

  // гибрид: инкапсулируем пост-квантовый секрет против PQ-ключа собеседника
  let pq = null;
  let kemCt = null;
  if (kem && theirBundle.kem) {
    const { ciphertext, shared } = await kem.encapsulate(a2b(theirBundle.kem));
    pq = shared;
    kemCt = b2a(ciphertext);
  }

  const sk = await x3dhSecret(dhs, pq);
  const ratchet = await DoubleRatchet.initInitiator(sk, theirSpk);
  const x3dh = {
    idDh: await exportRaw(mySecret.idDh.publicKey),
    ek: await exportRaw(ek.publicKey),
    opkId: opk ? opk.id : null,
    kemCt,
  };
  return { ratchet, x3dh };
}

// Ответчик: из своего secret и заголовка x3dh инициатора выводит тот же секрет.
export async function x3dhRespond(mySecret, x3dh, kem = null) {
  const theirIdDh = await importPublic(x3dh.idDh);
  const theirEk = await importPublic(x3dh.ek);

  const dhs = [
    await ecdh(mySecret.spk.privateKey, theirIdDh), // DH1
    await ecdh(mySecret.idDh.privateKey, theirEk),  // DH2
    await ecdh(mySecret.spk.privateKey, theirEk),   // DH3
  ];
  if (x3dh.opkId) {
    const opk = mySecret.opks.find((o) => o.id === x3dh.opkId);
    if (opk) dhs.push(await ecdh(opk.pair.privateKey, theirEk)); // DH4
  }

  // гибрид: восстанавливаем тот же пост-квантовый секрет декапсуляцией
  let pq = null;
  if (kem && x3dh.kemCt && mySecret.kem) {
    pq = await kem.decapsulate(mySecret.kem, a2b(x3dh.kemCt));
  }

  const sk = await x3dhSecret(dhs, pq);
  return DoubleRatchet.initResponder(sk, mySecret.spk);
}

// ── Гибридный пост-квантовый механизм (PQXDH) ──
//
// ⚠️ ЧЕСТНО: настоящего пост-квантового KEM здесь НЕТ. В WebCrypto нет ML-KEM
// (Kyber), а писать пост-квантовые примитивы вручную нельзя — это было бы хуже
// классики. Ниже — только ИНТЕРФЕЙС и точка подключения: когда появится
// проверенная реализация ML-KEM (вставленная как объект `kem`), гибрид включится
// без изменения протокола. Объект `kem` должен реализовать:
//   generate()            -> { publicKey: Uint8Array, secret: <приват> }
//   encapsulate(pubRaw)   -> { ciphertext: Uint8Array, shared: Uint8Array }
//   decapsulate(secret,ct)-> shared: Uint8Array
// Публичный ключ кладётся в бандл (createPreKeyBundle с kem), инкапсуляция едет в
// x3dh.kemCt, а общий секрет подмешивается к классическим DH в HKDF.
//
// Пока `kem` не передан, всё работает на классике (ECDH) — как сейчас в ядре.
