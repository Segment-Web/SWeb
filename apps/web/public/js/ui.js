


import { esc, initials, previewOf, fmtSize } from './util.js';

const revealedSpoilers = new Set();




export function formatText(raw) {
  const codes = [];

  const hold = (html) => `${codes.push(html) - 1}`;
  let s = esc(raw);

  s = s.replace(/```\n?([\s\S]+?)```/g, (_, c) => hold(`<pre class="code-block">${c.replace(/\n$/, '')}</pre>`));
  s = s.replace(/`([^`\n]+?)`/g, (_, c) => hold(`<code>${c}</code>`));

  s = s.replace(/(https?:\/\/[^\s<]+[^\s<.,;:!?)])/g, '<a href="$1" target="_blank" rel="noopener noreferrer">$1</a>');

  s = s.replace(/\|\|([\s\S]+?)\|\|/g, '<span class="spoiler" data-spoiler>$1</span>');

  s = s.replace(/\*\*([^*\n]+?)\*\*/g, '<b>$1</b>');
  s = s.replace(/__([^_\n]+?)__/g, '<i>$1</i>');
  s = s.replace(/\+\+([^+\n]+?)\+\+/g, '<u>$1</u>');
  s = s.replace(/~~([^~\n]+?)~~/g, '<s>$1</s>');
  s = s.replace(/(^|\s)@([a-z0-9_]{3,24})\b/gi, '$1<a class="mention" href="/@$2">@$2</a>');

  s = s.replace(/(\d+)/g, (_, i) => codes[+i]);
  return s;
}

function highlightedFormattedText(raw, query) {
  const text = String(raw || '');
  const needle = String(query || '').toLocaleLowerCase('ru');
  if (!needle) return formatText(text);
  const startToken = '\uE110';
  const endToken = '\uE111';
  const lower = text.toLocaleLowerCase('ru');
  let tagged = '';
  let cursor = 0;
  while (cursor < text.length) {
    const at = lower.indexOf(needle, cursor);
    if (at < 0) { tagged += text.slice(cursor); break; }
    tagged += text.slice(cursor, at) + startToken + text.slice(at, at + needle.length) + endToken;
    cursor = at + needle.length;
  }
  return formatText(tagged).replaceAll(startToken, '<mark>').replaceAll(endToken, '</mark>');
}


function emojiOnly(text) {
  try {
    const rest = text.replace(/[\s‍️\u{1f3fb}-\u{1f3ff}]/gu, '').replace(/\p{Extended_Pictographic}/gu, '');
    if (rest.length) return 0;
    return [...text.matchAll(/\p{Extended_Pictographic}/gu)].length;
  } catch { return 0; }
}


function pollHtml(m, myName, myId = '') {
  const p = m.poll;
  if (!p) return '';
  const counts = p.options.map((_, i) => Object.values(p.votes || {}).filter((v) => v === i).length);
  const total = counts.reduce((a, b) => a + b, 0);
  const myVote = p.votes?.[myId] ?? p.votes?.[myName];
  const opts = p.options.map((opt, i) => {
    const pct = total ? Math.round((counts[i] / total) * 100) : 0;
    const chosen = myVote === i;
    return `<button class="poll-opt ${chosen ? 'chosen' : ''}" data-poll-opt="${i}">
      <span class="poll-bar" style="width:${total ? pct : 0}%"></span>
      <span class="poll-mark">${chosen ? '✓' : ''}</span>
      <span class="poll-opt-text">${esc(opt)}</span>
      <span class="poll-pct">${total ? pct + '%' : ''}</span>
    </button>`;
  }).join('');
  const totalLabel = total === 0 ? 'Голосов пока нет'
    : `${total} ${total % 10 === 1 && total % 100 !== 11 ? 'голос' : (total % 10 >= 2 && total % 10 <= 4 && (total % 100 < 10 || total % 100 >= 20) ? 'голоса' : 'голосов')}`;
  return `<div class="msg-poll">
    <div class="poll-q">${esc(p.question)}</div>
    <div class="poll-opts">${opts}</div>
    <div class="poll-total">${totalLabel}</div>
  </div>`;
}



function linkCardHtml(m) {
  if (m.image || (m.attachments || []).length) return '';
  const url = (m.text || '').match(/https?:\/\/[^\s]+/)?.[0];
  if (!url) return '';
  let host = '';
  try { host = new URL(url).hostname.replace(/^www\./, ''); } catch { return ''; }
  const isImg = /\.(png|jpe?g|gif|webp)(\?|$)/i.test(url);
  const media = isImg ? `<img class="link-card-img" src="${esc(url)}" alt="">` : '';
  const letter = esc(host[0]?.toUpperCase() || '#');
  return `<a class="link-card" href="${esc(url)}" target="_blank" rel="noopener noreferrer">
    <span class="link-card-ico">${letter}</span>
    <span class="link-card-body"><b>${esc(host)}</b><span>${esc(url)}</span></span>
    ${media}
  </a>`;
}

const FILE_GLYPH = '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/></svg>';
const PLAY_GLYPH = '<svg viewBox="0 0 24 24" width="26" height="26" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>';
const PLAY_SM = '<svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>';
const PAUSE_SM = '<svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor"><path d="M6 5h4v14H6zM14 5h4v14h-4z"/></svg>';


function voiceHtml(v) {
  const peaks = (v.waveform && v.waveform.length ? v.waveform : Array.from({ length: 28 }, () => 0.3));
  const bars = peaks.map((p) => `<span style="height:${Math.max(8, Math.round(p * 100))}%"></span>`).join('');
  // Carry the recorded duration: MediaRecorder webm reports `Infinity` for
  // audio.duration, which left the progress bars and the timer frozen.
  return `<div class="msg-voice" data-voice data-duration="${Number(v.duration) || 0}">
    <button class="voice-play">${PLAY_SM}</button>
    <div class="voice-wave">${bars}</div>
    <span class="voice-time">${fmtDuration(v.duration)}</span>
    <audio preload="metadata" src="${esc(v.data)}"></audio>
  </div>`;
}


function circleHtml(c) {
  const badge = c.duration ? `<span class="circle-time">${esc(fmtDuration(c.duration))}</span>` : '';
  return `<div class="msg-circle" data-circle>
    <video class="circle-video" loop playsinline preload="metadata" poster="${esc(c.poster || '')}" src="${esc(c.data)}"></video>
    <span class="circle-play">${PLAY_GLYPH}</span>${badge}
  </div>`;
}

const fmtDuration = (s) => {
  if (!Number.isFinite(s)) return '';
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  return `${m}:${String(sec).padStart(2, '0')}`;
};


function mediaCellHtml(item, i) {
  if (item.kind === 'video') {
    const badge = item.duration ? `<span class="media-duration">${esc(fmtDuration(item.duration))}</span>` : '';
    const poster = item.poster || item.data;
    return `<div class="media-cell video" data-media="${i}">
      <img src="${esc(poster)}" alt="">
      <span class="media-play">${PLAY_GLYPH}</span>${badge}
    </div>`;
  }
  const gif = item.mime === 'image/gif' ? '<span class="media-gif">GIF</span>' : '';
  return `<div class="media-cell" data-media="${i}">
    <img src="${esc(item.data)}" alt="${esc(item.name || '')}">${gif}
  </div>`;
}

function attachmentsHtml(m) {
  const a = m.attachments;
  if (!a?.length) return '';
  const media = a.filter((x) => x.kind === 'photo' || x.kind === 'video');
  const files = a.filter((x) => x.kind === 'file');
  let html = '';
  for (const c of a.filter((x) => x.kind === 'circle')) html += circleHtml(c);
  for (const v of a.filter((x) => x.kind === 'voice')) html += voiceHtml(v);
  if (media.length) {
    const n = Math.min(media.length, 10);
    const layout = `m${n}`;
    const cells = media.slice(0, 10).map((item, i) => {
      let cell = mediaCellHtml(item, i);

      if (i === 9 && media.length > 10) {
        cell = cell.replace('</div>', `<span class="media-more">+${media.length - 10}</span></div>`);
      }
      return cell;
    }).join('');

    let style = '';
    if (n === 1 && media[0].w && media[0].h) {
      const ratio = Math.max(0.6, Math.min(1.9, media[0].w / media[0].h));
      style = ` style="aspect-ratio:${ratio.toFixed(3)}"`;
    }
    html += `<div class="msg-media ${layout}"${style}>${cells}</div>`;
  }
  for (const f of files) {
    html += `<a class="msg-file" href="${esc(f.data)}" download="${esc(f.name || 'file')}">
      <span class="msg-file-icon">${FILE_GLYPH}</span>
      <span class="msg-file-info"><b>${esc(f.name || 'Файл')}</b><span>${esc(fmtSize(f.size))}</span></span>
    </a>`;
  }
  return html;
}

const FALLBACK_COLOR = '#7c5cff';
const IMAGE_URL_RE = /(https?:\/\/\S+\.(?:png|jpe?g|gif|webp))(?:\?\S*)?/i;


function dateLabel(ts) {
  const d = new Date(ts);
  const today = new Date();
  const yest = new Date(); yest.setDate(today.getDate() - 1);
  const same = (a, b) => a.toDateString() === b.toDateString();
  if (same(d, today)) return 'Сегодня';
  if (same(d, yest)) return 'Вчера';
  const opts = { day: 'numeric', month: 'long' };
  if (d.getFullYear() !== today.getFullYear()) opts.year = 'numeric';
  return d.toLocaleDateString('ru', opts);
}


let reactTip;
function showReactTip(chip) {
  if (!reactTip) {
    reactTip = document.createElement('div');
    reactTip.className = 'react-tip';
    document.body.appendChild(reactTip);
  }
  const names = (chip.dataset.names || '').split('|').filter(Boolean);
  const emoji = chip.dataset.reaction || '';
  reactTip.innerHTML = `<span class="react-tip-emoji">${esc(emoji)}</span>${names.map((n) => esc(n)).join(', ')}`;
  reactTip.classList.add('show');
  const r = chip.getBoundingClientRect();
  reactTip.style.left = `${Math.max(8, Math.min(r.left, window.innerWidth - reactTip.offsetWidth - 8))}px`;
  reactTip.style.top = `${r.top - reactTip.offsetHeight - 8}px`;
}
function hideReactTip() { reactTip?.classList.remove('show'); }

function reactionsHtml(m, myName, myId = '') {
  const entries = Object.entries(m.reactions || {}).filter(([, names]) => names?.length);
  if (!entries.length) return '';
  return `<div class="msg-reactions">${entries.map(([emoji, names]) =>
    `<button class="reaction-chip ${names.includes(myId) || names.includes(myName) ? 'mine' : ''}" data-reaction="${esc(emoji)}" data-names="${esc(names.join('|'))}">${esc(emoji)} <span>${names.length}</span></button>`).join('')}</div>`;
}


function wireVoice(box) {
  const audio = box.querySelector('audio');
  const btn = box.querySelector('.voice-play');
  const bars = [...box.querySelectorAll('.voice-wave span')];
  const timeEl = box.querySelector('.voice-time');
  const recorded = Number(box.dataset.duration) || 0;
  // Prefer the duration captured at record time; MediaRecorder webm streams
  // report Infinity here, which would freeze the waveform and the timer.
  const total = () => (Number.isFinite(audio.duration) && audio.duration > 0 ? audio.duration : recorded);
  const paint = () => {
    const p = total() ? audio.currentTime / total() : 0;
    const on = Math.round(p * bars.length);
    bars.forEach((b, i) => b.classList.toggle('on', i < on));
    timeEl.textContent = fmtDuration(audio.paused ? total() : audio.currentTime);
  };
  btn.onclick = (e) => {
    e.stopPropagation();
    if (audio.paused) { pauseAllMedia(audio); audio.play().catch(() => {}); }
    else audio.pause();
  };
  const sync = () => { btn.innerHTML = audio.paused ? PLAY_SM : PAUSE_SM; box.classList.toggle('playing', !audio.paused); };
  audio.addEventListener('play', sync);
  audio.addEventListener('pause', () => { sync(); paint(); });
  audio.addEventListener('timeupdate', paint);
  audio.addEventListener('ended', () => { audio.currentTime = 0; paint(); });
  box.querySelector('.voice-wave').onclick = (e) => {
    const r = e.currentTarget.getBoundingClientRect();
    if (total()) audio.currentTime = Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)) * total();
  };
}


function wireCircle(box) {
  const video = box.querySelector('video');
  const glyph = box.querySelector('.circle-play');
  const toggle = (e) => {
    e?.stopPropagation();
    if (video.paused) { pauseAllMedia(video); video.play().catch(() => {}); }
    else video.pause();
  };
  box.onclick = toggle;
  const sync = () => { glyph.style.opacity = video.paused ? '1' : '0'; box.classList.toggle('playing', !video.paused); };
  video.addEventListener('play', sync);
  video.addEventListener('pause', sync);
}


function pauseAllMedia(except) {
  for (const el of document.querySelectorAll('.msg-voice audio, .msg-circle video')) {
    if (el !== except && !el.paused) el.pause();
  }
}



function attachSwipeReply(el, id, onReply) {
  const THRESHOLD = 56;
  let startX = 0, startY = 0, dx = 0, active = false, decided = false, pointerId = null;
  const bubble = el.querySelector('.bubble');
  if (!bubble) return;
  const onDown = (e) => {
    if (e.button != null && e.button !== 0) return;
    if (el.closest('.feed.selection-mode')) return;
    if (e.target.closest('a, button, input, .media-cell, .msg-voice, .msg-circle, .reaction-chip')) return;
    startX = e.clientX; startY = e.clientY; dx = 0; active = true; decided = false; pointerId = e.pointerId;
    try { el.setPointerCapture(e.pointerId); } catch {}
  };
  const onMove = (e) => {
    if (!active) return;
    const mx = e.clientX - startX;
    const my = e.clientY - startY;
    if (!decided) {
      if (Math.abs(mx) < 8 && Math.abs(my) < 8) return;

      if (Math.abs(my) > Math.abs(mx) || mx > 0) { active = false; return; }
      decided = true;
      el.classList.add('swiping');
    }
    dx = Math.max(-90, Math.min(0, mx));
    bubble.style.transform = `translateX(${dx}px)`;
    el.style.setProperty('--swipe', `${Math.min(1, -dx / THRESHOLD)}`);
  };
  const finish = (e) => {
    if (!active) return;
    active = false;
    if (pointerId != null) { try { el.releasePointerCapture(pointerId); } catch {} }
    pointerId = null;
    el.classList.remove('swiping');
    bubble.style.transform = '';
    el.style.removeProperty('--swipe');
    if (decided && -dx >= THRESHOLD) onReply(id);

    if (decided) el.dataset.swiped = '1', setTimeout(() => delete el.dataset.swiped, 0);
  };
  el.addEventListener('pointerdown', onDown);
  el.addEventListener('pointermove', onMove);
  el.addEventListener('pointerup', finish);
  el.addEventListener('pointercancel', finish);
  el.addEventListener('lostpointercapture', finish);
}

export function renderMessage(feed, m, myName, options = {}) {
  const displayName = m.channelName || m.name || '';
  const mine = !m.channelName && (m.authorId && options.myId ? m.authorId === options.myId : m.name === myName);

  const dateKey = new Date(m.ts).toDateString();
  const lastMsg = [...feed.querySelectorAll('.msg')].pop();
  const needDivider = !m.system && (!lastMsg || lastMsg.dataset.date !== dateKey);
  if (needDivider) {
    const d = document.createElement('div');
    d.className = 'date-divider';
    d.innerHTML = `<span>${esc(dateLabel(m.ts))}</span>`;
    feed.appendChild(d);
  }

  const grouped = !m.channelName && !m.system && !needDivider && lastMsg && lastMsg.dataset.name === displayName;
  const el = document.createElement('div');
  const anim = options.animate === false ? '' : ' appear';
  el.className = `msg${mine ? ' mine' : ''}${m.channelName ? ' channel-message' : ''}${grouped ? ' grouped' : ''}${m.deleted ? ' deleted' : ''}${options.isSelected?.(m.id) ? ' selected' : ''}${anim}`;
  el.dataset.name = displayName;
  el.dataset.date = dateKey;
  if (m.id) el.dataset.id = m.id;
  const time = new Date(m.ts).toLocaleTimeString('ru', { hour: '2-digit', minute: '2-digit' });
  const color = m.color || FALLBACK_COLOR;
  const replyItems = m.replyTo?.quotes?.length ? m.replyTo.quotes : (m.replyTo ? [m.replyTo] : []);
  const reply = replyItems.length ? `<div class="reply-quote${replyItems.some((q) => q.quote) ? ' fragment' : ''}${replyItems.length > 1 ? ' multiple' : ''}" data-reply="${esc(replyItems[0].id || '')}">${replyItems.map((q) => `<span class="reply-quote-item" data-reply-id="${esc(q.id || '')}"><b>${q.quote ? 'Цитата · ' : ''}${esc(q.name || '')}</b><span>${esc(q.text || '')}</span></span>`).join('')}</div>` : '';
  const forwardFrom = m.forwardFrom || null;
  const forward = forwardFrom ? `<div class="forward-label">Переслано${forwardFrom.name ? ` от ${esc(forwardFrom.name)}` : ''}${forwardFrom.chatName ? ` · ${esc(forwardFrom.chatName)}` : ''}</div>` : '';
  const imageUrl = m.image || (m.text || '').match(IMAGE_URL_RE)?.[0] || '';
  const image = imageUrl ? `<img class="msg-image" src="${esc(imageUrl)}" alt="">` : '';
  const attachments = attachmentsHtml(m);

  const emojiN = (!m.deleted && m.text && !m.attachments?.length && !m.poll && !imageUrl && !m.replyTo && !forwardFrom) ? emojiOnly(m.text) : 0;
  const jumbo = emojiN >= 1 && emojiN <= 3;
  const textHtml = m.text
    ? `<div class="text${jumbo ? ` jumbo jumbo-${emojiN}` : ''}">${m.deleted ? esc(m.text) : formatText(m.text)}</div>`
    : '';
  const edited = m.edited && !m.deleted ? '<span class="edited">изменено</span>' : '';

  const mediaCount = (m.attachments || []).filter((x) => x.kind === 'photo' || x.kind === 'video').length;
  const mediaOnly = mediaCount > 0 && !m.text && !image && !m.replyTo && !forwardFrom
    && !(m.attachments || []).some((x) => x.kind === 'file');

  const circleOnly = (m.attachments || []).length === 1 && m.attachments[0].kind === 'circle'
    && !m.text && !m.replyTo && !forwardFrom;
  const link = m.deleted ? '' : linkCardHtml(m);
  el.innerHTML = `
    <div class="avatar" style="background:${color}">${m.channelIcon ? esc(m.channelIcon) : (m.avatar ? `<img src="${esc(m.avatar)}" alt="">` : initials(displayName))}</div>
    <div class="bubble${mediaOnly ? ' only-media' : ''}${circleOnly ? ' only-circle' : ''}${jumbo ? ' only-emoji' : ''}">
      <div class="meta" style="color:${color}">${esc(displayName)}</div>
      ${forward}
      ${reply}
      ${attachments}
      ${pollHtml(m, myName, options.myId)}
      ${textHtml}
      ${link}
      ${image}
      <div class="time">${edited}${time}${mine && !m.deleted ? statusGlyph(m) : ''}</div>
      ${reactionsHtml(m, myName, options.myId)}
    </div>`;
  if (options.onMessageClick && options.selectionMode) {
    el.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopImmediatePropagation();
      if (!el.dataset.swiped) options.onMessageClick(m.id);
    }, true);
  } else if (options.onMessageClick) {
    el.onclick = (e) => {
      if (e.target.closest('button') || el.dataset.swiped) return;
      options.onMessageClick(m.id);
    };
  }
  if (options.onMessageContext) {
    el.oncontextmenu = (e) => {
      e.preventDefault();
      options.onMessageContext(m.id, e.clientX, e.clientY);
    };
  }
  const media = (m.attachments || [])
    .filter((x) => x.kind === 'photo' || x.kind === 'video')
    .map((x) => ({ type: x.kind, src: x.data, poster: x.poster, name: x.name, size: x.size, duration: x.duration, author: m.channelName || m.name, color: m.color }));
  for (const cell of el.querySelectorAll('.media-cell')) {
    cell.onclick = (e) => {
      e.stopPropagation();
      window.Segment?.openMedia?.(media, Number(cell.dataset.media) || 0);
    };
  }
  for (const v of el.querySelectorAll('.msg-voice')) wireVoice(v);
  for (const c of el.querySelectorAll('.msg-circle')) wireCircle(c);
  for (const opt of el.querySelectorAll('.poll-opt')) {
    opt.onclick = (e) => { e.stopPropagation(); options.onVote?.(m.id, Number(opt.dataset.pollOpt)); };
  }

  for (const f of el.querySelectorAll('.msg-file')) {
    f.addEventListener('click', () => {
      f.classList.add('downloaded');
      setTimeout(() => f.classList.remove('downloaded'), 1400);
    });
  }

  for (const [index, sp] of [...el.querySelectorAll('.spoiler')].entries()) {
    const spoilerKey = `${m.id}:${index}`;
    sp.classList.toggle('revealed', revealedSpoilers.has(spoilerKey));
    sp.onclick = (e) => {
      e.stopPropagation();
      const revealed = sp.classList.toggle('revealed');
      if (revealed) revealedSpoilers.add(spoilerKey);
      else revealedSpoilers.delete(spoilerKey);
    };
  }


  const rq = el.querySelector('.reply-quote');
  if (rq && m.replyTo?.id && options.onReplyJump) {
    rq.onclick = (e) => { e.stopPropagation(); options.onReplyJump(e.target.closest('[data-reply-id]')?.dataset.replyId || m.replyTo.id); };
  }

  if (options.onQuickReaction && !m.deleted) {
    el.querySelector('.bubble')?.addEventListener('dblclick', (e) => {
      if (e.target.closest('a, button, .reply-quote, .media-cell, .msg-voice, .msg-circle')) return;
      e.preventDefault();
      options.onQuickReaction(m.id, '❤️');
    });
  }

  if (options.onReply && !m.deleted) attachSwipeReply(el, m.id, options.onReply);

  for (const btn of el.querySelectorAll('.reaction-chip')) {
    if (options.onReaction) {
      btn.onclick = (e) => { e.stopPropagation(); options.onReaction(m.id, btn.dataset.reaction); };
    }

    btn.addEventListener('mouseenter', () => showReactTip(btn));
    btn.addEventListener('mouseleave', hideReactTip);
  }
  feed.appendChild(el);
}

export function renderSystem(feed, text) {
  const el = document.createElement('div');
  el.className = 'system';
  el.textContent = text;
  feed.appendChild(el);
}

/**
  *
  *
 */
export function scrollFeedToBottom(feed) {
  feed.scrollTop = feed.scrollHeight;
  for (const m of feed.querySelectorAll('img, video')) {
    if (m.complete || m.readyState >= 1) continue;
    const bump = () => { feed.scrollTop = feed.scrollHeight; };
    m.addEventListener('load', bump, { once: true });
    m.addEventListener('loadedmetadata', bump, { once: true });
    m.addEventListener('error', bump, { once: true });
  }
}

/**
  *
  *
  *
 */
export function renderFeed(feed, chat, list, myName, options = {}) {
  const mode = options.scrollMode || 'anchor';
  let anchorId = null;
  let anchorDelta = 0;
  if (mode === 'anchor') {
    for (const el of feed.querySelectorAll('.msg')) {
      const top = el.offsetTop - feed.scrollTop;
      if (top + el.offsetHeight > 0) { anchorId = el.dataset.id; anchorDelta = top; break; }
    }
  }

  feed.innerHTML = '';
  if (!list.length) {
    const hint = chat.local ? 'Здесь будут ваши заметки' : 'Сообщений пока нет';
    feed.innerHTML = `<div class="empty">${hint}</div>`;
    return;
  }
  const opts = { ...options, animate: false };
  const unreadId = options.firstUnread || null;
  list.forEach((m) => {
    if (unreadId && m.id === unreadId && !m.system) {
      const div = document.createElement('div');
      div.className = 'unread-divider';
      div.innerHTML = '<span>Непрочитанные сообщения</span>';
      feed.appendChild(div);
    }
    m.system ? renderSystem(feed, m.text) : renderMessage(feed, m, myName, opts);
  });

  if (mode === 'bottom') {
    const divider = feed.querySelector('.unread-divider');
    if (divider) divider.scrollIntoView({ block: 'center' });
    else scrollFeedToBottom(feed);
    return;
  }
  const anchor = anchorId && feed.querySelector(`.msg[data-id="${anchorId}"]`);
  feed.scrollTop = anchor ? anchor.offsetTop - anchorDelta : feed.scrollHeight;
}

const PIN_GLYPH = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 17v5"/><path d="M9 3h6l-1 6 3 3v2H7v-2l3-3-1-6z"/></svg>';

const CLOCK_GLYPH = '<svg viewBox="0 0 24 24" width="14" height="12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>';
const SINGLE_CHECK_GLYPH = '<svg viewBox="0 0 18 16" width="14" height="12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M2 8.5l4 4 9-9"/></svg>';
const statusGlyph = (m) => {
  const readers = Object.entries(m.receipts || {}).filter(([, state]) => state === 'read').map(([name]) => name);
  const title = readers.length ? ` title="Прочитали: ${esc(readers.join(', '))}"` : '';
  if (m.status === 'failed') return '<span class="msg-status failed">!</span>';
  if (m.status === 'sending') return `<span class="msg-status sending">${CLOCK_GLYPH}</span>`;
  if (m.status === 'sent') return `<span class="msg-status sent">${SINGLE_CHECK_GLYPH}</span>`;
  if (m.status === 'read') return `<span class="msg-status read"${title}>${CHECK_GLYPH}</span>`;
  return `<span class="msg-status delivered">${CHECK_GLYPH}</span>`;
};

const MUTE_GLYPH = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M18 8a6 6 0 0 0-9.3-5"/><path d="M6 8c0 6-3 7-3 7h13"/><path d="M13.7 21a2 2 0 0 1-3.4 0"/><path d="m3 3 18 18"/></svg>';

const CHECK_GLYPH = '<svg viewBox="0 0 22 16" width="16" height="12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 8.5l4 4 8-8"/><path d="M9 12.5l.5.5 8-8"/></svg>';

const fmtTime = (ts) => new Date(ts).toLocaleTimeString('ru', { hour: '2-digit', minute: '2-digit' });


const AVATAR_COLORS = ['#e17076', '#7bc862', '#e5ca77', '#65aadd', '#a695e7', '#ee7aae', '#6ec9cb', '#f2846a'];
function avatarColor(id) {
  let h = 0;
  for (const ch of String(id)) h = ((h << 5) - h + ch.charCodeAt(0)) | 0;
  return AVATAR_COLORS[Math.abs(h) % AVATAR_COLORS.length];
}


function chatDate(ts) {
  const d = new Date(ts);
  const now = new Date();
  if (d.toDateString() === now.toDateString()) return fmtTime(ts);
  const yest = new Date(now);
  yest.setDate(now.getDate() - 1);
  if (d.toDateString() === yest.toDateString()) return 'вчера';
  if (now - d < 7 * 86400000) return d.toLocaleDateString('ru', { weekday: 'short' });
  return d.toLocaleDateString('ru', { day: '2-digit', month: '2-digit', year: '2-digit' });
}


function mediaWord(m) {
  const a = m.attachments || [];
  if (!a.length) return '';
  if (a.length > 1 && a.every((x) => x.kind === 'photo')) return `${a.length} фото`;
  if (a.length > 1) return `${a.length} вложений`;
  const k = a[0].kind;
  if (k === 'photo') return 'Фото';
  if (k === 'video') return 'Видео';
  if (k === 'voice') return 'Голосовое сообщение';
  if (k === 'circle') return 'Видеосообщение';
  return a[0].name || 'Файл';
}


function previewBody(m) {
  const media = (m.attachments || []).find((x) => x.kind === 'photo' || x.kind === 'video' || x.kind === 'circle');
  const src = media?.poster || media?.data || '';
  const thumb = src ? `<img class="chat-thumb" src="${esc(src)}" alt="">` : '';
  if (m.text) return thumb + formatText(m.text);
  if ((m.attachments || []).length) return `${thumb}<span class="chat-media">${esc(mediaWord(m))}</span>`;
  return '';
}

function chatItemHtml(c, state, selected = false) {
  const list = state.messages[c.id];
  const lastMsg = list.length ? list.at(-1) : null;
  const myName = state.self?.name;
  const outgoing = !!(lastMsg && !lastMsg.system && !lastMsg.channelName && myName && lastMsg.name === myName);


  let lastHtml;
  const typer = state.typing?.[c.id];
  if (typer) {
    lastHtml = `<span class="chat-typing">${c.type === 'dm' ? 'печатает…' : `${esc(typer)} печатает…`}</span>`;
  } else if (!lastMsg) {
    lastHtml = esc(c.local ? '' : (c.hint || 'пока пусто'));
  } else if (lastMsg.system) {
    lastHtml = esc(lastMsg.text || '');
  } else {
    const showFrom = outgoing || (c.type !== 'dm' && c.type !== 'saved');
    const who = outgoing ? 'Вы' : (lastMsg.channelName || lastMsg.name || '');
    const from = showFrom && who ? `<span class="chat-from">${esc(who)}: </span>` : '';
    lastHtml = from + previewBody(lastMsg);
  }

  const hasTime = lastMsg && Number.isFinite(new Date(lastMsg.ts).getTime());
  const time = hasTime ? chatDate(lastMsg.ts) : '';
  const check = outgoing ? `<span class="chat-check">${CHECK_GLYPH}</span>` : '';
  const unread = state.unread[c.id];
  const pinned = state.pinned?.has(c.id);
  const muted = state.muted?.has(c.id);
  const dot = state.unreadDot?.has(c.id);
  const mute = muted ? `<span class="chat-mutemark">${MUTE_GLYPH}</span>` : '';

  let meta = '';
  if (unread) meta = `<span class="badge ${muted ? 'muted' : ''}">${unread}</span>`;
  else if (dot) meta = `<span class="badge dot ${muted ? 'muted' : ''}"></span>`;
  else if (pinned) meta = `<span class="chat-pinmark">${PIN_GLYPH}</span>`;
  return `
    <div class="chat-item ${c.id === state.currentRoom ? 'active' : ''} ${pinned ? 'pinned' : ''} ${selected ? 'selected' : ''}" data-room="${c.id}" draggable="${pinned}">
      <span class="chat-select">${selected ? '✓' : ''}</span>
      <div class="chat-icon" style="background:${avatarColor(c.id)}">${c.icon || esc(initials(c.name))}</div>
      <div class="chat-info">
        <div class="chat-row">
          <div class="chat-name"><span class="chat-type-icon">${c.type === 'channel' ? '📢' : (c.type === 'chat' ? '💬' : '')}</span><span>${esc(c.name)}</span>${mute}</div>
          <span class="chat-time">${check}<span>${time}</span></span>
        </div>
        <div class="chat-row ${lastHtml ? '' : 'empty-last'}">
          <div class="chat-last">${lastHtml}</div>
          <div class="chat-meta">${meta}</div>
        </div>
      </div>
    </div>`;
}


function matchesFilter(c, filter, state) {
  if (filter === 'unread') return !!state.unread[c.id] || state.unreadDot?.has(c.id);
  if (filter === 'dm') return c.type === 'dm';
  if (filter === 'groups') return c.type === 'chat';
  if (filter === 'channels') return c.type === 'channel';
  return true; // all
}


function searchResultHtml(c, m, q) {
  const text = m.text || mediaWord(m) || '';
  const snippet = m.text ? highlightedFormattedText(text, q) : esc(text);
  return `
    <div class="chat-item search-hit" data-room="${c.id}" data-msg="${esc(m.id)}">
      <div class="chat-icon" style="background:${avatarColor(c.id)}">${c.icon || esc(initials(c.name))}</div>
      <div class="chat-info">
        <div class="chat-row">
          <div class="chat-name"><span class="chat-type-icon">${c.type === 'channel' ? '📢' : (c.type === 'chat' ? '💬' : '')}</span><span>${esc(c.name)}</span></div>
          <span class="chat-time"><span>${esc(chatDate(m.ts))}</span></span>
        </div>
        <div class="chat-row"><div class="chat-last">${esc(m.channelName || m.name || '')}${m.channelName || m.name ? ': ' : ''}${snippet}</div></div>
      </div>
    </div>`;
}



function flipChatList(el, render) {
  const before = new Map();
  for (const item of el.querySelectorAll('.chat-item[data-room]')) {
    before.set(item.dataset.room, item.getBoundingClientRect().top);
  }
  render();
  for (const item of el.querySelectorAll('.chat-item[data-room]')) {
    const prev = before.get(item.dataset.room);
    if (prev == null) continue;
    const delta = prev - item.getBoundingClientRect().top;
    if (!delta) continue;
    item.style.transform = `translateY(${delta}px)`;
    item.style.transition = 'none';
    requestAnimationFrame(() => {
      item.style.transition = 'transform .28s ease';
      item.style.transform = '';
    });
  }
}

export function renderChatList(el, state, opts = {}) {
  const { onOpen, onContext, onAvatarPreview, onOpenMessage, onReorderPinned, onToggleSelect, selected = new Set(), selectionMode = false, folderId = null, query = '', filter = 'all', showArchived = false } = opts;
  const q = query.trim().toLowerCase();
  const pinnedOrder = [...(state.pinned || [])];
  const archived = state.archived || new Set();

  const lastTs = (c) => { const l = state.messages[c.id]; return l && l.length ? (l[l.length - 1].ts || 0) : 0; };
  const folder = state.folders?.find((f) => f.id === folderId);
  const visible = state.chats.filter((c) => (showArchived ? archived.has(c.id) : !archived.has(c.id)) && (!folder || folder.chats.includes(c.id)));
  const chats = visible
    .filter((c) => matchesFilter(c, filter, state))
    .filter((c) => !q || c.name.toLowerCase().includes(q))
    .slice()
    .sort((a, b) => {
      const pa = pinnedOrder.indexOf(a.id);
      const pb = pinnedOrder.indexOf(b.id);

      if (pa !== -1 && pb !== -1) return pa - pb;
      if (pa !== -1) return -1;
      if (pb !== -1) return 1;
      return lastTs(b) - lastTs(a);
    });

  let html = '';


  if (!showArchived && !q && archived.size) {
    const unread = state.chats.reduce((n, c) => n + (archived.has(c.id) ? (state.unread[c.id] || 0) : 0), 0);
    html += `
      <div class="chat-item archive-row" data-archive="1">
        <div class="chat-icon archive-ico">📥</div>
        <div class="chat-info"><div class="chat-row"><div class="chat-name"><span>Архив</span></div>
          ${unread ? `<span class="chat-meta"><span class="badge">${unread}</span></span>` : ''}</div></div>
      </div>`;
  }

  if (q) {

    const hits = [];
    for (const c of state.chats) {
      if (archived.has(c.id) && !showArchived) continue;
      for (const m of state.messages[c.id] || []) {
        if (m.system || m.deleted) continue;
        const hay = `${m.text || ''} ${mediaWord(m)}`.toLowerCase();
        if (hay.includes(q)) hits.push([c, m]);
      }
    }
    hits.sort((a, b) => b[1].ts - a[1].ts);
    html = '';
    if (chats.length) html += '<div class="list-section">Чаты</div>' + chats.map((c) => chatItemHtml(c, state)).join('');
    if (hits.length) html += '<div class="list-section">Сообщения</div>' + hits.slice(0, 50).map(([c, m]) => searchResultHtml(c, m, q)).join('');
    if (!html) html = '<div class="chat-empty">Ничего не найдено</div>';
  } else {
    html += chats.map((c) => chatItemHtml(c, state, selected.has(c.id))).join('');
    if (!chats.length && !(!showArchived && archived.size)) {
      html = '<div class="chat-empty">Ничего не найдено</div>';
    }
  }


  if (q || showArchived) el.innerHTML = html;
  else flipChatList(el, () => { el.innerHTML = html; });

  for (const item of el.querySelectorAll('.chat-item')) {
    if (item.dataset.archive) { item.onclick = () => onOpen('__archive__'); continue; }
    if (item.dataset.msg) {
      item.onclick = () => onOpenMessage?.(item.dataset.room, item.dataset.msg);
      continue;
    }
    item.onclick = () => { if (!item.dataset.swiped) selectionMode ? onToggleSelect?.(item.dataset.room) : onOpen(item.dataset.room); };
    item.oncontextmenu = (e) => { e.preventDefault(); if (e.target.closest('.chat-icon')) onAvatarPreview?.(item.dataset.room, e.clientX, e.clientY); else onContext(item.dataset.room, e.clientX, e.clientY); };
    const avatar = item.querySelector('.chat-icon');
    if (avatar) {
      let hold;
      const cancelHold = () => { clearTimeout(hold); hold = null; };
      avatar.addEventListener('pointerdown', (e) => { if (e.pointerType === 'mouse') return; hold = setTimeout(() => { onAvatarPreview?.(item.dataset.room, e.clientX, e.clientY); item.dataset.swiped = '1'; setTimeout(() => delete item.dataset.swiped, 0); }, 520); });
      avatar.addEventListener('pointerup', cancelHold); avatar.addEventListener('pointercancel', cancelHold); avatar.addEventListener('pointermove', cancelHold);
    }
    item.ondragstart = (e) => { if (!item.classList.contains('pinned')) return e.preventDefault(); e.dataTransfer.setData('text/pinned-chat', item.dataset.room); item.classList.add('dragging'); };
    item.ondragend = () => item.classList.remove('dragging');
    item.ondragover = (e) => { if (item.classList.contains('pinned')) e.preventDefault(); };
    item.ondrop = (e) => { e.preventDefault(); const id = e.dataTransfer.getData('text/pinned-chat'); if (id && id !== item.dataset.room) onReorderPinned?.(id, item.dataset.room); };
    attachChatSwipe(item, opts);
  }
}


function attachChatSwipe(item, opts) {
  const id = item.dataset.room;
  let startX = 0, startY = 0, dx = 0, active = false, decided = false, pointerId = null;
  const onDown = (e) => {
    if (e.button != null && e.button !== 0) return;
    startX = e.clientX; startY = e.clientY; dx = 0; active = true; decided = false; pointerId = e.pointerId;
    try { item.setPointerCapture(e.pointerId); } catch {}
  };
  const onMove = (e) => {
    if (!active) return;
    const mx = e.clientX - startX, my = e.clientY - startY;
    if (!decided) {
      if (Math.abs(mx) < 10 && Math.abs(my) < 10) return;
      if (Math.abs(my) > Math.abs(mx)) { active = false; return; }
      decided = true; item.classList.add('swiping'); item.draggable = false;
    }
    dx = Math.max(-96, Math.min(96, mx));
    item.style.transform = `translateX(${dx}px)`;
    item.dataset.dir = dx < 0 ? 'archive' : 'read';
    item.style.setProperty('--sw', `${Math.min(1, Math.abs(dx) / 72)}`);
  };
  const finish = () => {
    if (!active) return;
    active = false; item.classList.remove('swiping');
    if (pointerId != null) { try { item.releasePointerCapture(pointerId); } catch {} }
    pointerId = null;
    item.style.transform = ''; item.style.removeProperty('--sw');
    if (decided && Math.abs(dx) >= 72) {
      if (dx < 0) opts.onSwipeArchive?.(id); else opts.onSwipeRead?.(id);
      item.dataset.swiped = '1'; setTimeout(() => delete item.dataset.swiped, 0);
    }
    delete item.dataset.dir;
    queueMicrotask(() => { item.draggable = item.classList.contains('pinned'); });
  };
  item.addEventListener('pointerdown', onDown);
  item.addEventListener('pointermove', onMove);
  item.addEventListener('pointerup', finish);
  item.addEventListener('pointercancel', finish);
  item.addEventListener('lostpointercapture', finish);
}

export function showTyping(typingEl, name) {
  typingEl.innerHTML = `${esc(name)} печатает <span class="dots"><span></span><span></span><span></span></span>`;
}
