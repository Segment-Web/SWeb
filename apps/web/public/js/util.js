// Мелкие помощники для работы с DOM и текстом.

export const $ = (id) => document.getElementById(id);

/** Экранирует пользовательский текст перед вставкой в innerHTML. */
export function esc(str) {
  return String(str).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

/** Первая буква имени для аватарки. */
export function initials(name) {
  return (String(name ?? '').trim()[0] || '·').toUpperCase();
}

/** Метка вложений для превью («📷 Фото» / «📎 Файл»). */
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

/** Строка предпросмотра сообщения для списка чатов. */
export function previewOf(message) {
  const body = message.poll ? `📊 ${message.poll.question}` : (message.text || attachLabel(message));
  return message.name ? `${message.name}: ${body}` : body;
}

/** Человекочитаемый размер файла. */
export function fmtSize(bytes) {
  if (!bytes && bytes !== 0) return '';
  if (bytes < 1024) return `${bytes} Б`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} КБ`;
  return `${(bytes / 1024 / 1024).toFixed(1)} МБ`;
}
