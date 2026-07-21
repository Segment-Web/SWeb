
//




const KEYS = { name: 'segment_name', username: 'segment_username', avatar: 'segment_avatar', notes: 'segment_saved', pinned: 'segment_pinned', color: 'segment_color', muted: 'segment_muted', archived: 'segment_archived', folders: 'segment_folders', historyKeys: 'segment_history_keys', historyKeyArchive: 'segment_history_key_archive', historyKeyEpochs: 'segment_history_key_epochs', identityPins: 'segment_identity_pins', outbox: 'segment_outbox', drafts: 'segment_drafts', scheduled: 'segment_scheduled' };
const NOTES_LIMIT = 200;
const CRYPTO_DB = 'segment-crypto';
const CRYPTO_STORE = 'identities';

const cryptoDb = () => new Promise((resolve, reject) => {
  if (!globalThis.indexedDB) return reject(new Error('INDEXEDDB_UNAVAILABLE'));
  const request = indexedDB.open(CRYPTO_DB, 1);
  request.onupgradeneeded = () => request.result.createObjectStore(CRYPTO_STORE);
  request.onsuccess = () => resolve(request.result);
  request.onerror = () => reject(request.error);
});
const cryptoRecord = async (mode, accountId, value) => {
  const db = await cryptoDb();
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(CRYPTO_STORE, mode);
      const store = tx.objectStore(CRYPTO_STORE);
      const request = value === undefined ? store.get(accountId) : store.put(value, accountId);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  } finally { db.close(); }
};
const historyWrapKey = async (accountId) => {
  const id = `wrap:${accountId}`;
  let key = await cryptoRecord('readonly', id);
  if (!key) {
    key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
    await cryptoRecord('readwrite', id, key);
  }
  return key;
};
const secureHistorySet = async (accountId, state) => {
  const key = await historyWrapKey(accountId);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const plain = new TextEncoder().encode(JSON.stringify(state || {}));
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, plain);
  await cryptoRecord('readwrite', `history:${accountId}`, { iv: [...iv], ct: [...new Uint8Array(ct)] });
};
const secureHistoryGet = async (accountId) => {
  const record = await cryptoRecord('readonly', `history:${accountId}`);
  if (record?.iv && record?.ct) {
    const key = await historyWrapKey(accountId);
    const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: new Uint8Array(record.iv) }, key, new Uint8Array(record.ct));
    return JSON.parse(new TextDecoder().decode(plain));
  }
  const parsed = (key) => { try { return JSON.parse(localStorage.getItem(key) || '{}'); } catch { return {}; } };
  const legacy = { keys: parsed(KEYS.historyKeys), archive: parsed(KEYS.historyKeyArchive), epochs: parsed(KEYS.historyKeyEpochs) };
  await secureHistorySet(accountId, legacy);
  localStorage.removeItem(KEYS.historyKeys);
  localStorage.removeItem(KEYS.historyKeyArchive);
  localStorage.removeItem(KEYS.historyKeyEpochs);
  return legacy;
};
const securePinsSet = async (accountId, pins) => {
  const key = await historyWrapKey(accountId);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const plain = new TextEncoder().encode(JSON.stringify(pins || {}));
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, plain);
  await cryptoRecord('readwrite', `pins:${accountId}`, { iv: [...iv], ct: [...new Uint8Array(ct)] });
};
const securePinsGet = async (accountId) => {
  const record = await cryptoRecord('readonly', `pins:${accountId}`);
  if (record?.iv && record?.ct) {
    const key = await historyWrapKey(accountId);
    const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: new Uint8Array(record.iv) }, key, new Uint8Array(record.ct));
    return JSON.parse(new TextDecoder().decode(plain));
  }
  let legacy = {};
  try { legacy = JSON.parse(localStorage.getItem(KEYS.identityPins) || '{}'); } catch {}
  await securePinsSet(accountId, legacy);
  localStorage.removeItem(KEYS.identityPins);
  return legacy;
};

// The retired 'general' room used to persist its whole log in localStorage. Purge
// it so the room really disappears instead of lingering in every browser.
try { localStorage.removeItem('segment_general'); } catch { /* storage unavailable */ }

