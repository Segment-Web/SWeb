// Самопроверка Segment Secure Layer: 1-на-1 и комнаты.
// Запуск: node packages/crypto/selftest.js

import {
  generateIdentity, Session, SenderKey, SenderKeyView,
  createPreKeyBundle, x3dhInitiate, x3dhRespond,
} from './index.js';

let ok = 0;
let fail = 0;
const check = (name, cond) => { (cond ? ok++ : fail++); console.log(`${cond ? 'ok  ' : 'FAIL'}  ${name}`); };

// ── 1-на-1 ──
const alice = await generateIdentity();
const bob = await generateIdentity();

const aSess = await Session.fromKeys(alice.privateKey, bob.publicKey, true);
const bSess = await Session.fromKeys(bob.privateKey, alice.publicKey, false);

const m1 = await aSess.encrypt('привет, боб 🔒');
check('1-на-1: боб расшифровал сообщение алисы', (await bSess.decrypt(m1)) === 'привет, боб 🔒');

const m2 = await bSess.encrypt('привет, алиса');
check('1-на-1: алиса расшифровала ответ боба', (await aSess.decrypt(m2)) === 'привет, алиса');

// forward secrecy: у каждого сообщения свой шифртекст/ключ
const m3 = await aSess.encrypt('одинаковый текст');
const m4 = await aSess.encrypt('одинаковый текст');
check('forward secrecy: одинаковый текст → разные шифртексты', JSON.stringify(m3.ct) !== JSON.stringify(m4.ct));
check('порядок: боб читает подряд', (await bSess.decrypt(m3)) === 'одинаковый текст' && (await bSess.decrypt(m4)) === 'одинаковый текст');

// чужой не расшифрует
const eve = await generateIdentity();
const eSess = await Session.fromKeys(eve.privateKey, alice.publicKey, false);
let eveFailed = false;
try { await eSess.decrypt(await aSess.encrypt('секрет')); } catch { eveFailed = true; }
check('посторонний (ева) НЕ может расшифровать', eveFailed);

// ── комнаты: sender-key ──
const sender = SenderKey.create();
const distributed = sender.export();            // раздаётся участникам по E2EE
const member1 = SenderKeyView.from(distributed);
const member2 = SenderKeyView.from(distributed);

const g1 = await sender.encrypt('привет, комната 🌊');
check('комната: участник 1 расшифровал', (await member1.decrypt(g1)) === 'привет, комната 🌊');
check('комната: участник 2 расшифровал то же', (await member2.decrypt(g1)) === 'привет, комната 🌊');

const g2 = await sender.encrypt('второе');
check('комната: следующее сообщение', (await member1.decrypt(g2)) === 'второе');

// ── X3DH + Double Ratchet ──
// Боб публикует бандл; Алиса устанавливает сессию БЕЗ участия Боба онлайн.
const bobKit = await createPreKeyBundle(3);
const aliceKit = await createPreKeyBundle(3);

// сервер отдаёт Алисе бандл Боба с одним одноразовым prekey
const bobPublic = { ...bobKit.bundle, opks: [bobKit.bundle.opks[0]] };
const { ratchet: aRatchet, x3dh } = await x3dhInitiate(aliceKit.secret, bobPublic);

// первое сообщение Алисы (несёт заголовок x3dh)
const dr1 = await aRatchet.encrypt('привет по x3dh 🔑');
const bRatchet = await x3dhRespond(bobKit.secret, x3dh);
check('x3dh: боб установил сессию из первого сообщения (офлайн-бандл)', (await bRatchet.decrypt(dr1)) === 'привет по x3dh 🔑');

// двусторонний диалог — проверяем DH-ratchet при смене направления
const dr2 = await bRatchet.encrypt('о, привет');
check('double ratchet: алиса читает ответ (сменилось направление)', (await aRatchet.decrypt(dr2)) === 'о, привет');
const dr3 = await aRatchet.encrypt('как дела');
check('double ratchet: боб читает (ещё смена направления)', (await bRatchet.decrypt(dr3)) === 'как дела');

// сообщения вне очереди (skipped message keys)
const oo1 = await aRatchet.encrypt('раз');
const oo2 = await aRatchet.encrypt('два');
check('вне очереди: боб читает второе раньше первого', (await bRatchet.decrypt(oo2)) === 'два');
check('вне очереди: затем догоняет первое', (await bRatchet.decrypt(oo1)) === 'раз');

// подделанная подпись signed-prekey отвергается
let tamperCaught = false;
try {
  const badBundle = { ...bobKit.bundle, opks: [bobKit.bundle.opks[1]], spkSig: bobKit.bundle.spkSig.slice().reverse() };
  await x3dhInitiate(aliceKit.secret, badBundle);
} catch { tamperCaught = true; }
check('x3dh: подделанная подпись signed-prekey отвергнута', tamperCaught);

// ── гибрид PQXDH: проверяем ПЛУМБИНГ подключаемого KEM ──
// ⚠️ mockKem НЕ безопасен и НЕ пост-квантовый — он лишь прогоняет обвязку.
const rnd = (n) => globalThis.crypto.getRandomValues(new Uint8Array(n));
const cat = (a, b) => { const o = new Uint8Array(a.length + b.length); o.set(a); o.set(b, a.length); return o; };
const sha = async (u8) => new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', u8));
const mockKem = {
  async generate() { const k = rnd(32); return { publicKey: k, secret: k }; },
  async encapsulate(pub) { const ct = rnd(32); return { ciphertext: ct, shared: await sha(cat(pub, ct)) }; },
  async decapsulate(secret, ct) { return sha(cat(secret, ct)); },
};

const bobHybrid = await createPreKeyBundle(2, mockKem);
const aliceHybrid = await createPreKeyBundle(2, mockKem);
const bobHybridPub = { ...bobHybrid.bundle, opks: [bobHybrid.bundle.opks[0]] };

const initH = await x3dhInitiate(aliceHybrid.secret, bobHybridPub, mockKem);
check('гибрид: заголовок несёт инкапсуляцию (kemCt)', !!initH.x3dh.kemCt);
const h1 = await initH.ratchet.encrypt('пост-квантовый гибрид 🧬');
const respH = await x3dhRespond(bobHybrid.secret, initH.x3dh, mockKem);
check('гибрид: ответчик с тем же KEM расшифровал', (await respH.decrypt(h1)) === 'пост-квантовый гибрид 🧬');

// если ответчик проигнорирует PQ-часть — секрет иной → расшифровать нельзя
const initH2 = await x3dhInitiate(aliceHybrid.secret, { ...bobHybrid.bundle, opks: [bobHybrid.bundle.opks[1]] }, mockKem);
const h2 = await initH2.ratchet.encrypt('только с PQ');
const respNoPq = await x3dhRespond(bobHybrid.secret, initH2.x3dh, null);
let pqMattered = false;
try { await respNoPq.decrypt(h2); } catch { pqMattered = true; }
check('гибрид: без PQ-секрета расшифровать нельзя (секрет реально подмешан)', pqMattered);

console.log(`\n${ok} ok, ${fail} fail`);
process.exit(fail ? 1 : 0);
