
//




import { SegmentClient } from '@segment/core';
import { webStorage } from './js/storage.js';
import { $ } from './js/util.js';
import { createRegistry } from './js/panels/registry.js';
import { profilePanel } from './js/panels/profile.js';
import { chatListPanel } from './js/panels/chat-list.js';
import { chatRoomPanel } from './js/panels/chat-room.js';
import { Workspace } from './js/workspace/workspace.js';

const client = new SegmentClient({ storage: webStorage });


const registry = createRegistry();
registry.register(profilePanel(client));
registry.register(chatListPanel(client));
registry.register(chatRoomPanel(client));

let workspace = null;

const uiPrefs = (() => { try { return JSON.parse(localStorage.getItem('segment_ui_prefs') || '{}'); } catch { return {}; } })();
const applyUiPrefs = (prefs = uiPrefs) => {
  document.documentElement.dataset.density = prefs.density || 'comfortable';
  document.documentElement.style.setProperty('--ui-scale', String(prefs.scale || 1));
  document.documentElement.classList.toggle('reduce-motion', !!prefs.reduceMotion);
};
applyUiPrefs();

const segmentApi = { client, registry, workspace: null, forwardDraft: null, uiPrefs, applyUiPrefs };
window.Segment = segmentApi;

const mountWorkspace = () => {
  if (workspace) return;
  const root = document.createElement('div');
  root.className = 'workspace';
  root.id = 'workspace';
  document.body.appendChild(root);
  workspace = new Workspace(root, registry.list());
  segmentApi.workspace = workspace;
};

segmentApi.saveUiPrefs = (patch = {}) => {
  Object.assign(uiPrefs, patch); localStorage.setItem('segment_ui_prefs', JSON.stringify(uiPrefs)); applyUiPrefs();
};

document.addEventListener('keydown', (e) => {
  const typing = /INPUT|TEXTAREA/.test(e.target.tagName) || e.target.isContentEditable;
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
    e.preventDefault(); document.querySelector('.panel[data-id="chat-list"] .chat-search input')?.focus(); return;
  }
  if (e.key === 'Escape') {
    document.querySelectorAll('.ctx-menu:not(.hidden), .chat-preview:not(.hidden), .settings-sheet:not(.hidden)').forEach((el) => el.classList.add('hidden'));
    if (!typing) client.closeRoom();
    return;
  }
  if (typing || !['ArrowUp', 'ArrowDown'].includes(e.key)) return;
  const visible = [...document.querySelectorAll('.panel[data-id="chat-list"] .chat-item[data-room]')];
  if (!visible.length) return;
  const current = visible.findIndex((el) => el.dataset.room === client.currentRoom);
  const next = e.key === 'ArrowDown' ? Math.min(visible.length - 1, current + 1) : Math.max(0, current < 0 ? 0 : current - 1);
  e.preventDefault(); client.openRoom(visible[next].dataset.room); visible[next].scrollIntoView({ block: 'nearest' });
});

const toast = document.createElement('div');
toast.className = 'segment-toast hidden';
document.body.appendChild(toast);
let toastTimer;

segmentApi.toast = (text, actionText = '', action = null) => {
  clearTimeout(toastTimer);
  toast.innerHTML = `<span>${text}</span>${actionText ? `<button type="button">${actionText}</button>` : ''}`;
  toast.classList.remove('hidden');
  const btn = toast.querySelector('button');
  if (btn) btn.onclick = action;
  if (!actionText) toastTimer = setTimeout(() => toast.classList.add('hidden'), 2200);
};

const AVATAR_COLORS = ['#e17076', '#7bc862', '#e5ca77', '#65aadd', '#a695e7', '#ee7aae', '#6ec9cb', '#f2846a'];
const avatarColor = (id) => {
  let h = 0;
  for (const ch of String(id)) h = ((h << 5) - h + ch.charCodeAt(0)) | 0;
  return AVATAR_COLORS[Math.abs(h) % AVATAR_COLORS.length];
};

segmentApi.cancelForward = () => {
  segmentApi.forwardDraft = null;
  document.body.classList.remove('is-forwarding');
  toast.classList.add('hidden');
  document.querySelector('.fwd-modal')?.classList.add('hidden');
};


const fwd = document.createElement('div');
fwd.className = 'fwd-modal hidden';
fwd.innerHTML = `
  <div class="fwd-box">
    <div class="fwd-head"><b>Переслать в…</b><button class="fwd-close" title="Закрыть">✕</button></div>
    <input class="fwd-search" placeholder="Поиск чата" aria-label="Поиск чата">
    <div class="fwd-list"></div>
    <div class="fwd-foot">
      <button class="fwd-cancel">Отмена</button>
      <button class="fwd-send" disabled>Переслать</button>
    </div>
  </div>`;
document.body.appendChild(fwd);
const fwdList = fwd.querySelector('.fwd-list');
const fwdSearch = fwd.querySelector('.fwd-search');
const fwdSend = fwd.querySelector('.fwd-send');
const fwdSelected = new Set();