export const webStorage = {
  getCryptoKit: (accountId) => cryptoRecord('readonly', String(accountId || 'anonymous')),
  setCryptoKit: (accountId, kit) => cryptoRecord('readwrite', String(accountId || 'anonymous'), kit),
  getSecureHistoryState: (accountId) => secureHistoryGet(String(accountId || 'anonymous')),
  setSecureHistoryState: (accountId, state) => secureHistorySet(String(accountId || 'anonymous'), state),
  getSecureIdentityPins: (accountId) => securePinsGet(String(accountId || 'anonymous')),
  setSecureIdentityPins: (accountId, pins) => securePinsSet(String(accountId || 'anonymous'), pins),
  getName: () => localStorage.getItem(KEYS.name) || '',
  setName: (name) => localStorage.setItem(KEYS.name, name),
  getUsername: () => localStorage.getItem(KEYS.username) || '',
  setUsername: (username) => localStorage.setItem(KEYS.username, username || ''),
  getAvatar: () => localStorage.getItem(KEYS.avatar) || '',
  setAvatar: (avatar) => localStorage.setItem(KEYS.avatar, avatar || ''),

  getColor: () => localStorage.getItem(KEYS.color) || '',
  setColor: (color) => localStorage.setItem(KEYS.color, color),

  getMuted: () => { try { return JSON.parse(localStorage.getItem(KEYS.muted) || '[]'); } catch { return []; } },
  setMuted: (list) => localStorage.setItem(KEYS.muted, JSON.stringify(list)),

  getArchived: () => { try { return JSON.parse(localStorage.getItem(KEYS.archived) || '[]'); } catch { return []; } },
  setArchived: (list) => localStorage.setItem(KEYS.archived, JSON.stringify(list)),
  getFolders: () => { try { return JSON.parse(localStorage.getItem(KEYS.folders) || '[]'); } catch { return []; } },
  setFolders: (list) => localStorage.setItem(KEYS.folders, JSON.stringify(list)),

  getNotes: () => JSON.parse(localStorage.getItem(KEYS.notes) || '[]'),
  setNotes: (list) => localStorage.setItem(KEYS.notes, JSON.stringify(list.slice(-NOTES_LIMIT))),

  getPinned: () => JSON.parse(localStorage.getItem(KEYS.pinned) || '[]'),
  setPinned: (list) => localStorage.setItem(KEYS.pinned, JSON.stringify(list)),
  getHistoryKeys: () => { try { return JSON.parse(localStorage.getItem(KEYS.historyKeys) || '{}'); } catch { return {}; } },
  setHistoryKeys: () => {},
  getHistoryKeyArchive: () => { try { return JSON.parse(localStorage.getItem(KEYS.historyKeyArchive) || '{}'); } catch { return {}; } },
  setHistoryKeyArchive: () => {},
  getHistoryKeyEpochs: () => { try { return JSON.parse(localStorage.getItem(KEYS.historyKeyEpochs) || '{}'); } catch { return {}; } },
  setHistoryKeyEpochs: () => {},
  getIdentityPins: () => ({}),
  setIdentityPins: () => {},
  getOutbox: () => { try { return JSON.parse(localStorage.getItem(KEYS.outbox) || '[]'); } catch { return []; } },
  setOutbox: (items) => localStorage.setItem(KEYS.outbox, JSON.stringify(items || [])),
  getDrafts: () => { try { return JSON.parse(localStorage.getItem(KEYS.drafts) || '{}'); } catch { return {}; } },
  setDrafts: (items) => localStorage.setItem(KEYS.drafts, JSON.stringify(items || {})),
  getScheduled: () => { try { return JSON.parse(localStorage.getItem(KEYS.scheduled) || '[]'); } catch { return []; } },
  setScheduled: (items) => localStorage.setItem(KEYS.scheduled, JSON.stringify(items || [])),

  clear: () => {
    localStorage.removeItem(KEYS.name);
    localStorage.removeItem(KEYS.username);
    localStorage.removeItem(KEYS.avatar);
    localStorage.removeItem(KEYS.notes);
    localStorage.removeItem(KEYS.pinned);
    localStorage.removeItem(KEYS.color);
    localStorage.removeItem(KEYS.muted);
    localStorage.removeItem(KEYS.archived);
    localStorage.removeItem(KEYS.folders);
    localStorage.removeItem(KEYS.historyKeys);
    localStorage.removeItem(KEYS.historyKeyArchive);
    localStorage.removeItem(KEYS.historyKeyEpochs);
    localStorage.removeItem(KEYS.identityPins);
    localStorage.removeItem(KEYS.outbox);
    localStorage.removeItem(KEYS.drafts);
    localStorage.removeItem(KEYS.scheduled);
  },
};
