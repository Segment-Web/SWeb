


import {
  generateIdentity, Session, SenderKey, SenderKeyView,
  createPreKeyBundle, x3dhInitiate, x3dhRespond,
} from './index.js';

let ok = 0;
let fail = 0;
const check = (name, cond) => { (cond ? ok++ : fail++); console.log(`${cond ? 'ok  ' : 'FAIL'}  ${name}`); };


const alice = await generateIdentity();
const bob = await generateIdentity();

const aSess = await Session.fromKeys(alice.privateKey, bob.publicKey, true);
const bSess = await Session.fromKeys(bob.privateKey, alice.publicKey, false);

const m1 = await aSess.encrypt('hello, bob 🔒');
check('direct session: Bob decrypted Alice message', (await bSess.decrypt(m1)) === 'hello, bob 🔒');

const m2 = await bSess.encrypt('hello, alice');
check('direct session: Alice decrypted Bob response', (await aSess.decrypt(m2)) === 'hello, alice');


const m3 = await aSess.encrypt('same text');
const m4 = await aSess.encrypt('same text');
check('forward secrecy: identical text produces distinct ciphertext', JSON.stringify(m3.ct) !== JSON.stringify(m4.ct));
check('ordering: Bob decrypted consecutive messages', (await bSess.decrypt(m3)) === 'same text' && (await bSess.decrypt(m4)) === 'same text');


const eve = await generateIdentity();
const eSess = await Session.fromKeys(eve.privateKey, alice.publicKey, false);
let eveFailed = false;
try { await eSess.decrypt(await aSess.encrypt('secret')); } catch { eveFailed = true; }
check('outsider cannot decrypt', eveFailed);


const sender = SenderKey.create();
const distributed = sender.export();
const member1 = SenderKeyView.from(distributed);
const member2 = SenderKeyView.from(distributed);

const g1 = await sender.encrypt('hello, room 🌊');
check('room: first member decrypted', (await member1.decrypt(g1)) === 'hello, room 🌊');
check('room: second member decrypted', (await member2.decrypt(g1)) === 'hello, room 🌊');

const g2 = await sender.encrypt('second');
check('room: next message', (await member1.decrypt(g2)) === 'second');

// ── X3DH + Double Ratchet ──

const bobKit = await createPreKeyBundle(3);
const aliceKit = await createPreKeyBundle(3);


const bobPublic = { ...bobKit.bundle, opks: [bobKit.bundle.opks[0]] };
const { ratchet: aRatchet, x3dh } = await x3dhInitiate(aliceKit.secret, bobPublic);


const dr1 = await aRatchet.encrypt('hello over x3dh 🔑');
const bRatchet = await x3dhRespond(bobKit.secret, x3dh);
check('x3dh: Bob restored a session from the first message', (await bRatchet.decrypt(dr1)) === 'hello over x3dh 🔑');


const dr2 = await bRatchet.encrypt('hello back');
check('double ratchet: Alice decrypted after a direction change', (await aRatchet.decrypt(dr2)) === 'hello back');
const dr3 = await aRatchet.encrypt('how are you');
check('double ratchet: Bob decrypted after another direction change', (await bRatchet.decrypt(dr3)) === 'how are you');


const oo1 = await aRatchet.encrypt('one');
const oo2 = await aRatchet.encrypt('two');
check('out of order: Bob decrypted the second message first', (await bRatchet.decrypt(oo2)) === 'two');
check('out of order: Bob then decrypted the first message', (await bRatchet.decrypt(oo1)) === 'one');


let tamperCaught = false;
try {
  const badBundle = { ...bobKit.bundle, opks: [bobKit.bundle.opks[1]], spkSig: bobKit.bundle.spkSig.slice().reverse() };
  await x3dhInitiate(aliceKit.secret, badBundle);
} catch { tamperCaught = true; }
check('x3dh: forged signed-prekey signature rejected', tamperCaught);



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
check('hybrid: header includes KEM encapsulation', !!initH.x3dh.kemCt);
const h1 = await initH.ratchet.encrypt('post-quantum hybrid 🧬');
const respH = await x3dhRespond(bobHybrid.secret, initH.x3dh, mockKem);
check('hybrid: responder with the same KEM decrypted', (await respH.decrypt(h1)) === 'post-quantum hybrid 🧬');


const initH2 = await x3dhInitiate(aliceHybrid.secret, { ...bobHybrid.bundle, opks: [bobHybrid.bundle.opks[1]] }, mockKem);
const h2 = await initH2.ratchet.encrypt('requires PQ');
const respNoPq = await x3dhRespond(bobHybrid.secret, initH2.x3dh, null);
let pqMattered = false;
try { await respNoPq.decrypt(h2); } catch { pqMattered = true; }
check('hybrid: decryption fails without the PQ secret', pqMattered);

console.log(`\n${ok} ok, ${fail} fail`);
process.exit(fail ? 1 : 0);
