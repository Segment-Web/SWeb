import { createServer } from 'node:http';
import { createAuth } from './auth.js';

const databaseUrl = process.env.TEST_DATABASE_URL;
if (!databaseUrl) throw new Error('TEST_DATABASE_URL is required');

const config = {
  production: false,
  databaseUrl,
  authSecret: 'selftest-secret-that-is-not-used-in-production',
  authCodeTtlMs: 600000,
  authSessionTtlMs: 3600000,
  authMaxAvatarBytes: 524288,
  trustProxy: false,
  allowedOrigins: [],
  publicUrl: '',
  smtp: { test: true, host: '', port: 587, secure: false, user: '', pass: '', from: 'Segment <test@segment.local>' },
};

const auth = await createAuth(config);
const server = createServer(async (req, res) => { if (!await auth.handle(req, res)) { res.writeHead(404); res.end(); } });
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;
const makeCaller=()=>{const cookies=new Map();const call=async (path, body, method = 'POST') => {
  const response = await fetch(`${base}/api/auth/${path}`, {
    method, headers: { 'Content-Type': 'application/json', ...(cookies.size ? { Cookie:[...cookies].map(([key,value])=>`${key}=${value}`).join('; ') } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const setCookies = response.headers.getSetCookie?.() || (response.headers.get('set-cookie') ? [response.headers.get('set-cookie')] : []);
  for (const header of setCookies) {
    const [pair] = header.split(';'); const at = pair.indexOf('=');
    if (at >= 0) { const key=pair.slice(0,at); const value=pair.slice(at+1); if (value) cookies.set(key,value); else cookies.delete(key); }
  }
  return { status: response.status, data: await response.json() };
};return{call,cookies};};
const primary=makeCaller();const call=primary.call;const cookies=primary.cookies;
const email = `test-${Date.now()}@example.com`;
const requested = await call('request-code', { email });
if (requested.status !== 200 || !requested.data.devCode) throw new Error('request-code failed');
const verified = await call('verify-code', { email, code: requested.data.devCode });
if (!verified.data.needsProfile || !verified.data.registrationToken) throw new Error('verify-code failed');
const registered = await call('register', { registrationToken: verified.data.registrationToken, username: `user_${Date.now()}`.slice(-24), name: 'Auth Test', avatar: '' });
if (registered.status !== 201 || !registered.data.user?.id || !cookies.has('segment_session')) throw new Error('register failed');
const deviceId = '123e4567-e89b-42d3-a456-426614174000';
const bytes = (seed) => Array.from({ length: 65 }, (_, index) => (seed + index) % 256);
const bundle = { deviceId, idDh: bytes(1), idSign: bytes(2), spk: bytes(3), spkSig: bytes(4), opks: [{ id:'opk-1', key:bytes(5) }] };
const pinned = await auth.pinDeviceBundle(registered.data.user.id, deviceId, bundle);
if (pinned.deviceId !== deviceId || pinned.opks.length !== 1) throw new Error('device pin failed');
const consumed = await auth.consumeDevicePreKey(registered.data.user.id, registered.data.user.id, deviceId);
if (consumed?.id !== 'opk-1' || await auth.consumeDevicePreKey(registered.data.user.id, registered.data.user.id, deviceId)) throw new Error('one-time prekey consumption failed');
const staleSync = await auth.replenishDevicePreKeys(registered.data.user.id, deviceId, bundle.opks);
if (staleSync.count !== 0 || staleSync.ids.length) throw new Error('offline-consumed prekey was restored by stale sync');
const replenished = await auth.replenishDevicePreKeys(registered.data.user.id, deviceId, [{ id:'opk-2', key:bytes(6) }]);
await auth.pool.query('DELETE FROM device_prekey_requests WHERE requester_id=$1 AND target_id=$1', [registered.data.user.id]);
if (replenished.count !== 1 || (await auth.consumeDevicePreKey(registered.data.user.id, registered.data.user.id, deviceId))?.id !== 'opk-2') throw new Error('one-time prekey replenishment failed');
let identityChangeRejected = false;
try { await auth.pinDeviceBundle(registered.data.user.id, deviceId, { ...bundle, idDh:bytes(9) }); }
catch (error) { identityChangeRejected = error.message === 'DEVICE_IDENTITY_CHANGED'; }
if (!identityChangeRejected) throw new Error('device identity replacement was accepted');
for (let index=1; index<5; index++) {
  await auth.pinDeviceBundle(registered.data.user.id, `123e4567-e89b-42d3-a456-42661417400${index}`, { ...bundle, deviceId:`123e4567-e89b-42d3-a456-42661417400${index}`, idDh:bytes(10+index), idSign:bytes(20+index) });
}
let deviceLimitRejected = false;
try { await auth.pinDeviceBundle(registered.data.user.id, '123e4567-e89b-42d3-a456-426614174005', { ...bundle, deviceId:'123e4567-e89b-42d3-a456-426614174005', idDh:bytes(30), idSign:bytes(31) }); }
catch (error) { deviceLimitRejected = error.message === 'DEVICE_LIMIT'; }
if (!deviceLimitRejected) throw new Error('per-account device limit failed');
const devices = await call('devices', undefined, 'GET');
if (devices.status !== 200 || devices.data.devices.length !== 5) throw new Error('device listing failed');
const forgottenId=devices.data.devices.find((item)=>item.deviceId!==deviceId).deviceId;
let revokedEvent=null;const stopDeviceListener=auth.onDeviceRemoved((event)=>{revokedEvent=event;});
const forgotten = await call(`devices/${forgottenId}`, undefined, 'DELETE');
stopDeviceListener();
if (forgotten.status !== 200 || revokedEvent?.deviceId!==forgottenId) throw new Error('device removal failed');
let revokedRejected=false;
try { await auth.pinDeviceBundle(registered.data.user.id,forgottenId,{...bundle,deviceId:forgottenId,idDh:bytes(40),idSign:bytes(41)}); }
catch(error){revokedRejected=error.message==='DEVICE_REVOKED';}
if(!revokedRejected)throw new Error('revoked device was able to register again');
await auth.pinDeviceBundle(registered.data.user.id, '123e4567-e89b-42d3-a456-426614174005', { ...bundle, deviceId:'123e4567-e89b-42d3-a456-426614174005', idDh:bytes(30), idSign:bytes(31) });
const me = await call('me', undefined, 'GET');
if (me.status !== 200 || me.data.user.id !== registered.data.user.id) throw new Error('session failed');
const profile = await call('profile', {
  bio: 'Open-source messenger', status: 'Building Segment',
  links: [{ label: 'Website', url: 'https://segmnt.org' }],
  profile: { pinnedBadges: ['early', 'mods', 'invalid'] },
  privacy: { avatar: 'members', bio: 'everyone', status: 'nobody', links: 'members' },
}, 'PATCH');
if (profile.status !== 200 || profile.data.user.bio !== 'Open-source messenger' || profile.data.user.links.length !== 1 || profile.data.user.profile.pinnedBadges.length !== 1 || profile.data.user.profile.pinnedBadges.includes('invalid')) throw new Error('profile update failed');
const settings = await call('settings', {
  settings: { themeId: 'graphite', density: 'compact', sendByEnter: false, installedMods: [{ id: 'compact', name: 'Compact', version: '1.0.0', enabled: true, features: ['compact-bubbles', 'run-script'] }] },
}, 'PATCH');
if (settings.status !== 200 || settings.data.settings.themeId !== 'graphite' || settings.data.settings.installedMods[0].features.includes('run-script')) throw new Error('settings update failed');
const updatedMe = await call('me', undefined, 'GET');
if (updatedMe.data.user.settings.themeId !== 'graphite' || updatedMe.data.user.privacy.status !== 'nobody') throw new Error('profile persistence failed');
const lockedEmail = `locked-${Date.now()}@example.com`;
const lockCode = await call('request-code', { email:lockedEmail });
for (let attempt=0; attempt<5; attempt++) await call('verify-code', { email:lockedEmail, code:'000000' });
const lockedReissue = await call('request-code', { email:lockedEmail });
const unlocked = await call('verify-code', { email:lockedEmail, code:lockedReissue.data.devCode });
if (lockCode.status !== 200 || lockedReissue.status !== 200 || !unlocked.data.needsProfile) throw new Error('new code did not clear the per-code attempt counter');
const isolatedEmail=`isolated-${Date.now()}@example.com`;const victim=makeCaller();const attacker=makeCaller();
const victimCode=await victim.call('request-code',{email:isolatedEmail});
await attacker.call('request-code',{email:isolatedEmail});
const victimVerify=await victim.call('verify-code',{email:isolatedEmail,code:victimCode.data.devCode});
if(!victimVerify.data.needsProfile)throw new Error('another device invalidated the active login challenge');
const logout = await call('logout', {});
if (logout.status !== 200) throw new Error('logout failed');
console.log('auth ok: request, verify, register, device pinning, device recovery, prekey refill, recoverable attempt limit, profile, settings, session, logout');
await auth.close();
await new Promise((resolve) => server.close(resolve));
