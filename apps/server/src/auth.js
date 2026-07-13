import { createHash, createHmac, randomBytes, randomInt, randomUUID, timingSafeEqual } from 'node:crypto';
import nodemailer from 'nodemailer';
import pg from 'pg';

const { Pool } = pg;
const COOKIE = 'segment_session';
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const USERNAME_RE = /^[a-z0-9_]{3,24}$/;
const COLORS = ['#7c5cff', '#00a9d4', '#e25c82', '#36a96b', '#e19a3b', '#db5b5b', '#478fd8', '#8b62dc'];

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
const publicUser = (user) => user ? ({ id: user.id, email: user.email, username: user.username, name: user.name, avatar: user.avatar || '', color: user.color }) : null;

export async function createAuth(config) {
  if (config.production && (!config.authSecret || config.authSecret.includes('replace-with'))) throw new Error('AUTH_SECRET must be set in production');
  const secret = config.authSecret || randomBytes(32).toString('hex');
  const pool = new Pool({ connectionString: config.databaseUrl, max: 10, idleTimeoutMillis: 30000 });
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id UUID PRIMARY KEY, email TEXT NOT NULL UNIQUE, username VARCHAR(24) NOT NULL UNIQUE,
      name VARCHAR(40) NOT NULL, avatar TEXT NOT NULL DEFAULT '', color VARCHAR(16) NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS login_codes (
      email TEXT PRIMARY KEY, code_hash TEXT NOT NULL, expires_at TIMESTAMPTZ NOT NULL,
      attempts SMALLINT NOT NULL DEFAULT 0, requested_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS registration_tokens (
      token_hash TEXT PRIMARY KEY, email TEXT NOT NULL, expires_at TIMESTAMPTZ NOT NULL
    );
    CREATE TABLE IF NOT EXISTS sessions (
      token_hash TEXT PRIMARY KEY, user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      expires_at TIMESTAMPTZ NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS sessions_user_id_idx ON sessions(user_id);
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
  const cleanup = async () => pool.query(`
    DELETE FROM login_codes WHERE expires_at < NOW();
    DELETE FROM registration_tokens WHERE expires_at < NOW();
    DELETE FROM sessions WHERE expires_at < NOW();
  `);
  const one = async (sql, params = []) => (await pool.query(sql, params)).rows[0] || null;
  const userFromRequest = async (req) => {
    const token = parseCookies(req)[COOKIE]; if (!token) return null;
    return one(`SELECT users.* FROM sessions JOIN users ON users.id=sessions.user_id
      WHERE sessions.token_hash=$1 AND sessions.expires_at>NOW()`, [hash(token)]);
  };
  const createSession = async (userId) => {
    const token = randomBytes(32).toString('base64url');
    await pool.query('INSERT INTO sessions(token_hash,user_id,expires_at) VALUES($1,$2,NOW()+($3::text)::interval)', [hash(token), userId, `${config.authSessionTtlMs} milliseconds`]);
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
      await cleanup();
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
      if (req.method === 'GET' && url.pathname === '/api/auth/me') {
        const user = await userFromRequest(req);
        return json(res, user ? 200 : 401, user ? { user: publicUser(user) } : { error: 'UNAUTHORIZED' });
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
          await mailer.sendMail({ from: config.smtp.from, to: email, subject: `${code} — код входа в Segment`,
            text: `Код входа в Segment: ${code}\n\nОн действует 10 минут. Если вы не запрашивали код, проигнорируйте письмо.`,
            html: `<div style="font-family:system-ui;max-width:520px"><h2>Вход в Segment</h2><p>Ваш одноразовый код:</p><p style="font-size:30px;font-weight:700;letter-spacing:6px">${code}</p><p>Код действует 10 минут. Никому его не сообщайте.</p></div>` });
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
          const token = await createSession(user.id);
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
        const session = await createSession(id);
        return json(res, 201, { user: publicUser(user) }, { 'Set-Cookie': cookie(session, Math.floor(config.authSessionTtlMs / 1000)) });
      }
      if (req.method === 'PATCH' && url.pathname === '/api/auth/profile') {
        const current = await userFromRequest(req);
        if (!current) return json(res, 401, { error: 'UNAUTHORIZED' });
        const body = await readJson(req, config.authMaxAvatarBytes * 2);
        const username = String(body.username ?? current.username).trim().toLowerCase();
        const name = String(body.name ?? current.name).trim().slice(0, 40);
        const avatar = body.avatar === undefined ? current.avatar : validateAvatar(body.avatar);
        const color = COLORS.includes(body.color) ? body.color : current.color;
        if (!USERNAME_RE.test(username)) return json(res, 400, { error: 'USERNAME_INVALID' });
        if (!name) return json(res, 400, { error: 'NAME_INVALID' });
        const user = await one(`UPDATE users SET username=$1,name=$2,avatar=$3,color=$4,updated_at=NOW()
          WHERE id=$5 RETURNING *`, [username, name, avatar, color, current.id]);
        return json(res, 200, { user: publicUser(user) });
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
  return { handle, userFromRequest, publicUser, close: () => pool.end(), smtpReady };
}
