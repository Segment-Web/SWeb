

export const $ = (id) => document.getElementById(id);


export function esc(str) {
  return String(str).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}


export function initials(name) {
  return (String(name ?? '').trim()[0] || '·').toUpperCase();
}


export function attachLabel(message) {
  const a = message.attachments;
  if (!a?.length) return '';
  if (a.length > 1) return `🖼 ${a.length} вложений`;
  const k = a[0].kind;
  if (k === 'photo') return '📷 Фото';
  if (k === 'video') return '📹 Видео';
  if (k === 'voice') return '🎤 Голосовое';
  if (k === 'circle') return '📹 Видеосообщение';
  return `📎 ${a[0].name || 'Файл'}`;
}


export function previewOf(message) {
  const body = message.poll ? `📊 ${message.poll.question}` : (message.text || attachLabel(message));
  return message.name ? `${message.name}: ${body}` : body;
}


export function fmtSize(bytes) {
  if (!bytes && bytes !== 0) return '';
  if (bytes < 1024) return `${bytes} Б`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} КБ`;
  return `${(bytes / 1024 / 1024).toFixed(1)} МБ`;
}


/**
 * Place a floating menu inside the visible part of its optional containing
 * surface. It opens toward the cursor and flips before crossing an edge.
 */
export function placeFloatingMenu(element, clientX, clientY, bounds = null, padding = 8) {
  const owner = bounds?.getBoundingClientRect?.() || {
    left: 0,
    top: 0,
    right: window.innerWidth,
    bottom: window.innerHeight,
  };
  const visible = {
    left: Math.max(owner.left, 0),
    top: Math.max(owner.top, 0),
    right: Math.min(owner.right, window.innerWidth),
    bottom: Math.min(owner.bottom, window.innerHeight),
  };
  const maxWidth = Math.max(0, visible.right - visible.left - (padding * 2));
  const maxHeight = Math.max(0, visible.bottom - visible.top - (padding * 2));

  element.style.maxWidth = `${maxWidth}px`;
  element.style.maxHeight = `${maxHeight}px`;
  element.style.overflowX = 'hidden';
  element.style.overflowY = 'auto';
  element.style.left = '0px';
  element.style.top = '0px';

  const width = Math.min(element.offsetWidth, maxWidth);
  const height = Math.min(element.offsetHeight, maxHeight);
  let left = clientX;
  let top = clientY;
  if (left + width > visible.right - padding) left = clientX - width;
  if (top + height > visible.bottom - padding) top = clientY - height;
  left = Math.max(visible.left + padding, Math.min(left, visible.right - width - padding));
  top = Math.max(visible.top + padding, Math.min(top, visible.bottom - height - padding));

  element.style.left = `${left - owner.left}px`;
  element.style.top = `${top - owner.top}px`;
}