const fwdClose = () => { fwd.classList.add('hidden'); fwdSelected.clear(); segmentApi.forwardDraft = null; };
const fwdRender = () => {
  const q = fwdSearch.value.trim().toLowerCase();
  const chats = client.chats.filter((c) => !q || c.name.toLowerCase().includes(q));
  fwdList.innerHTML = chats.map((c) => `
    <label class="fwd-item ${fwdSelected.has(c.id) ? 'checked' : ''}" data-id="${c.id}">
      <span class="fwd-ava" style="background:${avatarColor(c.id)}">${c.icon || c.name[0].toUpperCase()}</span>
      <span class="fwd-name">${c.name}</span>
      <span class="fwd-check">✓</span>
    </label>`).join('') || '<div class="fwd-empty">Ничего не найдено</div>';
  for (const item of fwdList.querySelectorAll('.fwd-item')) {
    item.onclick = (e) => {
      e.preventDefault();
      const id = item.dataset.id;
      if (fwdSelected.has(id)) fwdSelected.delete(id); else fwdSelected.add(id);
      item.classList.toggle('checked', fwdSelected.has(id));
      fwdSend.disabled = !fwdSelected.size;
      fwdSend.textContent = fwdSelected.size ? `Переслать (${fwdSelected.size})` : 'Переслать';
    };
  }
};
fwd.querySelector('.fwd-close').onclick = fwdClose;
fwd.querySelector('.fwd-cancel').onclick = fwdClose;
fwd.onclick = (e) => { if (e.target === fwd) fwdClose(); };
fwdSearch.oninput = fwdRender;
fwdSend.onclick = () => {
  const draft = segmentApi.forwardDraft;
  if (!draft || !fwdSelected.size) return;
  const ids = [...fwdSelected];
  for (const id of ids) client.forwardMessage(id, draft);
  segmentApi.toast(ids.length === 1 ? 'Переслано' : `Переслано в ${ids.length} чата`);
  fwdClose();
  if (ids.length === 1) client.openRoom(ids[0]);
};

segmentApi.startForward = (message) => {
  segmentApi.forwardDraft = {
    text: message?.text || '',
    fromName: message?.name || '',
    fromChat: message?.chatName || '',
  };
  fwdSelected.clear();
  fwdSearch.value = '';
  fwdSend.disabled = true;
  fwdSend.textContent = 'Переслать';
  fwdRender();
  fwd.classList.remove('hidden');
  fwdSearch.focus();
};


const lightbox = document.createElement('div');
lightbox.className = 'lightbox hidden';
const ICON_PLAY = '<svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>';
const ICON_PAUSE = '<svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor"><path d="M6 5h4v14H6zM14 5h4v14h-4z"/></svg>';
const ICON_VOL = '<svg viewBox="0 0 24 24" width="19" height="19" fill="currentColor"><path d="M3 10v4h4l5 5V5L7 10H3zm13 2a4 4 0 0 0-2-3.5v7A4 4 0 0 0 16 12z"/></svg>';
const ICON_MUTE = '<svg viewBox="0 0 24 24" width="19" height="19" fill="currentColor"><path d="M3 10v4h4l5 5V5L7 10H3z"/><path d="M16 8l5 8M21 8l-5 8" stroke="currentColor" stroke-width="2"/></svg>';
const ICON_FULL = '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/></svg>';
const ICON_ROTATE = '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M20 11a8 8 0 1 0-2.3 5.7"/><path d="M20 4v7h-7"/></svg>';
const ICON_DOWNLOAD = '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v12"/><path d="m7 10 5 5 5-5"/><path d="M5 21h14"/></svg>';
const ICON_CLOSE = '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="m6 6 12 12M18 6 6 18"/></svg>';
const ICON_PREV = '<svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="m15 18-6-6 6-6"/></svg>';
const ICON_NEXT = '<svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="m9 18 6-6-6-6"/></svg>';

lightbox.innerHTML = `
  <header class="lightbox-top">
    <div class="lightbox-info"><span class="lightbox-author-avatar"></span><span class="lightbox-author-copy"><b class="lightbox-title">Segment</b><span class="lightbox-counter"></span></span></div>
    <div class="lightbox-tools">
      <button data-lb="rotate" title="Повернуть" aria-label="Повернуть">${ICON_ROTATE}</button>
      <button data-lb="download" title="Скачать" aria-label="Скачать">${ICON_DOWNLOAD}</button><button class="lightbox-close" title="Закрыть" aria-label="Закрыть">${ICON_CLOSE}</button>
    </div>
  </header>
  <button class="lightbox-nav prev" title="Назад">${ICON_PREV}</button>
  <div class="lightbox-stage">
    <img class="lightbox-img" alt="">
    <div class="vplayer hidden">
      <video class="vplayer-video" playsinline></video>
      <button class="vplayer-center" title="Плей">${ICON_PLAY}</button>
      <div class="vplayer-bar">
        <button class="vplayer-play" title="Плей">${ICON_PLAY}</button>
        <span class="vplayer-cur">0:00</span>
        <div class="vplayer-seek"><div class="vplayer-buf"></div><div class="vplayer-fill"><span class="vplayer-knob"></span></div></div>
        <span class="vplayer-dur">0:00</span>
        <button class="vplayer-mute" title="Звук">${ICON_VOL}</button>
        <button class="vplayer-full" title="На весь экран">${ICON_FULL}</button>
      </div>
    </div>
  </div>
  <button class="lightbox-nav next" title="Вперёд">${ICON_NEXT}</button>
  <footer class="lightbox-bottom"><div class="lightbox-caption"></div><div class="lightbox-thumbs"></div><div class="lightbox-help">Колесо — масштаб · двойной клик — приблизить · стрелки — навигация</div></footer>`;
