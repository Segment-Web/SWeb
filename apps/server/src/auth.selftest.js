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
let cookie = '';
const call = async (path, body, method = 'POST') => {
  const response = await fetch(`${base}/api/auth/${path}`, {
    method, headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  if (response.headers.get('set-cookie')) cookie = response.headers.get('set-cookie').split(';')[0];
  return { status: response.status, data: await response.json() };
};
const email = `test-${Date.now()}@example.com`;
const requested = await call('request-code', { email });
if (requested.status !== 200 || !requested.data.devCode) throw new Error('request-code failed');
const verified = await call('verify-code', { email, code: requested.data.devCode });
if (!verified.data.needsProfile || !verified.data.registrationToken) throw new Error('verify-code failed');
const registered = await call('register', { registrationToken: verified.data.registrationToken, username: `user_${Date.now()}`.slice(-24), name: 'Auth Test', avatar: '' });
if (registered.status !== 201 || !registered.data.user?.id || !cookie) throw new Error('register failed');
const me = await call('me', undefined, 'GET');
if (me.status !== 200 || me.data.user.id !== registered.data.user.id) throw new Error('session failed');
const profile = await call('profile', {
  bio: 'Open-source messenger', status: 'Building Segment',
  links: [{ label: 'Website', url: 'https://segmnt.org' }],
  profile: { pinnedBadges: ['early', 'mods', 'invalid'] },
  privacy: { avatar: 'members', bio: 'everyone', status: 'nobody', links: 'members' },
}, 'PATCH');
if (profile.status !== 200 || profile.data.user.bio !== 'Open-source messenger' || profile.data.user.links.length !== 1 || profile.data.user.profile.pinnedBadges.includes('invalid')) throw new Error('profile update failed');
const settings = await call('settings', {
  settings: { themeId: 'graphite', density: 'compact', sendByEnter: false, installedMods: [{ id: 'compact', name: 'Compact', version: '1.0.0', enabled: true, features: ['compact-bubbles', 'run-script'] }] },
}, 'PATCH');
if (settings.status !== 200 || settings.data.settings.themeId !== 'graphite' || settings.data.settings.installedMods[0].features.includes('run-script')) throw new Error('settings update failed');
const updatedMe = await call('me', undefined, 'GET');
if (updatedMe.data.user.settings.themeId !== 'graphite' || updatedMe.data.user.privacy.status !== 'nobody') throw new Error('profile persistence failed');
const logout = await call('logout', {});
if (logout.status !== 200) throw new Error('logout failed');
console.log('auth ok: request, verify, register, profile, settings, session, logout');
await auth.close();
await new Promise((resolve) => server.close(resolve));
