const int = (name, fallback, min, max) => {
  const value = Number.parseInt(process.env[name] || '', 10);
  return Number.isFinite(value) ? Math.max(min, Math.min(max, value)) : fallback;
};

const list = (value = '') => value.split(',').map((x) => x.trim()).filter(Boolean);

export function loadConfig() {
  const production = process.env.NODE_ENV === 'production';
  return {
    production,
    host: process.env.HOST || '0.0.0.0',
    port: int('PORT', 3000, 1, 65535),
    publicUrl: process.env.PUBLIC_URL || '',
    allowedOrigins: list(process.env.ALLOWED_ORIGINS),
    trustProxy: process.env.TRUST_PROXY === '1',
    maxConnections: int('MAX_CONNECTIONS', 500, 2, 100000),
    maxConnectionsPerIp: int('MAX_CONNECTIONS_PER_IP', 20, 1, 1000),
    maxWsPayload: int('MAX_WS_PAYLOAD', 16 * 1024 * 1024, 64 * 1024, 64 * 1024 * 1024),
    messagesPerMinute: int('MESSAGES_PER_MINUTE', 240, 10, 10000),
    heartbeatMs: int('WS_HEARTBEAT_MS', 30000, 5000, 120000),
    shutdownMs: int('SHUTDOWN_TIMEOUT_MS', 10000, 1000, 60000),
    databaseUrl: process.env.DATABASE_URL || 'postgresql://segment:segment@localhost:5432/segment',
    authSecret: process.env.AUTH_SECRET || '',
    authCodeTtlMs: int('AUTH_CODE_TTL_MS', 10 * 60 * 1000, 60000, 60 * 60 * 1000),
    authSessionTtlMs: int('AUTH_SESSION_TTL_MS', 30 * 24 * 60 * 60 * 1000, 60 * 60 * 1000, 365 * 24 * 60 * 60 * 1000),
    authMaxAvatarBytes: int('AUTH_MAX_AVATAR_BYTES', 512 * 1024, 32 * 1024, 2 * 1024 * 1024),
    roomInviteTtlMs: int('ROOM_INVITE_TTL_MS', 7 * 24 * 60 * 60 * 1000, 60 * 1000, 90 * 24 * 60 * 60 * 1000),
    fileDir: process.env.FILE_DIR || './data/files',
    fileMaxBytes: int('FILE_MAX_BYTES', 100 * 1024 * 1024, 64 * 1024, 500 * 1024 * 1024),
    fileTtlMs: int('FILE_TTL_MS', 90 * 24 * 60 * 60 * 1000, 0, 365 * 24 * 60 * 60 * 1000),
    smtp: {
      host: process.env.SMTP_HOST || '',
      port: int('SMTP_PORT', 587, 1, 65535),
      secure: process.env.SMTP_SECURE === '1',
      user: process.env.SMTP_USER || '',
      pass: process.env.SMTP_PASS || '',
      from: process.env.SMTP_FROM || 'Segment <noreply@segmnt.org>',
    },
  };
}
