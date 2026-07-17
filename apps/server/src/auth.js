import { createHash, createHmac, randomBytes, randomInt, randomUUID, timingSafeEqual } from 'node:crypto';
import nodemailer from 'nodemailer';
import pg from 'pg';
import QRCode from 'qrcode';

const { Pool } = pg;
const COOKIE = 'segment_session';
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const USERNAME_RE = /^[a-z0-9_]{3,24}$/;
const COLORS = ['#7c5cff', '#00a9d4', '#e25c82', '#36a96b', '#e19a3b', '#db5b5b', '#478fd8', '#8b62dc'];
const PRIVACY_SCOPES = new Set(['everyone', 'members', 'nobody']);
const DENSITIES = new Set(['compact', 'comfortable', 'spacious']);
const LANGUAGES = new Set(['ru']);
const THEME_IDS = new Set(['night', 'midnight', 'graphite', 'custom']);
const MOD_FEATURES = new Set(['compact-bubbles', 'square-media', 'hide-reactions']);
const PROFILE_BADGES = new Set(['early', 'creator', 'mods', 'supporter']);
const THEME_TOKEN_KEYS = new Set(['bg', 'surface', 'surface2', 'surface3', 'border', 'stroke', 'text', 'muted', 'accent', 'mineBg', 'incomingBg', 'feedBg', 'danger', 'ok', 'radius']);

