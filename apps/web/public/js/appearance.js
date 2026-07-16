export const THEME_SCHEMA = 1;

export const THEME_TOKEN_MAP = {
  bg: '--bg', surface: '--surface', surface2: '--surface2', surface3: '--surface3',
  border: '--border', stroke: '--stroke', text: '--text', muted: '--muted',
  accent: '--accent', mineBg: '--mine-bg', incomingBg: '--incoming-bg', feedBg: '--feed-bg',
  danger: '--danger', ok: '--ok', radius: '--radius-md',
};

export const THEME_PRESETS = [
  { id: 'night', name: 'Ночная', description: 'Базовая тема Segment', tokens: {} },
  { id: 'midnight', name: 'Полночь', description: 'Глубокий синий фон', tokens: {
    bg: '#080d16', surface: '#101a29', surface2: '#162235', surface3: '#20304a', border: '#080f1b',
    stroke: '#2a3d59', text: '#edf4ff', muted: '#8090a6', accent: '#5aa7ec', mineBg: '#255886',
    incomingBg: '#15243a', feedBg: '#080d16', danger: '#ec6a6a', ok: '#57bc6c', radius: '12px',
  } },
  { id: 'graphite', name: 'Графит', description: 'Нейтральная тёмная палитра', tokens: {
    bg: '#111214', surface: '#1a1c1f', surface2: '#22252a', surface3: '#2c3036', border: '#0c0d0f',
    stroke: '#373c43', text: '#f0f1f2', muted: '#8c939c', accent: '#75a7d8', mineBg: '#355b7d',
    incomingBg: '#24282d', feedBg: '#111214', danger: '#e76f73', ok: '#62b978', radius: '10px',
  } },
];

const HEX = /^#[0-9a-f]{6}$/i;
const RADIUS = /^\d{1,2}px$/;

export function normalizeThemePack(value) {
  if (!value || typeof value !== 'object' || value.schema !== THEME_SCHEMA || !value.tokens || typeof value.tokens !== 'object') throw new Error('THEME_INVALID');
  const tokens = {};
  for (const [key, raw] of Object.entries(value.tokens)) {
    if (!(key in THEME_TOKEN_MAP)) continue;
    const token = String(raw || '').trim();
    if (key === 'radius' ? RADIUS.test(token) : HEX.test(token)) tokens[key] = token;
  }
  if (!tokens.accent || !tokens.bg || !tokens.surface || !tokens.text) throw new Error('THEME_INCOMPLETE');
  return {
    schema: THEME_SCHEMA,
    id: String(value.id || 'custom').toLowerCase().replace(/[^a-z0-9-]/g, '').slice(0, 40) || 'custom',
    name: String(value.name || 'Моя тема').trim().slice(0, 60) || 'Моя тема',
    author: String(value.author || '').trim().slice(0, 60),
    tokens,
  };
}

export function applyAppearancePrefs(prefs = {}) {
  const root = document.documentElement;
  for (const variable of Object.values(THEME_TOKEN_MAP)) root.style.removeProperty(variable);
  const selected = prefs.themeId === 'custom'
    ? (() => { try { return normalizeThemePack(prefs.customTheme); } catch { return null; } })()
    : THEME_PRESETS.find((theme) => theme.id === prefs.themeId);
  for (const [key, value] of Object.entries(selected?.tokens || {})) root.style.setProperty(THEME_TOKEN_MAP[key], value);
  root.classList.toggle('high-contrast', prefs.highContrast === true);
  const activeFeatures = new Set((prefs.installedMods || []).filter((mod) => mod.enabled).flatMap((mod) => mod.features || []));
  for (const feature of ['compact-bubbles', 'square-media', 'hide-reactions']) root.classList.toggle(`mod-${feature}`, activeFeatures.has(feature));
}
