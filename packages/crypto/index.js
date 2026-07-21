
//






//


//




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



export async function generateIdentity() {
  return subtle.generateKey(ECDH, false, ['deriveBits']);
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


async function hkdfBits(ikm, info, salt, bytes) {
  const base = await subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']);
  const bits = await subtle.deriveBits(
    { name: 'HKDF', hash: 'SHA-256', salt, info: enc.encode(info) },
    base,
    bytes * 8,
  );
  return new Uint8Array(bits);
}


async function hkdf(ikm, info) {
  return hkdfBits(ikm, info, ZERO32, 32);
}


async function kdfRoot(rk, dhOut) {
  const out = await hkdfBits(dhOut, 'segment-dr-root', rk, 64);
  return [out.slice(0, 32), out.slice(32, 64)]; // [newRootKey, chainKey]
}


async function kdfChain(ck) {
  const messageKey = await hkdfBits(ck, 'segment-dr-msg', ZERO32, 32);
  const nextChain = await hkdfBits(ck, 'segment-dr-chain', ZERO32, 32);
  return [nextChain, messageKey];
}

async function aesKey(raw) {
  return subtle.importKey('raw', raw, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
}


export async function seal(keyRaw, plaintext, additionalData = null) {
  const iv = globalThis.crypto.getRandomValues(new Uint8Array(12));
  const key = await aesKey(keyRaw);
  const params = { name: 'AES-GCM', iv };
  if (additionalData) params.additionalData = typeof additionalData === 'string' ? enc.encode(additionalData) : additionalData;
  const ct = new Uint8Array(await subtle.encrypt(params, key, enc.encode(plaintext)));
  return { iv: b2a(iv), ct: b2a(ct) };
}

export async function open(keyRaw, box, additionalData = null) {
  const key = await aesKey(keyRaw);
  const params = { name: 'AES-GCM', iv: a2b(box.iv) };
  if (additionalData) params.additionalData = typeof additionalData === 'string' ? enc.encode(additionalData) : additionalData;
  const pt = await subtle.decrypt(params, key, a2b(box.ct));
  return dec.decode(pt);
}

// Binary AES-256-GCM for file bodies. Unlike seal/open these take and return
// raw bytes so attachments are not base64-inflated before encryption. Used by
// the client to encrypt a file, upload the opaque ciphertext, and decrypt it
// back on the receiving device.
export function randomFileKey() {
  return b2a(globalThis.crypto.getRandomValues(new Uint8Array(32)));
}

export async function sealBytes(keyRaw, bytes) {
  const iv = globalThis.crypto.getRandomValues(new Uint8Array(12));
  const key = await aesKey(a2b(keyRaw));
  const ct = new Uint8Array(await subtle.encrypt({ name: 'AES-GCM', iv }, key, bytes));
  return { iv: b2a(iv), ct };
}

export async function openBytes(keyRaw, iv, ct) {
  const key = await aesKey(a2b(keyRaw));
  return new Uint8Array(await subtle.decrypt({ name: 'AES-GCM', iv: a2b(iv) }, key, ct));
}



// secrecy.
async function ratchetStep(chain) {
  const messageKey = await hkdf(chain, 'segment-msg');
  const nextChain = await hkdf(chain, 'segment-chain');
  return { messageKey, nextChain };
}



const senderContext = (context, n) => `${String(context?.roomId || '')}\u0000${Number(context?.epoch) || 0}\u0000${String(context?.senderId || '')}\u0000${n}`;
const senderSignatureBytes = (context, n, iv, ct) => enc.encode(JSON.stringify([senderContext(context, n), iv, ct]));

export class SenderKey {
  static async create() {
    const s = new SenderKey();
    s._chain = globalThis.crypto.getRandomValues(new Uint8Array(32));
    s._n = 0;
    s._signature = await subtle.generateKey(SIGN, false, ['sign', 'verify']);
    return s;
  }

  async export() {
    return { chain: b2a(this._chain), n: this._n, sigPub: await exportRaw(this._signature.publicKey) };
  }

  async encrypt(text, context = {}) {
    const n = this._n++;
    const { messageKey, nextChain } = await ratchetStep(this._chain);
    this._chain = nextChain;
    const aad = senderContext(context, n);
    const box = await seal(messageKey, text, aad);
    const sig = new Uint8Array(await subtle.sign(
      { name: 'ECDSA', hash: 'SHA-256' }, this._signature.privateKey,
      senderSignatureBytes(context, n, box.iv, box.ct),
    ));
    return { n, ...box, sig: b2a(sig) };
  }
}

export class SenderKeyView {
  static from(state) {
    if (!state || !Array.isArray(state.chain) || state.chain.length !== 32
      || !Number.isSafeInteger(state.n) || state.n < 0
      || !Array.isArray(state.sigPub) || state.sigPub.length < 32) throw new Error('INVALID_SENDER_KEY');
    const v = new SenderKeyView();
    v._chain = a2b(state.chain);
    v._n = state.n;
    v._signature = null;
    v._signatureRaw = [...state.sigPub];
    return v;
  }

  async decrypt(msg, context = {}) {
    if (!msg || !Number.isSafeInteger(msg.n) || msg.n < this._n) throw new Error('REPLAYED_SENDER_MESSAGE');
    if (msg.n - this._n > MAX_SKIP) throw new Error('SENDER_SKIP_LIMIT');
    if (!Array.isArray(msg.sig)) throw new Error('MISSING_SENDER_SIGNATURE');
    this._signature ||= await importVerify(this._signatureRaw);
    const valid = await subtle.verify(
      { name: 'ECDSA', hash: 'SHA-256' }, this._signature, a2b(msg.sig),
      senderSignatureBytes(context, msg.n, msg.iv, msg.ct),
    );
    if (!valid) throw new Error('INVALID_SENDER_SIGNATURE');
    while (this._n < msg.n) {
      this._chain = (await ratchetStep(this._chain)).nextChain;
      this._n++;
    }
    const { messageKey, nextChain } = await ratchetStep(this._chain);
    this._chain = nextChain;
    this._n++;
    return open(messageKey, msg, senderContext(context, msg.n));
  }
}


//




const MAX_SKIP = 256;
const MAX_SKIPPED_KEYS = 1000;
const MAX_SKIPPED_AGE_MS = 5 * 60 * 1000;

export class DoubleRatchet {

  static async initInitiator(sk, theirSignedPreKeyPub) {
    const r = new DoubleRatchet();
    r.DHs = await subtle.generateKey(ECDH, false, ['deriveBits']);
    r.DHr = theirSignedPreKeyPub;
    const [rk, cks] = await kdfRoot(sk, await ecdh(r.DHs.privateKey, r.DHr));
    r.RK = rk; r.CKs = cks; r.CKr = null;
    r.Ns = 0; r.Nr = 0; r.PN = 0; r.skipped = new Map();
    return r;
  }


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
    const box = await seal(mk, plaintext, JSON.stringify(header));
    return { header, iv: box.iv, ct: box.ct };
  }

  async decrypt(msg) {
    const snapshot = {
      RK: this.RK, CKs: this.CKs, CKr: this.CKr, DHs: this.DHs, DHr: this.DHr,
      Ns: this.Ns, Nr: this.Nr, PN: this.PN, skipped: new Map(this.skipped),
    };
    try { return await this._decryptInternal(msg); }
    catch (error) { Object.assign(this, snapshot); throw error; }
  }

  async _decryptInternal(msg) {
    const h = msg.header;
    const dhKey = h.dh.join(',');
    const skipKey = `${dhKey}|${h.n}`;
    if (this.skipped.has(skipKey)) {
      const entry = this.skipped.get(skipKey);
      this.skipped.delete(skipKey);
      if (!entry || Date.now() - entry.at > MAX_SKIPPED_AGE_MS) throw new Error('expired skipped message key');
      return open(entry.mk, msg, JSON.stringify(h));
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
    return open(mk, msg, JSON.stringify(h));
  }

  async _skip(until) {
    if (this.CKr == null) return;
    if (until - this.Nr > MAX_SKIP) throw new Error('too many skipped messages');
    const dhKey = (await exportRaw(this.DHr)).join(',');
    const cutoff = Date.now() - MAX_SKIPPED_AGE_MS;
    for (const [key, entry] of this.skipped) if (entry.at < cutoff) this.skipped.delete(key);
    while (this.Nr < until) {
      const [ckr, mk] = await kdfChain(this.CKr);
      this.CKr = ckr;
      this.skipped.set(`${dhKey}|${this.Nr}`, { mk, at: Date.now() });
      while (this.skipped.size > MAX_SKIPPED_KEYS) this.skipped.delete(this.skipped.keys().next().value);
      this.Nr++;
    }
  }

  async _dhRatchet(h) {
    this.PN = this.Ns;
    this.Ns = 0;
    this.Nr = 0;
    this.DHr = await importPublic(h.dh);
    [this.RK, this.CKr] = await kdfRoot(this.RK, await ecdh(this.DHs.privateKey, this.DHr));
    this.DHs = await subtle.generateKey(ECDH, false, ['deriveBits']);
    [this.RK, this.CKs] = await kdfRoot(this.RK, await ecdh(this.DHs.privateKey, this.DHr));
  }
}


//







export async function createOneTimePreKeys(count = 8) {
  const secret = [];
  for (let i = 0; i < Math.max(0, Math.min(Number(count) || 0, 32)); i++) {
    secret.push({ id: globalThis.crypto.randomUUID(), pair: await subtle.generateKey(ECDH, false, ['deriveBits']) });
  }
  const bundle = await Promise.all(secret.map(async (item) => ({ id: item.id, key: await exportRaw(item.pair.publicKey) })));
  return { secret, bundle };
}

export async function createPreKeyBundle(oneTime = 8, kem = null) {
  const idDh = await subtle.generateKey(ECDH, false, ['deriveBits']);
  const idSign = await subtle.generateKey(SIGN, false, ['sign', 'verify']);
  const spk = await subtle.generateKey(ECDH, false, ['deriveBits']);
  const spkRaw = new Uint8Array(await subtle.exportKey('raw', spk.publicKey));
  const spkSig = new Uint8Array(await subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, idSign.privateKey, spkRaw));

  const generated = await createOneTimePreKeys(oneTime);
  const opks = generated.secret;

  const secret = { idDh, idSign, spk, opks };
  const bundle = {
    idDh: await exportRaw(idDh.publicKey),
    idSign: await exportRaw(idSign.publicKey),
    spk: b2a(spkRaw),
    spkSig: b2a(spkSig),
    opks: generated.bundle,
  };


  if (kem) {
    const pair = await kem.generate();
    secret.kem = pair.secret;
    bundle.kem = b2a(pair.publicKey);
  }
  return { secret, bundle };
}




async function x3dhSecret(dhs, pq) {
  return hkdf(pq ? concat(...dhs, pq) : concat(...dhs), 'segment-x3dh');
}




export async function x3dhInitiate(mySecret, theirBundle, kem = null) {
  const idSignPub = await importVerify(theirBundle.idSign);
  const good = await subtle.verify(
    { name: 'ECDSA', hash: 'SHA-256' }, idSignPub, a2b(theirBundle.spkSig), a2b(theirBundle.spk),
  );
  if (!good) throw new Error('invalid signed-prekey signature');

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


  let pq = null;
  if (kem && x3dh.kemCt && mySecret.kem) {
    pq = await kem.decapsulate(mySecret.kem, a2b(x3dh.kemCt));
  }

  const sk = await x3dhSecret(dhs, pq);
  return DoubleRatchet.initResponder(sk, mySecret.spk);
}


//






//   encapsulate(pubRaw)   -> { ciphertext: Uint8Array, shared: Uint8Array }
//   decapsulate(secret,ct)-> shared: Uint8Array


//
