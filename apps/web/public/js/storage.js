
//




const KEYS = { name: 'segment_name', username: 'segment_username', avatar: 'segment_avatar', notes: 'segment_saved', pinned: 'segment_pinned', color: 'segment_color', muted: 'segment_muted', archived: 'segment_archived', folders: 'segment_folders', historyKeys: 'segment_history_keys', historyKeyArchive: 'segment_history_key_archive', outbox: 'segment_outbox', drafts: 'segment_drafts', scheduled: 'segment_scheduled' };
const NOTES_LIMIT = 200;

// The retired 'general' room used to persist its whole log in localStorage. Purge
// it so the room really disappears instead of lingering in every browser.
try { localStorage.removeItem('segment_general'); } catch { /* storage unavailable */ }

export const webStorage = {
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
  setHistoryKeys: (keys) => localStorage.setItem(KEYS.historyKeys, JSON.stringify(keys || {})),
  getHistoryKeyArchive: () => { try { return JSON.parse(localStorage.getItem(KEYS.historyKeyArchive) || '{}'); } catch { return {}; } },
  setHistoryKeyArchive: (keys) => localStorage.setItem(KEYS.historyKeyArchive, JSON.stringify(keys || {})),
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
    localStorage.removeItem(KEYS.outbox);
    localStorage.removeItem(KEYS.drafts);
    localStorage.removeItem(KEYS.scheduled);
  },
};