const json = (res, status, value, headers = {}) => {
  const body = JSON.stringify(value);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body), 'Cache-Control': 'no-store', ...headers });
  res.end(body);
  return true;
};
const readJson = (req, limit = 1024 * 1024) => new Promise((resolve, reject) => {
  const chunks = []; let size = 0;
  req.on('data', (chunk) => {
    size += chunk.length;
    if (size > limit) { reject(Object.assign(new Error('PAYLOAD_TOO_LARGE'), { status: 413 })); req.destroy(); return; }
    chunks.push(chunk);
  });
  req.on('end', () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')); } catch { reject(Object.assign(new Error('INVALID_JSON'), { status: 400 })); } });
  req.on('error', reject);
});
const parseCookies = (req) => Object.fromEntries((req.headers.cookie || '').split(';').map((part) => {
  const at = part.indexOf('='); return at < 0 ? ['', ''] : [part.slice(0, at).trim(), decodeURIComponent(part.slice(at + 1))];
}).filter(([key]) => key));
const publicUser = (user) => user ? ({
  id: user.id, email: user.email, username: user.username, name: user.name,
  avatar: user.avatar || '', color: user.color, bio: user.bio || '', status: user.status || '',
  links: Array.isArray(user.profile_links) ? user.profile_links : [],
  profile: user.profile_meta && typeof user.profile_meta === 'object' ? user.profile_meta : {},
  privacy: user.privacy && typeof user.privacy === 'object' ? user.privacy : {},
  settings: user.settings && typeof user.settings === 'object' ? user.settings : {},
}) : null;

const normalizeLinks = (value, fallback = []) => {
  if (value === undefined) return fallback;
  if (!Array.isArray(value) || value.length > 3) throw Object.assign(new Error('LINKS_INVALID'), { status: 400 });
  return value.map((item) => {
    const label = String(item?.label || '').trim().slice(0, 30);
    const url = String(item?.url || '').trim();
    let parsed;
    try { parsed = new URL(url); } catch { throw Object.assign(new Error('LINKS_INVALID'), { status: 400 }); }
    if (parsed.protocol !== 'https:' || url.length > 240) throw Object.assign(new Error('LINKS_INVALID'), { status: 400 });
    return { label: label || parsed.hostname.replace(/^www\./, ''), url };
  });
};
const normalizePrivacy = (value, fallback = {}) => {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : fallback;
  return Object.fromEntries(['avatar', 'bio', 'status', 'links'].map((key) => [key, PRIVACY_SCOPES.has(source[key]) ? source[key] : (fallback[key] || 'everyone')]));
};
const normalizeTheme = (value) => {
  if (!value || typeof value !== 'object' || value.schema !== 1 || !value.tokens || typeof value.tokens !== 'object') throw Object.assign(new Error('THEME_INVALID'), { status: 400 });
  const tokens = {};
  for (const [key, raw] of Object.entries(value.tokens)) {
    if (!THEME_TOKEN_KEYS.has(key)) continue;
    const token = String(raw || '').trim();
    if ((key === 'radius' ? /^\d{1,2}px$/.test(token) : /^#[0-9a-f]{6}$/i.test(token))) tokens[key] = token;
  }
  if (!tokens.bg || !tokens.surface || !tokens.text || !tokens.accent) throw Object.assign(new Error('THEME_INVALID'), { status: 400 });
  return { schema: 1, id: String(value.id || 'custom').toLowerCase().replace(/[^a-z0-9-]/g, '').slice(0, 40) || 'custom', name: String(value.name || 'Custom theme').trim().slice(0, 60) || 'Custom theme', author: String(value.author || '').trim().slice(0, 60), tokens };
};
const normalizeSettings = (value, fallback = {}) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw Object.assign(new Error('SETTINGS_INVALID'), { status: 400 });
  const source = { ...fallback, ...value };
  const next = {};
  if (source.density !== undefined && DENSITIES.has(source.density)) next.density = source.density;
  if (source.scale !== undefined) next.scale = Math.min(1.2, Math.max(0.85, Number(source.scale) || 1));
  for (const key of ['reduceMotion', 'showChannelAvatars', 'mediaPreview', 'sendByEnter', 'highContrast']) {
    if (source[key] !== undefined) next[key] = source[key] === true;
  }
  if (source.language !== undefined && LANGUAGES.has(source.language)) next.language = source.language;
  if (source.themeId !== undefined && THEME_IDS.has(source.themeId)) next.themeId = source.themeId;
  if (source.customTheme !== undefined) {
    if (!source.customTheme || typeof source.customTheme !== 'object' || JSON.stringify(source.customTheme).length > 4096) throw Object.assign(new Error('THEME_INVALID'), { status: 400 });
    next.customTheme = normalizeTheme(source.customTheme);
  }
  if (source.installedMods !== undefined) {
    if (!Array.isArray(source.installedMods) || source.installedMods.length > 20) throw Object.assign(new Error('MODS_INVALID'), { status: 400 });
    next.installedMods = source.installedMods.map((mod) => ({
      id: String(mod?.id || '').toLowerCase().replace(/[^a-z0-9-]/g, '').slice(0, 40),
      name: String(mod?.name || '').trim().slice(0, 60), version: String(mod?.version || '1.0.0').slice(0, 20),
      enabled: mod?.enabled === true,
      features: [...new Set(Array.isArray(mod?.features) ? mod.features.filter((feature) => MOD_FEATURES.has(feature)) : [])],
    })).filter((mod) => mod.id && mod.name && mod.features.length);
  }
  if (JSON.stringify(next).length > 16384) throw Object.assign(new Error('SETTINGS_INVALID'), { status: 400 });
  return next;
};

export async function createAuth(config) {
  if (config.production && (!config.authSecret || config.authSecret.includes('replace-with'))) throw new Error('AUTH_SECRET must be set in production');
  const secret = config.authSecret || randomBytes(32).toString('hex');
  const pool = new Pool({
    connectionString: config.databaseUrl,
    max: config.databasePoolMax,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: config.databaseConnectionTimeoutMs,
    maxUses: 7500,
  });
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id UUID PRIMARY KEY, email TEXT NOT NULL UNIQUE, username VARCHAR(24) NOT NULL UNIQUE,
      name VARCHAR(40) NOT NULL, avatar TEXT NOT NULL DEFAULT '', color VARCHAR(16) NOT NULL,
      bio VARCHAR(160) NOT NULL DEFAULT '', status VARCHAR(80) NOT NULL DEFAULT '',
      profile_links JSONB NOT NULL DEFAULT '[]'::jsonb,
      profile_meta JSONB NOT NULL DEFAULT '{}'::jsonb,
      privacy JSONB NOT NULL DEFAULT '{"avatar":"everyone","bio":"everyone","status":"everyone","links":"everyone"}'::jsonb,
      settings JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    ALTER TABLE users ADD COLUMN IF NOT EXISTS bio VARCHAR(160) NOT NULL DEFAULT '';
    ALTER TABLE users ADD COLUMN IF NOT EXISTS status VARCHAR(80) NOT NULL DEFAULT '';
    ALTER TABLE users ADD COLUMN IF NOT EXISTS profile_links JSONB NOT NULL DEFAULT '[]'::jsonb;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS profile_meta JSONB NOT NULL DEFAULT '{}'::jsonb;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS privacy JSONB NOT NULL DEFAULT '{"avatar":"everyone","bio":"everyone","status":"everyone","links":"everyone"}'::jsonb;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS settings JSONB NOT NULL DEFAULT '{}'::jsonb;
    CREATE TABLE IF NOT EXISTS login_codes (
      email TEXT PRIMARY KEY, code_hash TEXT NOT NULL, expires_at TIMESTAMPTZ NOT NULL,
      attempts SMALLINT NOT NULL DEFAULT 0, requested_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS registration_tokens (
      token_hash TEXT PRIMARY KEY, email TEXT NOT NULL, expires_at TIMESTAMPTZ NOT NULL
    );
    CREATE TABLE IF NOT EXISTS sessions (
      token_hash TEXT PRIMARY KEY, user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      expires_at TIMESTAMPTZ NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      id UUID NOT NULL DEFAULT gen_random_uuid(), user_agent TEXT NOT NULL DEFAULT '',
      ip TEXT NOT NULL DEFAULT '', last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    ALTER TABLE sessions ADD COLUMN IF NOT EXISTS id UUID NOT NULL DEFAULT gen_random_uuid();
    ALTER TABLE sessions ADD COLUMN IF NOT EXISTS user_agent TEXT NOT NULL DEFAULT '';
    ALTER TABLE sessions ADD COLUMN IF NOT EXISTS ip TEXT NOT NULL DEFAULT '';
    ALTER TABLE sessions ADD COLUMN IF NOT EXISTS last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW();
    CREATE UNIQUE INDEX IF NOT EXISTS sessions_id_idx ON sessions(id);
    CREATE INDEX IF NOT EXISTS sessions_user_id_idx ON sessions(user_id);
    CREATE INDEX IF NOT EXISTS sessions_expires_at_idx ON sessions(expires_at);
    CREATE INDEX IF NOT EXISTS login_codes_expires_at_idx ON login_codes(expires_at);
    CREATE INDEX IF NOT EXISTS registration_tokens_expires_at_idx ON registration_tokens(expires_at);
    CREATE TABLE IF NOT EXISTS device_links (
      token_hash TEXT PRIMARY KEY, user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      payload TEXT NOT NULL, expires_at TIMESTAMPTZ NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS device_links_expires_at_idx ON device_links(expires_at);
  `);

  const smtpReady = Boolean(config.smtp.test || (config.smtp.host && config.smtp.user && config.smtp.pass));
  const codeRequests = new Map();
  const mailer = config.smtp.test ? nodemailer.createTransport({ jsonTransport: true }) : (smtpReady ? nodemailer.createTransport({
    host: config.smtp.host, port: config.smtp.port, secure: config.smtp.secure, requireTLS: !config.smtp.secure,
    auth: { user: config.smtp.user, pass: config.smtp.pass }, disableFileAccess: true, disableUrlAccess: true,
  }) : null);
  const hash = (value) => createHash('sha256').update(value).digest('hex');
  const sign = (value) => createHmac('sha256', secret).update(value).digest('hex');
  const equal = (a, b) => { const x = Buffer.from(a || '', 'hex'); const y = Buffer.from(b || '', 'hex'); return x.length === y.length && timingSafeEqual(x, y); };
  const cookie = (token, maxAge) => `${COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${config.production ? '; Secure' : ''}`;
  const cleanup = async () => {
    await pool.query(`
      DELETE FROM login_codes WHERE expires_at < NOW();
      DELETE FROM registration_tokens WHERE expires_at < NOW();
      DELETE FROM sessions WHERE expires_at < NOW();
      DELETE FROM device_links WHERE expires_at < NOW();
    `);
    const cutoff = Date.now() - 10 * 60 * 1000;
    for (const [ip, requests] of codeRequests) {
      const recent = requests.filter((time) => time >= cutoff);
      if (recent.length) codeRequests.set(ip, recent); else codeRequests.delete(ip);
    }
  };
  await cleanup();
  const cleanupTimer = setInterval(() => cleanup().catch((error) => {
    console.error(JSON.stringify({ level: 'error', event: 'auth.cleanup_failed', message: error.message }));
  }), 15 * 60 * 1000);
  cleanupTimer.unref();
  const one = async (sql, params = []) => (await pool.query(sql, params)).rows[0] || null;
  const requestIp = (req) => {
    const forwarded = config.trustProxy ? req.headers['x-forwarded-for'] : '';
    return ((typeof forwarded === 'string' ? forwarded.split(',')[0].trim() : '') || req.socket.remoteAddress || '').slice(0, 80);
  };
  const sessionFromRequest = async (req) => {
    const token = parseCookies(req)[COOKIE]; if (!token) return null;
    return one(`SELECT users.*, sessions.id AS session_id, sessions.created_at AS session_created_at,
      sessions.last_seen_at AS session_last_seen_at FROM sessions JOIN users ON users.id=sessions.user_id
      WHERE sessions.token_hash=$1 AND sessions.expires_at>NOW()`, [hash(token)]);
  };
  const userFromRequest = sessionFromRequest;
  const createSession = async (userId, req) => {
    const token = randomBytes(32).toString('base64url');
    await pool.query(`INSERT INTO sessions(token_hash,user_id,expires_at,user_agent,ip)
      VALUES($1,$2,NOW()+($3::text)::interval,$4,$5)`, [hash(token), userId, `${config.authSessionTtlMs} milliseconds`, String(req?.headers?.['user-agent'] || '').slice(0, 320), req ? requestIp(req) : '']);
    return token;
  };
  const validateAvatar = (avatar) => {
    if (!avatar) return '';
    if (typeof avatar !== 'string' || !/^data:image\/(png|jpeg|webp);base64,/i.test(avatar)) throw Object.assign(new Error('AVATAR_INVALID'), { status: 400 });
    if (Buffer.byteLength(avatar.slice(avatar.indexOf(',') + 1), 'base64') > config.authMaxAvatarBytes) throw Object.assign(new Error('AVATAR_TOO_LARGE'), { status: 413 });
    return avatar;
  };

  const handle = async (req, res) => {
    const url = new URL(req.url, 'http://segment.local');
    if (!url.pathname.startsWith('/api/auth/')) return false;
    try {
      if (['POST', 'PATCH', 'DELETE'].includes(req.method) && config.production) {
        const origin = req.headers.origin;
        const allowed = new Set(config.allowedOrigins);
        if (config.publicUrl) { try { allowed.add(new URL(config.publicUrl).origin); } catch {} }
        if (!origin || !allowed.has(origin)) return json(res, 403, { error: 'ORIGIN_FORBIDDEN' });
      }
      if (req.method === 'GET' && url.pathname.startsWith('/api/auth/avatar/')) {
        if (!await userFromRequest(req)) return json(res, 401, { error: 'UNAUTHORIZED' });
        const id = url.pathname.slice('/api/auth/avatar/'.length);
        if (!/^[0-9a-f-]{36}$/i.test(id)) return json(res, 404, { error: 'NOT_FOUND' });
        const row = await one('SELECT avatar FROM users WHERE id=$1', [id]);
        if (!row?.avatar) { res.writeHead(404, { 'Cache-Control': 'private, max-age=60' }); res.end(); return true; }
        const match = row.avatar.match(/^data:(image\/(?:png|jpeg|webp));base64,(.+)$/i);
        if (!match) { res.writeHead(404); res.end(); return true; }
        const body = Buffer.from(match[2], 'base64');
        res.writeHead(200, { 'Content-Type': match[1], 'Content-Length': body.length, 'Cache-Control': 'private, max-age=3600', 'X-Content-Type-Options': 'nosniff' });
        res.end(body); return true;
      }
      if (req.method === 'GET' && url.pathname === '/api/auth/profile-qr') {
        if (!await userFromRequest(req)) return json(res, 401, { error: 'UNAUTHORIZED' });
        const username = String(url.searchParams.get('username') || '').toLowerCase();
        if (!USERNAME_RE.test(username) || !await one('SELECT 1 FROM users WHERE username=$1', [username])) return json(res, 404, { error: 'NOT_FOUND' });
        const dark = String(url.searchParams.get('dark') || '#0b1320');
        if (!/^#[0-9a-f]{6}$/i.test(dark)) return json(res, 400, { error: 'COLOR_INVALID' });
        const transparent = url.searchParams.get('transparent') === '1';
        const base = String(config.publicUrl || 'http://localhost:3000').replace(/\/$/, '');
        const svg = await QRCode.toString(`${base}/@${username}`, {
          type: 'svg', width: 720, margin: 2, errorCorrectionLevel: 'H',
          color: { dark, light: transparent ? '#00000000' : '#ffffff' },
        });
        res.writeHead(200, { 'Content-Type': 'image/svg+xml; charset=utf-8', 'Content-Length': Buffer.byteLength(svg), 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
        res.end(svg); return true;
      }
      if (req.method === 'GET' && url.pathname === '/api/auth/me') {
        const user = await userFromRequest(req);
        return json(res, user ? 200 : 401, user ? { user: publicUser(user) } : { error: 'UNAUTHORIZED' });
      }
      if (req.method === 'GET' && url.pathname === '/api/auth/sessions') {
        const current = await sessionFromRequest(req);
        if (!current) return json(res, 401, { error: 'UNAUTHORIZED' });
        await pool.query('UPDATE sessions SET last_seen_at=NOW() WHERE id=$1', [current.session_id]);
        const sessions = (await pool.query(`SELECT id,user_agent,ip,created_at,last_seen_at,expires_at
          FROM sessions WHERE user_id=$1 AND expires_at>NOW() ORDER BY last_seen_at DESC`, [current.id])).rows;
        return json(res, 200, { sessions: sessions.map((session) => ({ ...session, current: session.id === current.session_id })) });
      }
      if (req.method === 'DELETE' && url.pathname.startsWith('/api/auth/sessions/')) {
        const current = await sessionFromRequest(req);
        if (!current) return json(res, 401, { error: 'UNAUTHORIZED' });
        const sessionId = url.pathname.slice('/api/auth/sessions/'.length);
        if (!/^[0-9a-f-]{36}$/i.test(sessionId)) return json(res, 404, { error: 'NOT_FOUND' });
        const removed = await pool.query('DELETE FROM sessions WHERE id=$1 AND user_id=$2 RETURNING id', [sessionId, current.id]);
        if (!removed.rowCount) return json(res, 404, { error: 'NOT_FOUND' });
        const headers = sessionId === current.session_id ? { 'Set-Cookie': cookie('', 0) } : {};
        return json(res, 200, { ok: true, current: sessionId === current.session_id }, headers);
      }
      if (req.method === 'POST' && url.pathname === '/api/auth/device-links') {
        const current = await sessionFromRequest(req);
        if (!current) return json(res, 401, { error: 'UNAUTHORIZED' });
        const body = await readJson(req, 1024 * 1024);
        const payload = String(body.payload || '');
        if (!payload || payload.length > 900000) return json(res, 400, { error: 'PAYLOAD_INVALID' });
        const token = randomBytes(24).toString('base64url');
        await pool.query("INSERT INTO device_links(token_hash,user_id,payload,expires_at) VALUES($1,$2,$3,NOW()+INTERVAL '10 minutes')", [hash(token), current.id, payload]);
        return json(res, 201, { token, expiresIn: 600 });
      }
      if (req.method === 'POST' && url.pathname === '/api/auth/device-links/claim') {
        const current = await sessionFromRequest(req);
        if (!current) return json(res, 401, { error: 'UNAUTHORIZED' });
        const body = await readJson(req, 16384); const tokenHash = hash(String(body.token || ''));
        const link = await one('DELETE FROM device_links WHERE token_hash=$1 AND user_id=$2 AND expires_at>NOW() RETURNING payload', [tokenHash, current.id]);
        if (!link) return json(res, 400, { error: 'DEVICE_LINK_INVALID' });
        return json(res, 200, { payload: link.payload });
      }
      if (req.method === 'POST' && url.pathname === '/api/auth/request-code') {
        const { email: rawEmail } = await readJson(req, 16384); const email = String(rawEmail || '').trim().toLowerCase();
        if (!EMAIL_RE.test(email) || email.length > 254) return json(res, 400, { error: 'EMAIL_INVALID' });
        const forwarded = config.trustProxy ? req.headers['x-forwarded-for'] : '';
        const ip = (typeof forwarded === 'string' ? forwarded.split(',')[0].trim() : '') || req.socket.remoteAddress || 'unknown';
        const recent = (codeRequests.get(ip) || []).filter((time) => Date.now() - time < 10 * 60 * 1000);
        if (recent.length >= 10) return json(res, 429, { error: 'TOO_MANY_REQUESTS' });
        recent.push(Date.now()); codeRequests.set(ip, recent);
        const previous = await one('SELECT requested_at FROM login_codes WHERE email=$1', [email]);
        if (previous && Date.now() - new Date(previous.requested_at).getTime() < 60000) return json(res, 429, { error: 'TOO_MANY_REQUESTS' });
        if (!mailer) return json(res, 503, { error: 'EMAIL_NOT_CONFIGURED' });
        const code = String(randomInt(100000, 1000000));
        await pool.query(`INSERT INTO login_codes(email,code_hash,expires_at,attempts,requested_at)
          VALUES($1,$2,NOW()+($3::text)::interval,0,NOW()) ON CONFLICT(email) DO UPDATE SET
          code_hash=EXCLUDED.code_hash,expires_at=EXCLUDED.expires_at,attempts=0,requested_at=NOW()`, [email, sign(`${email}:${code}`), `${config.authCodeTtlMs} milliseconds`]);
        try {
          const minutes = Math.max(1, Math.round(config.authCodeTtlMs / 60000));
          const logoUrl = `${(config.publicUrl || 'https://web.segmnt.org').replace(/\/+$/, '')}/logo.png?rev=20260716`;
          const spaced = code.split('').join(' ');
          await mailer.sendMail({ from: config.smtp.from, to: email, subject: `${code} — код входа в Segment`,
            text: `Ваш код входа в Segment:\n\n${code}\n\nКод действует ${minutes} минут и может быть использован только один раз.\nНикому не сообщайте этот код: мы никогда не спросим его по телефону или в письме.\n\nВы получили это письмо, потому что для вашего аккаунта Segment запросили код входа. Если это были не вы, просто проигнорируйте письмо.`,
            html: `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f6f8fa;padding:24px 0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;color:#1f2328">
  <tr><td align="center">
    <table role="presentation" width="516" cellpadding="0" cellspacing="0" style="width:516px;max-width:100%">
      <tr><td align="center" style="padding-bottom:16px">
        <img src="${logoUrl}" width="48" height="48" alt="Segment" style="border-radius:12px;display:block">
      </td></tr>
      <tr><td align="center" style="font-size:22px;font-weight:600;padding-bottom:20px">Вход в Segment</td></tr>
      <tr><td style="background:#ffffff;border:1px solid #d1d9e0;border-radius:12px;padding:24px 28px;font-size:15px;line-height:1.6">
        <p style="margin:0 0 8px">Ваш код входа в Segment:</p>
        <p style="margin:0 0 20px;text-align:center;font-size:30px;font-weight:600;letter-spacing:8px">${spaced}</p>
        <p style="margin:0 0 16px">Код действует <b>${minutes} минут</b> и может быть использован только один раз.</p>
        <p style="margin:0"><b>Никому не сообщайте этот код:</b> мы никогда не спросим его по телефону или в письме.</p>
        <p style="margin:16px 0 0">Спасибо,<br>Команда Segment</p>
      </td></tr>
      <tr><td style="padding:16px 4px 0;font-size:12px;line-height:1.5;color:#59636e">
        Вы получили это письмо, потому что для вашего аккаунта Segment запросили код входа. Если это были не вы, просто проигнорируйте письмо.
      </td></tr>
    </table>
  </td></tr>
</table>` });
        } catch (error) {
          await pool.query('DELETE FROM login_codes WHERE email=$1', [email]);
          console.error(JSON.stringify({ level: 'error', event: 'auth.email_failed', message: error.message }));
          return json(res, 502, { error: 'EMAIL_SEND_FAILED' });
        }
        return json(res, 200, { ok: true, ...(!config.production && config.smtp.test ? { devCode: code } : {}) });
      }
      if (req.method === 'POST' && url.pathname === '/api/auth/verify-code') {
        const body = await readJson(req, 16384); const email = String(body.email || '').trim().toLowerCase(); const code = String(body.code || '').trim();
        const row = await one('SELECT * FROM login_codes WHERE email=$1', [email]);
        if (!row || new Date(row.expires_at).getTime() < Date.now() || row.attempts >= 5 || !equal(row.code_hash, sign(`${email}:${code}`))) {
          if (row) await pool.query('UPDATE login_codes SET attempts=attempts+1 WHERE email=$1', [email]);
          return json(res, 400, { error: 'CODE_INVALID' });
        }
        await pool.query('DELETE FROM login_codes WHERE email=$1', [email]);
        const user = await one('SELECT * FROM users WHERE email=$1', [email]);
        if (user) {
          const token = await createSession(user.id, req);
          return json(res, 200, { user: publicUser(user) }, { 'Set-Cookie': cookie(token, Math.floor(config.authSessionTtlMs / 1000)) });
        }
        const registrationToken = randomBytes(32).toString('base64url');
        await pool.query('INSERT INTO registration_tokens(token_hash,email,expires_at) VALUES($1,$2,NOW()+INTERVAL \'15 minutes\')', [hash(registrationToken), email]);
        return json(res, 200, { registrationToken, needsProfile: true });
      }
      if (req.method === 'POST' && url.pathname === '/api/auth/register') {
        const body = await readJson(req, config.authMaxAvatarBytes * 2); const tokenHash = hash(String(body.registrationToken || ''));
        const ticket = await one('SELECT * FROM registration_tokens WHERE token_hash=$1 AND expires_at>NOW()', [tokenHash]);
        if (!ticket) return json(res, 400, { error: 'REGISTRATION_EXPIRED' });
        const username = String(body.username || '').trim().toLowerCase(); const name = String(body.name || '').trim().slice(0, 40);
        if (!USERNAME_RE.test(username)) return json(res, 400, { error: 'USERNAME_INVALID' });
        if (!name) return json(res, 400, { error: 'NAME_INVALID' });
        if (await one('SELECT 1 FROM users WHERE username=$1', [username])) return json(res, 409, { error: 'USERNAME_TAKEN' });
        const avatar = validateAvatar(body.avatar); const id = randomUUID(); const color = COLORS[randomInt(COLORS.length)];
        const user = await one(`INSERT INTO users(id,email,username,name,avatar,color) VALUES($1,$2,$3,$4,$5,$6) RETURNING *`, [id, ticket.email, username, name, avatar, color]);
        await pool.query('DELETE FROM registration_tokens WHERE token_hash=$1', [tokenHash]);
        const session = await createSession(id, req);
        return json(res, 201, { user: publicUser(user) }, { 'Set-Cookie': cookie(session, Math.floor(config.authSessionTtlMs / 1000)) });
      }
      if (req.method === 'PATCH' && url.pathname === '/api/auth/profile') {
        const current = await userFromRequest(req);
        if (!current) return json(res, 401, { error: 'UNAUTHORIZED' });
        // A profile update may carry both an avatar and a cover as base64 data.
        const body = await readJson(req, config.authMaxAvatarBytes * 4);
        const username = String(body.username ?? current.username).trim().toLowerCase();
        const name = String(body.name ?? current.name).trim().slice(0, 40);
        const avatar = body.avatar === undefined ? current.avatar : validateAvatar(body.avatar);
        const color = COLORS.includes(body.color) ? body.color : current.color;
        const bio = String(body.bio ?? current.bio ?? '').trim().slice(0, 160);
        const status = String(body.status ?? current.status ?? '').trim().slice(0, 80);
        const links = normalizeLinks(body.links, current.profile_links || []);
        const privacy = body.privacy === undefined ? normalizePrivacy(current.privacy) : normalizePrivacy(body.privacy, current.privacy);
        const previousProfile = current.profile_meta && typeof current.profile_meta === 'object' ? current.profile_meta : {};
        let profileMeta = previousProfile;
        if (body.profile !== undefined) {
          if (!body.profile || typeof body.profile !== 'object' || Array.isArray(body.profile)) return json(res, 400, { error: 'PROFILE_INVALID' });
          const cover = body.profile.cover === undefined ? (previousProfile.cover || '') : validateAvatar(body.profile.cover);
          const pinnedBadges = body.profile.pinnedBadges === undefined
            ? (Array.isArray(previousProfile.pinnedBadges) ? previousProfile.pinnedBadges : [])
            : [...new Set(Array.isArray(body.profile.pinnedBadges) ? body.profile.pinnedBadges.filter((badge) => PROFILE_BADGES.has(badge)) : [])].slice(0, 3);
          let pinnedCommunity = previousProfile.pinnedCommunity || null;
          if (body.profile.pinnedCommunityId !== undefined) {
            const roomId = String(body.profile.pinnedCommunityId || '').slice(0, 80);
            pinnedCommunity = null;
            if (roomId) {
              const room = await one(`SELECT r.id,r.title,r.icon,r.type FROM rooms r
                LEFT JOIN room_members m ON m.room_id=r.id AND m.user_id=$2
                WHERE r.id=$1 AND (r.is_public=TRUE OR m.user_id=$2)`, [roomId, current.id]);
              if (!room) return json(res, 400, { error: 'COMMUNITY_INVALID' });
              pinnedCommunity = { id: room.id, name: room.title, icon: room.icon || '💬', type: room.type };
            }
          }
          profileMeta = {
            cover, pinnedBadges, pinnedCommunity,
            music: previousProfile.music || null,
            game: previousProfile.game || null,
            publications: Array.isArray(previousProfile.publications) ? previousProfile.publications.slice(0, 100) : [],
            publicationArchive: Array.isArray(previousProfile.publicationArchive) ? previousProfile.publicationArchive.slice(0, 100) : [],
          };
        }
        if (!USERNAME_RE.test(username)) return json(res, 400, { error: 'USERNAME_INVALID' });
        if (!name) return json(res, 400, { error: 'NAME_INVALID' });
        const user = await one(`UPDATE users SET username=$1,name=$2,avatar=$3,color=$4,bio=$5,status=$6,profile_links=$7::jsonb,privacy=$8::jsonb,profile_meta=$9::jsonb,updated_at=NOW()
          WHERE id=$10 RETURNING *`, [username, name, avatar, color, bio, status, JSON.stringify(links), JSON.stringify(privacy), JSON.stringify(profileMeta), current.id]);
        return json(res, 200, { user: publicUser(user) });
      }
      if (req.method === 'PATCH' && url.pathname === '/api/auth/settings') {
        const current = await userFromRequest(req);
        if (!current) return json(res, 401, { error: 'UNAUTHORIZED' });
        const body = await readJson(req, 32768);
        const settings = normalizeSettings(body.settings, current.settings || {});
        const user = await one('UPDATE users SET settings=$1::jsonb,updated_at=NOW() WHERE id=$2 RETURNING *', [JSON.stringify(settings), current.id]);
        return json(res, 200, { settings: publicUser(user).settings });
      }
      if (req.method === 'POST' && url.pathname === '/api/auth/logout') {
        const token = parseCookies(req)[COOKIE]; if (token) await pool.query('DELETE FROM sessions WHERE token_hash=$1', [hash(token)]);
        return json(res, 200, { ok: true }, { 'Set-Cookie': cookie('', 0) });
      }
      return json(res, 404, { error: 'NOT_FOUND' });
    } catch (error) {
      console.error(JSON.stringify({ level: 'error', event: 'auth.request_failed', message: error.message }));
      return json(res, error.status || 500, { error: error.code === '23505' ? 'USERNAME_TAKEN' : (error.message || 'INTERNAL_ERROR') });
    }
  };
  const ready = async () => { await pool.query('SELECT 1'); return true; };
  const close = async () => { clearInterval(cleanupTimer); await pool.end(); };
  return { handle, userFromRequest, publicUser, pool, ready, close, smtpReady };
}