document.body.appendChild(lightbox);
const lightboxImg = lightbox.querySelector('.lightbox-img');
const vplayer = lightbox.querySelector('.vplayer');
const lightboxVideo = lightbox.querySelector('.vplayer-video');
const lbTitle = lightbox.querySelector('.lightbox-title');
const lbCounter = lightbox.querySelector('.lightbox-counter');
const lbAuthorAvatar = lightbox.querySelector('.lightbox-author-avatar');
const lbCaption = lightbox.querySelector('.lightbox-caption');
const lbThumbs = lightbox.querySelector('.lightbox-thumbs');


const vPlayBtn = lightbox.querySelector('.vplayer-play');
const vCenterBtn = lightbox.querySelector('.vplayer-center');
const vSeek = lightbox.querySelector('.vplayer-seek');
const vFill = lightbox.querySelector('.vplayer-fill');
const vBuf = lightbox.querySelector('.vplayer-buf');
const vCur = lightbox.querySelector('.vplayer-cur');
const vDur = lightbox.querySelector('.vplayer-dur');
const vMuteBtn = lightbox.querySelector('.vplayer-mute');
const vFullBtn = lightbox.querySelector('.vplayer-full');
const vFmt = (s) => {
  if (!Number.isFinite(s)) return '0:00';
  const m = Math.floor(s / 60);
  return `${m}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
};
const vSyncPlay = () => {
  const paused = lightboxVideo.paused;
  vPlayBtn.innerHTML = paused ? ICON_PLAY : ICON_PAUSE;
  vCenterBtn.innerHTML = paused ? ICON_PLAY : ICON_PAUSE;
  vplayer.classList.toggle('paused', paused);
};
const vToggle = () => { if (lightboxVideo.paused) lightboxVideo.play().catch(() => {}); else lightboxVideo.pause(); };
lightboxVideo.addEventListener('play', vSyncPlay);
lightboxVideo.addEventListener('pause', vSyncPlay);
lightboxVideo.addEventListener('loadedmetadata', () => { vDur.textContent = vFmt(lightboxVideo.duration); });
lightboxVideo.addEventListener('timeupdate', () => {
  const d = lightboxVideo.duration || 0;
  vFill.style.width = d ? `${(lightboxVideo.currentTime / d) * 100}%` : '0%';
  vCur.textContent = vFmt(lightboxVideo.currentTime);
});
lightboxVideo.addEventListener('progress', () => {
  const d = lightboxVideo.duration || 0;
  if (d && lightboxVideo.buffered.length) vBuf.style.width = `${(lightboxVideo.buffered.end(lightboxVideo.buffered.length - 1) / d) * 100}%`;
});
const vSeekTo = (e) => {
  const r = vSeek.getBoundingClientRect();
  const p = Math.max(0, Math.min(1, (e.clientX - r.left) / r.width));
  if (lightboxVideo.duration) lightboxVideo.currentTime = p * lightboxVideo.duration;
};
let vScrubbing = false;
vSeek.addEventListener('pointerdown', (e) => { vScrubbing = true; vSeek.setPointerCapture(e.pointerId); vSeekTo(e); });
vSeek.addEventListener('pointermove', (e) => { if (vScrubbing) vSeekTo(e); });
vSeek.addEventListener('pointerup', () => { vScrubbing = false; });
vPlayBtn.onclick = (e) => { e.stopPropagation(); vToggle(); };
vCenterBtn.onclick = (e) => { e.stopPropagation(); vToggle(); };
lightboxVideo.onclick = (e) => { e.stopPropagation(); vToggle(); };
vMuteBtn.onclick = (e) => {
  e.stopPropagation();
  lightboxVideo.muted = !lightboxVideo.muted;
  vMuteBtn.innerHTML = lightboxVideo.muted ? ICON_MUTE : ICON_VOL;
};
const toggleFullscreen = () => {
  const fsEl = document.fullscreenElement || document.webkitFullscreenElement;
  if (fsEl) {
    (document.exitFullscreen || document.webkitExitFullscreen)?.call(document);
  } else {
    const req = vplayer.requestFullscreen || vplayer.webkitRequestFullscreen || lightboxVideo.webkitEnterFullscreen;
    req?.call(vplayer.requestFullscreen ? vplayer : lightboxVideo);
  }
};
vFullBtn.onclick = (e) => { e.stopPropagation(); toggleFullscreen(); };
lightboxVideo.ondblclick = (e) => { e.stopPropagation(); toggleFullscreen(); };


let zoom = 1;
let panX = 0;
let panY = 0;
let rotation = 0;


const clampPan = () => {
  const stage = lightbox.querySelector('.lightbox-stage');
  const maxX = Math.max(0, (lightboxImg.offsetWidth * zoom - stage.clientWidth) / 2);
  const maxY = Math.max(0, (lightboxImg.offsetHeight * zoom - stage.clientHeight) / 2);
  panX = Math.max(-maxX, Math.min(maxX, panX));
  panY = Math.max(-maxY, Math.min(maxY, panY));
};
const applyZoom = () => {
  clampPan();
  lightboxImg.style.transform = `translate(${panX}px, ${panY}px) scale(${zoom}) rotate(${rotation}deg)`;
  lightboxImg.style.cursor = zoom > 1 ? 'grab' : 'zoom-in';
  lightboxImg.classList.toggle('zoomed', zoom > 1);
};
const resetZoom = (resetRotation = true) => { zoom = 1; panX = 0; panY = 0; if (resetRotation) rotation = 0; lightboxImg.style.transform = rotation ? `rotate(${rotation}deg)` : ''; lightboxImg.classList.remove('zoomed'); };
const setZoom = (value) => { zoom = Math.max(.25, Math.min(8, value)); if (Math.abs(zoom - 1) < .015) zoom = 1; if (zoom === 1) { panX = 0; panY = 0; } applyZoom(); };
lightbox.querySelector('.lightbox-stage').addEventListener('wheel', (e) => {
  e.preventDefault();
  const prev = zoom;
  zoom = Math.max(.25, Math.min(8, zoom * Math.exp(-e.deltaY * .0018)));
  if (Math.abs(zoom - 1) < .015) zoom = 1;
  if (zoom === 1) { panX = 0; panY = 0; }
  else {
    const r = lightbox.querySelector('.lightbox-stage').getBoundingClientRect();
    const cx = e.clientX - (r.left + r.width / 2) - panX;
    const cy = e.clientY - (r.top + r.height / 2) - panY;
    const k = zoom / prev;
    panX -= cx * (k - 1);
    panY -= cy * (k - 1);
  }
  applyZoom();
}, { passive: false });

let dragging = false; let dragX = 0; let dragY = 0;
const pinchPoints = new Map(); let pinchStart = null;
const pinchDistance = () => { const p = [...pinchPoints.values()]; return p.length < 2 ? 0 : Math.hypot(p[0].x - p[1].x, p[0].y - p[1].y); };
lightboxImg.addEventListener('pointerdown', (e) => {
  if (e.pointerType !== 'touch') return; pinchPoints.set(e.pointerId, { x: e.clientX, y: e.clientY });
  if (pinchPoints.size === 2) pinchStart = { distance: pinchDistance(), zoom };
});
lightboxImg.addEventListener('pointermove', (e) => {
  if (!pinchPoints.has(e.pointerId)) return; pinchPoints.set(e.pointerId, { x: e.clientX, y: e.clientY });
  if (pinchStart && pinchPoints.size === 2) setZoom(pinchStart.zoom * pinchDistance() / Math.max(1, pinchStart.distance));
});
const endPinch = (e) => { pinchPoints.delete(e.pointerId); if (pinchPoints.size < 2) pinchStart = null; };
lightboxImg.addEventListener('pointerup', endPinch); lightboxImg.addEventListener('pointercancel', endPinch);
lightboxImg.addEventListener('pointerdown', (e) => {
  if (e.pointerType === 'touch' && pinchPoints.size > 1) return;
  if (zoom <= 1) return;
  dragging = true; dragX = e.clientX - panX; dragY = e.clientY - panY;
  lightboxImg.setPointerCapture(e.pointerId);
  lightboxImg.style.cursor = 'grabbing';
});
lightboxImg.addEventListener('pointermove', (e) => {
  if (pinchPoints.size > 1) return;
  if (!dragging) return;
  panX = e.clientX - dragX; panY = e.clientY - dragY; applyZoom();
});
lightboxImg.addEventListener('pointerup', () => { dragging = false; if (zoom > 1) lightboxImg.style.cursor = 'grab'; });

let lbList = [];
let lbIndex = 0;

const lbNorm = (x) => (typeof x === 'string' ? { type: 'photo', src: x } : x);
const lbRenderThumbs = () => {
  lbThumbs.innerHTML = lbList.map((x, i) => `<button class="lightbox-thumb${i === lbIndex ? ' active' : ''}" data-index="${i}">${x.type === 'video' ? '<span>▶</span>' : ''}<img src="${x.poster || x.src || ''}" alt=""></button>`).join('');
  for (const btn of lbThumbs.querySelectorAll('[data-index]')) btn.onclick = (e) => { e.stopPropagation(); lbIndex = Number(btn.dataset.index); lbShow(); };
  lbThumbs.querySelector('.active')?.scrollIntoView({ inline: 'center', block: 'nearest' });
};
const lbShow = () => {
  const item = lbList[lbIndex];
  if (!item) return;
  resetZoom();
  const isVideo = item.type === 'video';
  lightboxImg.classList.toggle('hidden', isVideo);
  vplayer.classList.toggle('hidden', !isVideo);
  if (isVideo) {
    lightboxImg.src = '';
    vBuf.style.width = vFill.style.width = '0%';
    vCur.textContent = '0:00';
    lightboxVideo.poster = item.poster || '';
    lightboxVideo.src = item.src || '';
    lightboxVideo.play?.().catch(() => {});
    vSyncPlay();
  } else {
    lightboxVideo.pause?.();
    lightboxVideo.removeAttribute('src');
    lightboxImg.src = item.src || '';
    lightboxImg.onload = () => {
      const details = [item.caption || '', `${lightboxImg.naturalWidth}×${lightboxImg.naturalHeight}`, item.size ? `${Math.max(1, Math.round(item.size / 1024))} КБ` : ''].filter(Boolean);
      lbCaption.textContent = details.join(' · ');
    };
  }
  const author = item.author || item.name || 'Segment';
  lbTitle.textContent = author;
  lbAuthorAvatar.textContent = author.trim().slice(0, 1).toUpperCase() || 'S';
  lbAuthorAvatar.style.background = item.color || '#4f7cff';
  lbCounter.textContent = `${isVideo ? 'Видео' : 'Фото'} ${lbIndex + 1} из ${lbList.length}`;
  lbCaption.textContent = [item.caption || '', item.size ? `${Math.max(1, Math.round(item.size / 1024))} КБ` : ''].filter(Boolean).join(' · ');
  lbRenderThumbs();
};
const lbStep = (d) => {
  if (lbList.length < 2) return;
  lbIndex = (lbIndex + d + lbList.length) % lbList.length;
  lbShow();
};
const lbClose = () => {
  lightbox.classList.add('hidden');
  document.body.classList.remove('media-open');
  resetZoom();
  lightboxImg.src = '';
  lightboxVideo.pause?.();
  lightboxVideo.removeAttribute('src');
};
segmentApi.openMedia = (list, index = 0) => {
  lbList = (Array.isArray(list) ? list : [list]).map(lbNorm);
  if (!lbList.length) return;
  lbIndex = Math.max(0, Math.min(index, lbList.length - 1));
  lightbox.classList.toggle('single', lbList.length < 2);
  lbShow();
  lightbox.classList.remove('hidden');
  document.body.classList.add('media-open');
};
segmentApi.openImage = (list, index = 0) => segmentApi.openMedia(list, index);
lightbox.querySelector('.lightbox-close').onclick = lbClose;
lightbox.querySelector('.prev').onclick = (e) => { e.stopPropagation(); lbStep(-1); };
lightbox.querySelector('.next').onclick = (e) => { e.stopPropagation(); lbStep(1); };
lightbox.querySelector('[data-lb="rotate"]').onclick = (e) => { e.stopPropagation(); rotation = (rotation + 90) % 360; applyZoom(); };
lightbox.querySelector('[data-lb="download"]').onclick = (e) => {
  e.stopPropagation(); const item = lbList[lbIndex]; if (!item?.src) return;
  const a = document.createElement('a'); a.href = item.src; a.download = item.name || (item.type === 'video' ? 'video' : 'photo'); a.click();
};
lightbox.onclick = (e) => { if (e.target === lightbox) lbClose(); };
lightbox.querySelector('.lightbox-stage').onclick = (e) => { if (e.target.classList.contains('lightbox-stage')) lbClose(); };
document.addEventListener('keydown', (e) => {
  if (lightbox.classList.contains('hidden')) return;
  if (e.key === 'Escape') { e.stopImmediatePropagation(); lbClose(); }
  else if (e.key === 'ArrowLeft') lbStep(-1);
  else if (e.key === 'ArrowRight') lbStep(1);
  else if (e.key.toLowerCase() === 'r') { rotation = (rotation + 90) % 360; applyZoom(); }
  else if (e.key.toLowerCase() === 'f' && lbList[lbIndex]?.type === 'video') toggleFullscreen();
  else if (e.key.toLowerCase() === 'm' && lbList[lbIndex]?.type === 'video') { lightboxVideo.muted = !lightboxVideo.muted; vMuteBtn.innerHTML = lightboxVideo.muted ? ICON_MUTE : ICON_VOL; }
  else if (e.key === ' ' && lbList[lbIndex]?.type === 'video') { e.preventDefault(); vToggle(); }
});


segmentApi.demo = async () => {
  const room = 'general';
  const paint = (w, h, draw) => {
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    const x = c.getContext('2d');
    draw(x, w, h);
    return c.toDataURL('image/png');
  };
  const solid = (w, h, col, label) => paint(w, h, (x) => {
    x.fillStyle = col; x.fillRect(0, 0, w, h);
    if (label) { x.fillStyle = 'rgba(255,255,255,.85)'; x.font = 'bold 20px sans-serif'; x.fillText(label, 14, h - 16); }
  });
  const photo = (w, h, col, label) => ({ kind: 'photo', name: label || 'photo.png', size: 42000, mime: 'image/png', data: solid(w, h, col, label), w, h });


  const makeVideo = async () => {
    try {
      const c = document.createElement('canvas'); c.width = 320; c.height = 200;
      const x = c.getContext('2d');
      const rec = new MediaRecorder(c.captureStream(25), { mimeType: 'video/webm' });
      const chunks = []; rec.ondataavailable = (e) => chunks.push(e.data);
      const done = new Promise((res) => (rec.onstop = res));
      rec.start();
      let f = 0;
      const iv = setInterval(() => {
        x.fillStyle = `hsl(${(f * 9) % 360},65%,45%)`; x.fillRect(0, 0, 320, 200);
        x.fillStyle = '#fff'; x.font = 'bold 26px sans-serif'; x.fillText('Segment 🎬', 60, 110); f++;
      }, 40);
      await new Promise((r) => setTimeout(r, 2000));
      clearInterval(iv); rec.stop(); await done;
      const blob = new Blob(chunks, { type: 'video/webm' });
      const data = await new Promise((res) => { const fr = new FileReader(); fr.onload = () => res(fr.result); fr.readAsDataURL(blob); });
      return { kind: 'video', name: 'clip.webm', size: blob.size, mime: 'video/webm', data, poster: solid(320, 200, '#2a3b4d', '▶ видео'), duration: 2, w: 320, h: 200 };
    } catch { return null; }
  };
  const blobData = (blob) => new Promise((res) => { const fr = new FileReader(); fr.onload = () => res(fr.result); fr.readAsDataURL(blob); });


  const makeVoice = async () => {
    try {
      const ctx = new (window.AudioContext || window.webkitAudioContext)();
      const dest = ctx.createMediaStreamDestination();
      const osc = ctx.createOscillator(); osc.type = 'sine';
      const gain = ctx.createGain(); gain.gain.value = 0.15;
      osc.connect(gain); gain.connect(dest); osc.start();
      const rec = new MediaRecorder(dest.stream);
      const chunks = []; rec.ondataavailable = (e) => chunks.push(e.data);
      const done = new Promise((res) => (rec.onstop = res));
      rec.start();
      let t = 0; const iv = setInterval(() => { osc.frequency.value = 220 + Math.abs(Math.sin(t)) * 500; t += 0.4; }, 90);
      await new Promise((r) => setTimeout(r, 2600));
      clearInterval(iv); osc.stop(); rec.stop(); await done; ctx.close();
      const blob = new Blob(chunks, { type: rec.mimeType || 'audio/webm' });
      const waveform = Array.from({ length: 28 }, (_, i) => 0.25 + Math.abs(Math.sin(i * 0.7)) * 0.7);
      return { kind: 'voice', name: 'voice.webm', size: blob.size, mime: blob.type, data: await blobData(blob), duration: 2.6, waveform };
    } catch { return null; }
  };


  const makeCircle = async () => {
    try {
      const c = document.createElement('canvas'); c.width = 240; c.height = 240;
      const x = c.getContext('2d');
      const rec = new MediaRecorder(c.captureStream(25), { mimeType: 'video/webm' });
      const chunks = []; rec.ondataavailable = (e) => chunks.push(e.data);
      const done = new Promise((res) => (rec.onstop = res));
      rec.start();
      let f = 0;
      const iv = setInterval(() => {
        x.fillStyle = `hsl(${(f * 6) % 360},55%,40%)`; x.fillRect(0, 0, 240, 240);
        x.fillStyle = '#fff'; x.font = 'bold 22px sans-serif'; x.textAlign = 'center'; x.fillText('привет 👋', 120, 130); f++;
      }, 40);
      await new Promise((r) => setTimeout(r, 2200));
      clearInterval(iv); rec.stop(); await done;
      const blob = new Blob(chunks, { type: 'video/webm' });
      return { kind: 'circle', name: 'circle.webm', size: blob.size, mime: 'video/webm', data: await blobData(blob), poster: solid(240, 240, '#33475c', ''), duration: 2 };
    } catch { return null; }
  };

  const A = { name: 'Аня', color: '#e0729a' };
  const M = { name: 'Макс', color: '#4a90d9' };
  const me = { name: client.self.name, color: client.self.color };
  const mid = () => `demo-${Math.random().toString(36).slice(2, 9)}`;
  const msg = (a, extra) => ({ id: mid(), name: a.name, color: a.color, ts: Date.now(), reactions: {}, text: '', ...extra });

  client.messages[room] = [];
  const push = (a, extra) => { const m = msg(a, extra); client._applyEvent(room, { kind: 'message', message: m }, a); return m; };

  push(A, { text: 'Привет! 👋 Зацени новый Segment — почти как телега' });
  push(A, { text: 'Смотри какие форматы теперь есть' });
  const q = push(M, { text: 'О, интересно. Фото грузятся?' });
  push(A, { text: 'Да! И альбомами, и по одному', replyTo: { id: q.id, name: q.name, text: q.text } });
  push(A, { text: '', attachments: [photo(280, 180, '#4a90d9', 'море')] });
  push(A, { text: 'вот с прогулки, целый альбом:', attachments: [
    photo(300, 200, '#50c878', '1'), photo(300, 200, '#e0729a', '2'),
    photo(200, 300, '#f5a623', '3'), photo(200, 200, '#9b59b6', '4'),
  ] });
  const vid = await makeVideo();
  if (vid) push(A, { text: '', attachments: [vid] });
  push(M, { text: 'Огонь 🔥 а файлы?' });
  push(A, { text: 'И файлы, и пересылка', attachments: [
    { kind: 'file', name: 'презентация.pdf', size: 2400000, mime: 'application/pdf', data: 'data:application/pdf;base64,JVBERi0xLjQK' },
  ] });
  push(A, { text: 'держи, переслала из канала', forwardFrom: { name: 'Segment News', chatName: 'Канал' } });
  const voice = await makeVoice();
  if (voice) push(M, { text: '', attachments: [voice] });
  const circle = await makeCircle();
  if (circle) push(A, { text: '', attachments: [circle] });
  push(me, { text: 'Вау, реально круто получилось! 🎉' });
  const withReactions = msg(me, { text: 'Спасибо, старался ❤️', reactions: { '🔥': ['Аня', 'Макс'], '❤️': ['Аня'] } });
  client._addMessage(room, withReactions);
  const myVoice = await makeVoice();
  if (myVoice) push(me, { text: '', attachments: [myVoice] });

  client.openRoom(room);
  client.saveDialog('general');
  segmentApi.toast?.('Демо-диалог создан и сохранён');
  return 'ok';
};


client.on('append', ({ roomId }) => { if (roomId === 'general') client.saveDialog('general'); });


client.on('chats', () => {
  const total = client.chats.reduce((n, c) => n + (client.muted.has(c.id) ? 0 : (client.unread[c.id] || 0)), 0);
  document.title = total > 0 ? `(${total}) Segment` : 'Segment';
});


const gate = $('gate');
let authEmail = '';
let registrationToken = '';
let avatarData = '';
let connected = false;
const authError = $('authError');
const authSteps = [...gate.querySelectorAll('[data-step]')];
const codeDigits = [...gate.querySelectorAll('[data-code-digit]')];
const readCode = () => codeDigits.map((input) => input.value).join('');
const fillCode = (value) => {
  const digits = String(value).replace(/\D/g, '').slice(0, codeDigits.length);
  codeDigits.forEach((input, index) => { input.value = digits[index] || ''; });
  codeDigits[Math.min(digits.length, codeDigits.length - 1)]?.focus();
};
const authCopy = {
  email: { index: 1, kicker: 'Шаг 1 из 3', subtitle: 'Введите почту — мы отправим одноразовый код' },
  code: { index: 2, kicker: 'Шаг 2 из 3', subtitle: 'Введите шестизначный код из письма' },
  profile: { index: 3, kicker: 'Шаг 3 из 3', subtitle: 'Создайте профиль — данные можно изменить позже' },
};
const showAuthStep = (name) => {
  for (const step of authSteps) {
    const inactive = step.dataset.step !== name;
    step.hidden = inactive;
    step.classList.toggle('hidden', inactive);
  }
  const copy = authCopy[name];
  gate.querySelector('[data-auth="kicker"]').textContent = copy.kicker;
  gate.querySelector('[data-auth="subtitle"]').textContent = copy.subtitle;
  gate.querySelectorAll('[data-progress]').forEach((item, index) => item.classList.toggle('active', index + 1 === copy.index));
  authError.classList.add('hidden');
  gate.querySelector(`[data-step="${name}"] input:not([type="file"])`)?.focus();
};
const showAuthError = (message) => { authError.textContent = message; authError.classList.remove('hidden'); };
const authMessage = (code) => ({
  EMAIL_INVALID: 'Проверь адрес электронной почты',
  TOO_MANY_REQUESTS: 'Подожди минуту перед новой попыткой',
  EMAIL_NOT_CONFIGURED: 'Отправка писем ещё не настроена на сервере',
  EMAIL_SEND_FAILED: 'Не удалось отправить письмо. Попробуй позже',
  CODE_INVALID: 'Неверный или просроченный код',
  USERNAME_INVALID: 'Username: 3–24 символа, только a–z, 0–9 и _',
  USERNAME_TAKEN: 'Этот username уже занят',
  NAME_INVALID: 'Укажи имя',
  AVATAR_TOO_LARGE: 'Фотография слишком большая',
  REGISTRATION_EXPIRED: 'Регистрация устарела. Запроси новый код',
}[code] || 'Что-то пошло не так');
const authApi = async (path, options = {}) => {
  const response = await fetch(`/api/auth/${path}`, { credentials: 'same-origin', headers: { 'Content-Type': 'application/json', ...(options.headers || {}) }, ...options });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw Object.assign(new Error(data.error || 'REQUEST_FAILED'), { code: data.error });
  return data;
};
const enterApp = (user) => {
  webStorage.setName(user.name);
  webStorage.setUsername?.(user.username);
  webStorage.setAvatar?.(user.avatar || '');
  webStorage.setColor(user.color);
  client.self = { name: user.name, username: user.username, avatar: user.avatar || '', color: user.color };
  document.body.classList.remove('auth-pending');
  document.body.classList.add('authenticated');
  mountWorkspace();
  client._emit('identity', { name: user.name, user });
  gate.classList.add('hidden');
  if (!connected) { connected = true; client.connect(); }
  bootRooms();
};

// After sign-in: load the account's rooms, then act on any deep link the user
// opened the app with (/j/ invite, /c/ channel, /@ profile).
const bootRooms = async () => {
  await client.loadRooms();
  const path = location.pathname;
  let match;
  if ((match = path.match(/^\/j\/([A-Za-z0-9_-]{16,64})$/))) {
    try { await client.joinByToken(match[1]); segmentApi.toast('Вы присоединились к чату'); }
    catch { segmentApi.toast('Ссылка-приглашение недействительна'); }
    history.replaceState(null, '', '/');
  } else if ((match = path.match(/^\/c\/([a-z0-9-]{3,32})$/i))) {
    const target = await client.resolveLink(path);
    if (target?.room) client._addServerRoom(target.room, { open: true });
    else segmentApi.toast('Канал не найден');
    history.replaceState(null, '', '/');
  } else if ((match = path.match(/^\/@([a-z0-9_]{3,24})$/i))) {
    const target = await client.resolveLink(path);
    segmentApi.toast(target?.user ? `Профиль @${target.user.username}` : 'Профиль не найден');
    history.replaceState(null, '', '/');
  }
};

$('sendCodeBtn').onclick = async () => {
  authEmail = $('emailInput').value.trim().toLowerCase();
  $('sendCodeBtn').disabled = true;
  try { await authApi('request-code', { method: 'POST', body: JSON.stringify({ email: authEmail }) }); fillCode(''); showAuthStep('code'); }
  catch (error) { showAuthError(authMessage(error.code)); }
  finally { $('sendCodeBtn').disabled = false; }
};
$('emailInput').onkeydown = (e) => { if (e.key === 'Enter') $('sendCodeBtn').click(); };
$('changeEmailBtn').onclick = () => showAuthStep('email');
$('verifyCodeBtn').onclick = async () => {
  $('verifyCodeBtn').disabled = true;
  try {
    const result = await authApi('verify-code', { method: 'POST', body: JSON.stringify({ email: authEmail, code: readCode() }) });
    if (result.user) enterApp(result.user);
    else { registrationToken = result.registrationToken; showAuthStep('profile'); }
  } catch (error) { showAuthError(authMessage(error.code)); }
  finally { $('verifyCodeBtn').disabled = false; }
};
codeDigits.forEach((input, index) => {
  input.oninput = () => {
    input.value = input.value.replace(/\D/g, '').slice(-1);
    if (input.value && index < codeDigits.length - 1) codeDigits[index + 1].focus();
    if (readCode().length === codeDigits.length) $('verifyCodeBtn').focus();
  };
  input.onkeydown = (event) => {
    if (event.key === 'Backspace' && !input.value && index > 0) codeDigits[index - 1].focus();
    if (event.key === 'ArrowLeft' && index > 0) { event.preventDefault(); codeDigits[index - 1].focus(); }
    if (event.key === 'ArrowRight' && index < codeDigits.length - 1) { event.preventDefault(); codeDigits[index + 1].focus(); }
    if (event.key === 'Enter' && readCode().length === codeDigits.length) $('verifyCodeBtn').click();
  };
  input.onpaste = (event) => {
    event.preventDefault();
    fillCode(event.clipboardData?.getData('text') || '');
  };
});

$('avatarInput').onchange = () => {
  const file = $('avatarInput').files?.[0];
  if (!file) return;
  if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type)) { showAuthError('Выбери PNG, JPEG или WebP'); return; }
  const reader = new FileReader();
  reader.onload = () => {
    const image = new Image();
    image.onload = () => {
      const size = Math.min(512, Math.max(image.naturalWidth, image.naturalHeight));
      const canvas = document.createElement('canvas'); canvas.width = size; canvas.height = size;
      const context = canvas.getContext('2d'); const scale = Math.max(size / image.naturalWidth, size / image.naturalHeight);
      const width = image.naturalWidth * scale; const height = image.naturalHeight * scale;
      context.drawImage(image, (size - width) / 2, (size - height) / 2, width, height);
      avatarData = canvas.toDataURL('image/jpeg', 0.82);
      $('avatarPreview').innerHTML = `<img src="${avatarData}" alt="">`;
    };
    image.src = reader.result;
  };
  reader.readAsDataURL(file);
};
$('registerBtn').onclick = async () => {
  $('registerBtn').disabled = true;
  try {
    const result = await authApi('register', { method: 'POST', body: JSON.stringify({
      registrationToken, username: $('usernameInput').value, name: $('displayNameInput').value, avatar: avatarData,
    }) });
    enterApp(result.user);
  } catch (error) { showAuthError(authMessage(error.code)); }
  finally { $('registerBtn').disabled = false; }
};

showAuthStep('email');
authApi('me').then(({ user }) => enterApp(user)).catch(() => showAuthStep('email'));


document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  if (segmentApi.forwardDraft) segmentApi.cancelForward();
  else client.closeRoom();
});
