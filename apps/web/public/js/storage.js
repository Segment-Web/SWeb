
//




const KEYS = { name: 'segment_name', username: 'segment_username', avatar: 'segment_avatar', notes: 'segment_saved', pinned: 'segment_pinned', color: 'segment_color', general: 'segment_general', muted: 'segment_muted', archived: 'segment_archived', folders: 'segment_folders' };
const NOTES_LIMIT = 200;

export const webStorage = {
  getName: () => localStorage.getItem(KEYS.name) || '',
  setName: (name) => localStorage.setItem(KEYS.name, name),
  getUsername: () => localStorage.getItem(KEYS.username) || '',
  setUsername: (username) => localStorage.setItem(KEYS.username, username || ''),
  getAvatar: () => localStorage.getItem(KEYS.avatar) || '',
  setAvatar: (avatar) => localStorage.setItem(KEYS.avatar, avatar || ''),

  getColor: () => localStorage.getItem(KEYS.color) || '',
  setColor: (color) => localStorage.setItem(KEYS.color, color),

  getGeneral: () => { try { return JSON.parse(localStorage.getItem(KEYS.general) || '[]'); } catch { return []; } },
  setGeneral: (list) => { try { localStorage.setItem(KEYS.general, JSON.stringify(list)); } catch {} },

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

  clear: () => {
    localStorage.removeItem(KEYS.name);
    localStorage.removeItem(KEYS.username);
    localStorage.removeItem(KEYS.avatar);
    localStorage.removeItem(KEYS.notes);
    localStorage.removeItem(KEYS.pinned);
    localStorage.removeItem(KEYS.color);
    localStorage.removeItem(KEYS.general);
    localStorage.removeItem(KEYS.muted);
    localStorage.removeItem(KEYS.archived);
    localStorage.removeItem(KEYS.folders);
  },
};
