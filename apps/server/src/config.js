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
  };
}
