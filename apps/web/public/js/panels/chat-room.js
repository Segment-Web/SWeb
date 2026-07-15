import { renderFeed, renderMessage, renderSystem, showTyping, scrollFeedToBottom } from '../ui.js';
import { esc, attachLabel, fmtSize } from '../util.js';
import { ICONS } from '../icons.js';
import { chatViewPanel } from './chat-view.js';

const TYPING_HIDE_MS = 2000;
const QUICK_REACTIONS = ['👍', '❤️', '😂', '🔥', '👏', '🥰', '😮', '😢'];

const REACTIONS_ALL = ['👍', '👎', '❤️', '🔥', '🥰', '👏', '😂', '🤣', '😍', '🤔', '🤯', '😱', '🤬', '😢', '🎉', '🤩', '🙏', '👌', '🕊', '🤡', '🥴', '😐', '🍓', '🍾', '💋', '🖕', '😈', '😴', '😭', '🤓', '👻', '💯', '🤣', '💔', '❤️‍🔥', '😀', '😃', '😄', '😉', '😊', '😎', '🥳', '😇', '🤝', '💪', '👀', '✅', '⚡'];
const EMOJIS = ['😀', '😂', '😍', '😎', '🤝', '👍', '🔥', '❤️', '🎉', '💡', '👀', '✅'];
const IMAGE_URL_RE = /(https?:\/\/\S+\.(?:png|jpe?g|gif|webp))(?:\?\S*)?/i;


const AVATAR_COLORS = ['#e17076', '#7bc862', '#e5ca77', '#65aadd', '#a695e7', '#ee7aae', '#6ec9cb', '#f2846a'];
function avatarColor(id) {
  let h = 0;
  for (const ch of String(id)) h = ((h << 5) - h + ch.charCodeAt(0)) | 0;
  return AVATAR_COLORS[Math.abs(h) % AVATAR_COLORS.length];
}


const EMOJI_MAP = {
  smile: '😄', grin: '😁', joy: '😂', rofl: '🤣', laughing: '😆', wink: '😉',
  blush: '😊', heart_eyes: '😍', kiss: '😘', cool: '😎', sunglasses: '😎',
  thinking: '🤔', neutral: '😐', unamused: '😒', cry: '😢', sob: '😭',
  angry: '😠', rage: '😡', sweat_smile: '😅', sleeping: '😴', mask: '😷',
  heart: '❤️', broken_heart: '💔', fire: '🔥', star: '⭐', sparkles: '✨',
  tada: '🎉', party: '🥳', rocket: '🚀', eyes: '👀', wave: '👋', pray: '🙏',
  clap: '👏', muscle: '💪', ok_hand: '👌', plus1: '👍', thumbsup: '👍',
  thumbsdown: '👎', point_up: '☝️', poop: '💩', skull: '💀', ghost: '👻',
  check: '✅', x: '❌', warning: '⚠️', question: '❓', bulb: '💡', gift: '🎁',
  coffee: '☕', pizza: '🍕', beer: '🍺', sun: '☀️', moon: '🌙', rainbow: '🌈',
  hundred: '💯', ok: '🆗', new: '🆕',
};


const SLASH = [
  { cmd: 'shrug', desc: 'пожать плечами', insert: '¯\\_(ツ)_/¯' },
  { cmd: 'tableflip', desc: 'перевернуть стол', insert: '(╯°□°)╯︵ ┻━┻' },
  { cmd: 'unflip', desc: 'вернуть стол', insert: '┬─┬ ノ( ゜-゜ノ)' },
  { cmd: 'lenny', desc: 'Lenny', insert: '( ͡° ͜ʖ ͡°)' },
];

/**
  *
  *
 */
function placeFloating(el, x, y, bounds) {
  const b = bounds.getBoundingClientRect();
  el.style.left = '0px';
  el.style.top = '0px';
  const w = el.offsetWidth;
  const h = el.offsetHeight;
  const pad = 8;
  let left = x - b.left;
  let top = y - b.top;
  if (left + w > b.width - pad) left = Math.max(pad, (x - b.left) - w);
  if (top + h > b.height - pad) top = Math.max(pad, (y - b.top) - h);
  el.style.left = `${Math.max(pad, Math.min(left, b.width - w - pad))}px`;
  el.style.top = `${Math.max(pad, Math.min(top, b.height - h - pad))}px`;
}

function stableNumber(seed, min, max) {
  let hash = 0;
  for (const ch of seed) hash = ((hash << 5) - hash) + ch.charCodeAt(0);
  return min + (Math.abs(hash) % (max - min + 1));
}

function chatStatus(chat, client) {
  if (!chat || chat.local) return { text: '', online: false };
  if (chat.type === 'channel') {
    const n = chat.subscribers || stableNumber(chat.id, 120000, 130000);
    return { text: `${n.toLocaleString('ru-RU')} подписчиков`, online: false };
  }
  if (chat.type === 'dm') {
    const online = client.online?.length > 0;
    return { text: online ? 'в сети' : 'был(а) в сети 1 час назад', online };
  }
  const members = chat.members || stableNumber(chat.id, 7, 16);
  const online = Math.max(1, Math.min(members, client.online?.length || 1));
  return { text: `${members} участников, ${online} в сети`, online: false };
}

export function chatRoomPanel(client) {
  return {
    id: 'chat-room',
    title: 'Чат',
    mount(body) {
      body.innerHTML = `
        <div class="room">
          <header class="room-head" data-el="head">
            <div class="room-avatar" data-el="avatar">💬</div>
            <div class="room-headinfo">
              <div class="room-title" data-el="title">Общий</div>
              <div class="room-status" data-el="status">подключение...</div>
            </div>
            <button class="room-head-action" data-el="roomSearchOpen" title="Поиск в чате" aria-label="Поиск в чате">${ICONS.search}</button>
          </header>
          <div class="room-searchbar hidden" data-el="roomSearchBar">
            ${ICONS.search}<input data-el="roomSearchInput" placeholder="Поиск в этом чате" autocomplete="off">
            <span data-el="roomSearchCount">0 из 0</span>
            <button data-el="roomSearchPrev" title="Предыдущее">‹</button><button data-el="roomSearchNext" title="Следующее">›</button>
            <button data-el="roomSearchClose" title="Закрыть">${ICONS.close}</button>
          </div>
          <button class="pinned-bar hidden" data-el="pinnedBar"></button>
          <div class="selection-bar hidden" data-el="selectionBar"></div>
          <main class="feed" data-el="feed"></main>
          <button class="scroll-down hidden" data-el="scrollDown" title="Вниз" aria-label="Вниз">
            <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 5v14"/><path d="m19 12-7 7-7-7"/></svg>
            <span class="sd-badge hidden" data-el="scrollBadge"></span>
          </button>
          <div class="typing" data-el="typing"></div>
          <footer class="composer">
            <div class="reply-draft hidden" data-el="replyDraft"><b></b><span></span><button data-el="replyCancel" title="Отменить">×</button></div>
            <div class="attach-draft hidden" data-el="attachDraft"></div>
            <div class="autocomplete hidden" data-el="autocomplete"></div>
            <div class="composer-format" data-el="format">
              <div class="fmt-group fmt-history" aria-label="История изменений">
                <button type="button" class="fmt-btn" data-command="undo" title="Отменить · Ctrl+Z" aria-label="Отменить">
                  <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="m9 7-5 5 5 5"/><path d="M20 17a7 7 0 0 0-7-7H4"/></svg>
                </button>
                <button type="button" class="fmt-btn" data-command="redo" title="Повторить · Ctrl+Y" aria-label="Повторить">
                  <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="m15 7 5 5-5 5"/><path d="M4 17a7 7 0 0 1 7-7h9"/></svg>
                </button>
              </div>
              <span class="fmt-divider" aria-hidden="true"></span>
              <div class="fmt-group" aria-label="Форматирование текста">
              <button type="button" class="fmt-btn" data-fmt="B" title="Жирный · Ctrl+B"><b>B</b></button>
              <button type="button" class="fmt-btn" data-fmt="I" title="Курсив · Ctrl+I"><i>i</i></button>
              <button type="button" class="fmt-btn" data-fmt="S" title="Зачёркнутый · Ctrl+S"><s>S</s></button>
              <button type="button" class="fmt-btn mono" data-fmt="CODE" title="Моноширинный · Ctrl+E">&lt;/&gt;</button>
              <button type="button" class="fmt-btn" data-fmt="SPOILER" title="Спойлер">
                <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7Z"/><circle cx="12" cy="12" r="2.5"/></svg>
              </button>
              </div>
              <span class="fmt-divider" aria-hidden="true"></span>
              <div class="fmt-group">
                <button type="button" class="fmt-btn fmt-clear" data-command="clear" title="Убрать форматирование" aria-label="Убрать форматирование">Aa</button>
              </div>
            </div>
            <div class="composer-main">
            <div class="composer-field">
              <div class="attach-wrap" data-el="attachWrap">
                <button class="composer-tool" data-el="attach" title="Прикрепить" aria-label="Прикрепить">
                  <svg viewBox="0 0 24 24" width="21" height="21" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M21.4 11.6 12 21a6 6 0 0 1-8.5-8.5l10-10a4 4 0 1 1 5.7 5.7L9.6 17.8a2 2 0 0 1-2.8-2.8l8.9-8.9"/></svg>
                </button>
                <div class="attach-menu hidden" data-el="attachMenu">
                  <button data-att="photo"><svg viewBox="0 0 24 24" width="19" height="19" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="14" rx="2"/><circle cx="8.5" cy="9" r="1.5"/><path d="m21 15-5-5L5 20"/></svg><span>Фото или видео</span></button>
                  <button data-att="file"><svg viewBox="0 0 24 24" width="19" height="19" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/></svg><span>Файл</span></button>
                  <button data-att="poll"><svg viewBox="0 0 24 24" width="19" height="19" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 20V10M10 20V4M16 20v-7M22 20H2"/></svg><span>Опрос</span></button>
                </div>
              </div>
              <div class="composer-input" data-el="input" contenteditable="true" role="textbox" aria-multiline="true" data-placeholder="Сообщение..."></div>
              <button class="composer-tool" data-el="emoji" title="Эмодзи" aria-label="Эмодзи">
                <svg viewBox="0 0 24 24" width="21" height="21" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M8.5 10h.01"/><path d="M15.5 10h.01"/><path d="M8.2 14.2c.9 1.2 2.2 1.8 3.8 1.8s2.9-.6 3.8-1.8"/></svg>
              </button>
              <input class="file-input" data-el="file" type="file" multiple>
            </div>
            <div class="composer-actions">
              <div class="rec-lock hidden" data-el="recLock">
                <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/></svg>
                <span class="rec-lock-arrow">⌃</span>
              </div>
              <button class="composer-round rec-btn" data-el="rec" data-mode="voice" title="Тап — режим, зажать — запись" aria-label="Запись">
                <span class="rec-ico ico-voice"><svg viewBox="0 0 24 24" width="21" height="21" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="2.5" width="6" height="11.5" rx="3"/><path d="M5.5 11a6.5 6.5 0 0 0 13 0"/><path d="M12 17.5V21"/></svg></span>
                <span class="rec-ico ico-video"><svg viewBox="0 0 24 24" width="21" height="21" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M15 10.5 20.2 7a.6.6 0 0 1 .9.5v9a.6.6 0 0 1-.9.5L15 13.5z"/><rect x="3" y="6" width="12" height="12" rx="3.5"/></svg></span>
              </button>
              <button class="composer-round primary hidden" data-el="send" title="Отправить" aria-label="Отправить">
                <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M21.5 2.5 11 13"/><path d="M21.5 2.5 15 21.5l-4-8.5-8.5-4z"/></svg>
              </button>
            </div>
            </div>
            <div class="rec-bar hidden" data-el="recBar"></div>
            <div class="circle-rec hidden" data-el="circleRec"></div>
          </footer>
          <div class="msg-menu hidden" data-el="msgMenu"></div>
          <div class="emoji-menu hidden" data-el="emojiMenu"></div>
          <div class="chat-sheet hidden" data-el="sheet"></div>
          <div class="poll-compose hidden" data-el="pollCompose"></div>
          <div class="pinned-manager hidden" data-el="pinnedManager"></div>
          <button class="selection-quote hidden" data-el="selectionQuote">${ICONS.reply}<span>Цитировать</span></button>
        </div>`;

      const q = (name) => body.querySelector(`[data-el="${name}"]`);
      const roomEl = body.querySelector('.room');
      const feed = q('feed');
      const avatarEl = q('avatar');
      const titleEl = q('title');
      const statusEl = q('status');
      const typingEl = q('typing');
      const selectionBar = q('selectionBar');
      const input = q('input');
      const formatBar = q('format');

      // --- Rich composer: contenteditable that renders inline formatting and
      // serializes back to the markdown wire format (**b** __i__ ~~s~~ `c` ||spoiler||). ---
      const domToMarkdown = (node) => {
        let out = '';
        for (const n of node.childNodes) {
          if (n.nodeType === 3) { out += n.nodeValue; continue; }
          if (n.nodeName === 'BR') { out += '\n'; continue; }
          const inner = domToMarkdown(n);
          if (n.nodeName === 'B' || n.nodeName === 'STRONG') out += `**${inner}**`;
          else if (n.nodeName === 'I' || n.nodeName === 'EM') out += `__${inner}__`;
          else if (n.nodeName === 'S' || n.nodeName === 'STRIKE' || n.nodeName === 'DEL') out += `~~${inner}~~`;
          else if (n.nodeName === 'CODE') out += `\`${inner}\``;
          else if (n.classList && n.classList.contains('spoiler')) out += `||${inner}||`;
          else if (n.nodeName === 'DIV' || n.nodeName === 'P') out += (out && !out.endsWith('\n') ? '\n' : '') + inner;
          else out += inner;
        }
        return out;
      };
      const markdownToHtml = (md) => {
        let s = esc(md);
        s = s.replace(/`([^`\n]+?)`/g, '<code>$1</code>');
        s = s.replace(/\|\|([\s\S]+?)\|\|/g, '<span class="spoiler" data-spoiler>$1</span>');
        s = s.replace(/\*\*([^*\n]+?)\*\*/g, '<b>$1</b>');
        s = s.replace(/__([^_\n]+?)__/g, '<i>$1</i>');
        s = s.replace(/~~([^~\n]+?)~~/g, '<s>$1</s>');
        return s.replace(/\n/g, '<br>');
      };
      Object.defineProperty(input, 'value', {
        get() { return domToMarkdown(this).replace(/\n$/, ''); },
        set(md) { this.innerHTML = md ? markdownToHtml(String(md)) : ''; syncFormatState(); },
      });
      Object.defineProperty(input, 'placeholder', {
        get() { return this.dataset.placeholder || ''; },
        set(v) { this.dataset.placeholder = v; },
      });
      const FMT = { B: 'b', I: 'i', S: 's', CODE: 'code', SPOILER: 'spoiler' };
      const fmtAncestor = (node, kind) => {
        for (let el = node; el && el !== input; el = el.parentNode) {
          if (el.nodeType !== 1) continue;
          if (kind === 'SPOILER') { if (el.classList.contains('spoiler')) return el; }
          else if (el.nodeName === FMT[kind].toUpperCase()) return el;
        }
        return null;
      };
      const syncFormatState = () => {
        const sel = window.getSelection();
        const node = sel && sel.rangeCount && input.contains(sel.anchorNode) ? sel.anchorNode : null;
        for (const btn of formatBar.querySelectorAll('[data-fmt]')) {
          btn.classList.toggle('active', !!(node && fmtAncestor(node, btn.dataset.fmt)));
        }
      };
      const unwrap = (el) => {
        const parent = el.parentNode;
        while (el.firstChild) parent.insertBefore(el.firstChild, el);
        parent.removeChild(el);
        parent.normalize();
      };
      const applyFormat = (kind) => {
        input.focus();
        const sel = window.getSelection();
        if (!sel.rangeCount) return;
        const range = sel.getRangeAt(0);
        if (!input.contains(range.commonAncestorContainer)) return;
        // A selection can report the container (not a text node) as its boundary
        // when it spans a whole formatted run, so probe both ends and the common ancestor.
        let existing = fmtAncestor(range.startContainer, kind)
          || fmtAncestor(range.endContainer, kind)
          || fmtAncestor(range.commonAncestorContainer, kind);
        if (!existing && !range.collapsed) {
          const only = range.cloneContents();
          if (only.childNodes.length === 1 && fmtAncestor(only.firstChild, kind) === null) {
            const single = only.firstChild;
            if (single.nodeType === 1 && (kind === 'SPOILER'
              ? single.classList?.contains('spoiler')
              : single.nodeName === FMT[kind].toUpperCase())) {
              // whole selection is one formatted run living directly under a boundary node
              for (const el of input.querySelectorAll(kind === 'SPOILER' ? '.spoiler' : FMT[kind])) {
                if (range.intersectsNode(el) && range.toString() === el.textContent) { existing = el; break; }
              }
            }
          }
        }
        if (existing) { unwrap(existing); }
        else {
          if (range.collapsed) return;
          const wrap = kind === 'SPOILER'
            ? Object.assign(document.createElement('span'), { className: 'spoiler' })
            : document.createElement(FMT[kind]);
          if (kind === 'SPOILER') wrap.dataset.spoiler = '';
          try { range.surroundContents(wrap); }
          catch { wrap.appendChild(range.extractContents()); range.insertNode(wrap); }
          sel.removeAllRanges();
          const r = document.createRange(); r.selectNodeContents(wrap); sel.addRange(r);
        }
        input.dispatchEvent(new Event('input'));
        syncFormatState();
      };

      const msgMenu = q('msgMenu');
      const sheet = q('sheet');
      const emojiMenu = q('emojiMenu');
      const replyDraft = q('replyDraft');
      const replyCancel = q('replyCancel');
      const attachDraft = q('attachDraft');
      const head = q('head');
      const attachBtn = q('attach');
      const emojiBtn = q('emoji');
      const fileInput = q('file');
      const recBtn = q('rec');
      const recLock = q('recLock');
      const sendBtn = q('send');
      const recBar = q('recBar');
      const circleRec = q('circleRec');
      const pinnedBar = q('pinnedBar');
      const roomSearchOpen = q('roomSearchOpen');
      const roomSearchBar = q('roomSearchBar');
      const roomSearchInput = q('roomSearchInput');
      const roomSearchCount = q('roomSearchCount');
      const scrollDown = q('scrollDown');
      const scrollBadge = q('scrollBadge');
      const acEl = q('autocomplete');
      const attachWrap = q('attachWrap');
      const attachMenu = q('attachMenu');
      const pollCompose = q('pollCompose');
      const pinnedManager = q('pinnedManager');
      const selectionQuote = q('selectionQuote');

      // Attachments no longer travel over the WebSocket relay: they are encrypted
      // and uploaded to the blob store over HTTP, so the old 12MB relay-era cap
      // was silently rejecting ordinary files and videos. The ceiling is now the
      // blob store's; it is kept below the server's 100MB so the browser never
      // has to hold an enormous base64 data url in memory.
      const MAX_ATTACH = 50 * 1024 * 1024;
      const MAX_ATTACH_LABEL = '50 МБ';
      let typingTimer;
      let currentChat = client.chatById(client.currentRoom);
      let replyTo = null;
      let pinnedIndex = 0;
      let pinnedRoomId = null;
      let roomSearchIds = [];
      let roomSearchIndex = -1;
      let selectionQuoteData = null;
      let pending = [];
      let processing = 0;
      let awayCount = 0;
      const drafts = {};
      const selected = new Set();


      let acItems = [];   // [{ label, hint, apply }]
      let acIndex = 0;
      let acToken = null; // { start, end }

      const acClose = () => { acItems = []; acToken = null; acEl.classList.add('hidden'); acEl.innerHTML = ''; };

      const acRender = () => {
        if (!acItems.length) { acClose(); return; }
        acIndex = Math.max(0, Math.min(acIndex, acItems.length - 1));
        acEl.innerHTML = acItems.map((it, i) =>
          `<button class="ac-item ${i === acIndex ? 'active' : ''}" data-i="${i}">
             <span class="ac-ico">${it.icon}</span>
             <span class="ac-label">${it.label}</span>
             ${it.hint ? `<span class="ac-hint">${it.hint}</span>` : ''}
           </button>`).join('');
        acEl.classList.remove('hidden');
        for (const btn of acEl.querySelectorAll('.ac-item')) {
          btn.onmousedown = (e) => { e.preventDefault(); acApply(Number(btn.dataset.i)); };
        }
      };

      const acApply = (i) => {
        const it = acItems[i];
        if (!it || !acToken) return;
        const { node, start, end } = acToken;
        node.nodeValue = node.nodeValue.slice(0, start) + it.value + node.nodeValue.slice(end);
        const caret = start + it.value.length;
        const sel = window.getSelection();
        const r = document.createRange();
        r.setStart(node, Math.min(caret, node.nodeValue.length));
        r.collapse(true);
        sel.removeAllRanges(); sel.addRange(r);
        acClose();
        syncActions();
        if (currentChat) drafts[currentChat.id] = input.value;
        input.focus();
      };


      const chatMembers = () => {
        const set = new Set((client.online || []).map((u) => u.name));
        for (const m of client.messages[currentChat?.id] || []) if (!m.system && m.name) set.add(m.name);
        set.delete(client.self.name);
        return [...set];
      };

      const acUpdate = () => {
        const sel = window.getSelection();
        if (!sel.rangeCount || !sel.isCollapsed || !input.contains(sel.anchorNode) || sel.anchorNode.nodeType !== 3) { acClose(); return; }
        const node = sel.anchorNode;
        const caret = sel.anchorOffset;
        const before = node.nodeValue.slice(0, caret);
        const atStart = node === input.firstChild;
        let mt;

        if (atStart && (mt = /^\/(\w*)$/.exec(before))) {
          const q2 = mt[1].toLowerCase();
          acToken = { node, start: 0, end: caret };
          acItems = SLASH.filter((s) => s.cmd.startsWith(q2)).map((s) => ({
            icon: '/', label: `/${s.cmd}`, hint: s.desc, value: s.insert,
          }));
        } else if ((mt = /(^|\s)@(\w{0,20})$/.exec(before))) {
          const q2 = mt[2].toLowerCase();
          acToken = { node, start: caret - mt[2].length - 1, end: caret };
          acItems = chatMembers().filter((n) => n.toLowerCase().startsWith(q2)).slice(0, 6).map((n) => ({
            icon: n[0].toUpperCase(), label: n, hint: '', value: `@${n} `,
          }));
        } else if ((mt = /(^|\s):([a-z0-9_+]{2,30})$/.exec(before))) {
          const q2 = mt[2].toLowerCase();
          acToken = { node, start: caret - mt[2].length - 1, end: caret };
          acItems = Object.entries(EMOJI_MAP).filter(([k]) => k.startsWith(q2)).slice(0, 8).map(([k, e]) => ({
            icon: e, label: `:${k}:`, hint: '', value: `${e} `,
          }));
        } else { acClose(); return; }
        acIndex = 0;
        acRender();
      };

      const acKeydown = (e) => {
        if (acEl.classList.contains('hidden') || !acItems.length) return false;
        if (e.key === 'ArrowDown') { acIndex = (acIndex + 1) % acItems.length; acRender(); }
        else if (e.key === 'ArrowUp') { acIndex = (acIndex - 1 + acItems.length) % acItems.length; acRender(); }
        else if (e.key === 'Enter' || e.key === 'Tab') { acApply(acIndex); }
        else if (e.key === 'Escape') { acClose(); }
        else return false;
        e.preventDefault();
        return true;
      };


      const renderPoll = (optionCount = 2) => {
        pollCompose.innerHTML = `
          <div class="poll-box">
            <div class="poll-box-head"><b>Новый опрос</b><button data-act="close" title="Закрыть">✕</button></div>
            <input class="poll-question" placeholder="Вопрос" maxlength="120">
            <div class="poll-options-edit">
              ${Array.from({ length: optionCount }, (_, i) => `<input class="poll-option" placeholder="Вариант ${i + 1}" maxlength="80">`).join('')}
            </div>
            <button class="poll-add" data-act="add">＋ Добавить вариант</button>
            <div class="poll-box-foot">
              <button data-act="cancel">Отмена</button>
              <button class="poll-create" data-act="create">Создать</button>
            </div>
          </div>`;
        const close = () => { pollCompose.classList.add('hidden'); pollCompose.innerHTML = ''; };
        pollCompose.querySelector('[data-act="close"]').onclick = close;
        pollCompose.querySelector('[data-act="cancel"]').onclick = close;
        pollCompose.querySelector('[data-act="add"]').onclick = () => {
          const opts = [...pollCompose.querySelectorAll('.poll-option')].map((i) => i.value);
          if (opts.length >= 10) return;
          const q2 = pollCompose.querySelector('.poll-question').value;
          renderPoll(opts.length + 1);
          pollCompose.querySelector('.poll-question').value = q2;
          [...pollCompose.querySelectorAll('.poll-option')].forEach((inp, i) => { if (opts[i] != null) inp.value = opts[i]; });
          pollCompose.querySelectorAll('.poll-option')[opts.length]?.focus();
        };
        pollCompose.querySelector('[data-act="create"]').onclick = () => {
          const question = pollCompose.querySelector('.poll-question').value;
          const opts = [...pollCompose.querySelectorAll('.poll-option')].map((i) => i.value);
          if (client.sendPoll(currentChat.id, question, opts)) close();
          else window.Segment?.toast?.('Нужен вопрос и минимум 2 варианта');
        };
        pollCompose.classList.remove('hidden');
        pollCompose.querySelector('.poll-question').focus();
      };
      const openPoll = () => { if (currentChat && !currentChat.local) renderPoll(2); else if (currentChat) window.Segment?.toast?.('Опрос — только в чатах'); };

      const nearBottom = () => feed.scrollHeight - feed.scrollTop - feed.clientHeight < 120;
      const updateScrollDown = () => {
        const show = !nearBottom() && !!currentChat;
        scrollDown.classList.toggle('hidden', !show);
        if (!show) { awayCount = 0; }
        scrollBadge.classList.toggle('hidden', awayCount <= 0);
        if (awayCount > 0) scrollBadge.textContent = awayCount > 99 ? '99+' : awayCount;
      };

      const kindOf = (mime) => (mime.startsWith('image/') ? 'photo' : mime.startsWith('video/') ? 'video' : 'file');

      const toDataUrl = (file) => new Promise((resolve) => {
        const r = new FileReader();
        r.onload = () => resolve(r.result);
        r.onerror = () => resolve(null);
        r.readAsDataURL(file);
      });


      const videoMeta = (file) => new Promise((resolve) => {
        const url = URL.createObjectURL(file);
        const v = document.createElement('video');
        v.preload = 'metadata'; v.muted = true; v.playsInline = true; v.src = url;
        const done = (meta) => { URL.revokeObjectURL(url); resolve(meta); };
        v.onloadedmetadata = () => { try { v.currentTime = Math.min(0.1, (v.duration || 1) / 2); } catch { done({}); } };
        v.onseeked = () => {
          try {
            const w = Math.min(v.videoWidth || 640, 640);
            const scale = w / (v.videoWidth || w);
            const c = document.createElement('canvas');
            c.width = w; c.height = Math.round((v.videoHeight || 360) * scale);
            c.getContext('2d').drawImage(v, 0, 0, c.width, c.height);
            done({ poster: c.toDataURL('image/jpeg', 0.7), duration: v.duration, w: v.videoWidth, h: v.videoHeight });
          } catch { done({ duration: v.duration }); }
        };
        v.onerror = () => done({});
      });


      const imageMeta = (dataUrl) => new Promise((resolve) => {
        const img = new Image();
        img.onload = () => resolve({ w: img.naturalWidth, h: img.naturalHeight });
        img.onerror = () => resolve({});
        img.src = dataUrl;
      });

      const readFile = async (file) => {
        const kind = kindOf(file.type);
        const data = await toDataUrl(file);
        if (!data) return null;
        const att = { kind, name: file.name, size: file.size, mime: file.type, data };
        if (kind === 'video') Object.assign(att, await videoMeta(file));
        else if (kind === 'photo') Object.assign(att, await imageMeta(data));
        return att;
      };


      const syncActions = () => {
        const hasContent = input.value.trim().length > 0 || pending.length > 0;
        sendBtn.classList.toggle('hidden', !hasContent);
        recBtn.classList.toggle('hidden', hasContent || !!recSession);
      };

      const renderAttachDraft = () => {
        syncActions();
        attachDraft.classList.toggle('hidden', !pending.length && !processing);
        if (!pending.length && !processing) { attachDraft.innerHTML = ''; return; }
        const chips = pending.map((a, i) => `
          <div class="attach-chip ${a.kind}">
            ${a.kind === 'photo'
              ? `<img src="${a.data}" alt="">`
              : a.kind === 'video'
                ? `<span class="attach-thumb">${a.poster ? `<img src="${a.poster}" alt="">` : ''}<span class="attach-play">▶</span></span>`
                : '<span class="attach-doc">📎</span>'}
            ${a.kind === 'photo' ? '' : `<span class="attach-chip-name">${esc(a.name || 'Файл')}</span>`}
            <button data-remove="${i}" title="Убрать">×</button>
          </div>`).join('');
        const spinner = processing
          ? `<div class="attach-chip processing"><span class="attach-spinner"></span><span class="attach-chip-name">обработка ${processing}…</span></div>`
          : '';
        attachDraft.innerHTML = chips + spinner;
        for (const btn of attachDraft.querySelectorAll('[data-remove]')) {
          btn.onclick = () => { pending.splice(Number(btn.dataset.remove), 1); renderAttachDraft(); };
        }
      };


      const addFiles = async (files) => {
        const list = [...files];
        if (!list.length) return;
        processing += list.length;
        renderAttachDraft();
        for (const file of list) {
          if (file.size > MAX_ATTACH) {
            window.Segment?.toast?.(`«${file.name}» больше ${MAX_ATTACH_LABEL} — пропущено`);
            processing--;
            continue;
          }
          const att = await readFile(file);
          processing--;
          if (att) pending.push(att);
          renderAttachDraft();
        }
        processing = 0;
        renderAttachDraft();
        input.focus();
      };


      const fmtClock = (s) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;


      const computeWaveform = async (blob) => {
        try {
          const AC = window.AudioContext || window.webkitAudioContext;
          const ctx = new AC();
          const audio = await ctx.decodeAudioData(await blob.arrayBuffer());
          const data = audio.getChannelData(0);
          const N = 28; const block = Math.floor(data.length / N) || 1; const peaks = [];
          for (let i = 0; i < N; i++) {
            let max = 0;
            for (let j = 0; j < block; j++) { const v = Math.abs(data[i * block + j] || 0); if (v > max) max = v; }
            peaks.push(max);
          }
          ctx.close();
          const norm = Math.max(...peaks) || 1;
          return peaks.map((p) => +(p / norm).toFixed(3));
        } catch { return []; }
      };


      let recMode = 'voice';           // 'voice' | 'video'
      let recSession = null;           // { rec, stream, chunks, start, kind, locked, timer, canceled }
      let recStarting = false;
      let holdTimer = null;
      let holdY = 0, holdX = 0, pressPointer = null;
      let recStartRequested = false;

      const setRecMode = (mode) => {
        recMode = mode;
        recBtn.dataset.mode = mode;
        recBtn.classList.add('mode-swap');
        setTimeout(() => recBtn.classList.remove('mode-swap'), 300);
      };
      const toggleRecMode = () => setRecMode(recMode === 'voice' ? 'video' : 'voice');


      const renderRecBar = () => {
        if (!recSession) { recBar.classList.add('hidden'); recBar.innerHTML = ''; return; }
        const secs = Math.floor((Date.now() - recSession.start) / 1000);
        const kindWord = recSession.kind === 'video' ? 'видео' : 'голосовое';
        recBar.classList.remove('hidden');
        if (recSession.locked) {
          recBar.innerHTML = `
            <span class="rec-dot"></span>
            <span class="rec-time">${fmtClock(secs)}</span>
            <span class="rec-hint">запись ${kindWord}…</span>
            <button data-act="cancel" class="rec-cancel" title="Отмена">✕</button>
            <button data-act="send" class="rec-send">Отправить</button>`;
          recBar.querySelector('[data-act="cancel"]').onclick = () => finishRecord(false);
          recBar.querySelector('[data-act="send"]').onclick = () => finishRecord(true);
        } else {
          recBar.innerHTML = `
            <span class="rec-dot"></span>
            <span class="rec-time">${fmtClock(secs)}</span>
            <span class="rec-hint slide">‹ отпустите вверх — блокировка, в сторону — отмена</span>`;
        }
      };

      const beginRecord = async () => {
        if (!currentChat || currentChat.local || recSession || recStarting) return;
        if (!navigator.mediaDevices?.getUserMedia) { window.Segment?.toast?.('Запись недоступна'); return; }
        const kind = recMode;
        recStarting = true;
        let stream;
        try {
          stream = await navigator.mediaDevices.getUserMedia(
            kind === 'video' ? { video: { width: 480, height: 480, facingMode: 'user' }, audio: true } : { audio: true });
        } catch { recStarting = false; window.Segment?.toast?.(kind === 'video' ? 'Нет доступа к камере' : 'Нет доступа к микрофону'); return; }

        if (!pressPointer && !recStartRequested) { stream.getTracks().forEach((t) => t.stop()); recStarting = false; return; }
        const rec = new MediaRecorder(stream, kind === 'video' && MediaRecorder.isTypeSupported('video/webm') ? { mimeType: 'video/webm' } : undefined);
        const chunks = []; rec.ondataavailable = (e) => chunks.push(e.data);
        recSession = { rec, stream, chunks, start: Date.now(), kind, locked: false, canceled: false };
        rec.start();
        recStarting = false;
        recBtn.classList.add('recording');
        recLock.classList.remove('hidden');
        if (kind === 'video') {
          circleRec.classList.remove('hidden');
          circleRec.innerHTML = '<div class="circle-rec-inner"><video class="circle-rec-video" autoplay muted playsinline></video></div>';
          circleRec.querySelector('video').srcObject = stream;
        }
        renderRecBar();
        recSession.timer = setInterval(() => {
          if (!recSession) return;
          if ((Date.now() - recSession.start) / 1000 >= 60) finishRecord(true);
          else renderRecBar();
        }, 250);
        syncActions();
      };

      const lockRecord = () => {
        if (!recSession || recSession.locked) return;
        recSession.locked = true;
        recBtn.classList.remove('recording');
        recLock.classList.add('hidden');
        renderRecBar();
      };

      const finishRecord = async (send) => {
        if (!recSession) return;
        const { rec, stream, chunks, start, kind, timer } = recSession;
        clearInterval(timer);
        const dur = (Date.now() - start) / 1000;
        let poster = '';
        if (kind === 'video') {
          try {
            const v = circleRec.querySelector('video');
            const c = document.createElement('canvas'); c.width = 240; c.height = 240;
            c.getContext('2d').drawImage(v, 0, 0, 240, 240);
            poster = c.toDataURL('image/jpeg', 0.7);
          } catch {}
        }
        const done = new Promise((res) => (rec.onstop = res));
        try { rec.stop(); } catch {}
        await done;
        stream.getTracks().forEach((t) => t.stop());
        const room = currentChat?.id;
        recSession = null;
        recBtn.classList.remove('recording');
        recLock.classList.add('hidden');
        recBar.classList.add('hidden'); recBar.innerHTML = '';
        circleRec.classList.add('hidden'); circleRec.innerHTML = '';
        syncActions();
        if (!send || dur < 0.4 || !room) return;
        const blob = new Blob(chunks, { type: rec.mimeType || (kind === 'video' ? 'video/webm' : 'audio/webm') });
        const data = await toDataUrl(blob);
        if (kind === 'video') {
          client.sendAttachments(room, [{ kind: 'circle', name: 'circle.webm', size: blob.size, mime: blob.type, data, duration: dur, poster }], '');
        } else {
          const waveform = await computeWaveform(blob);
          client.sendAttachments(room, [{ kind: 'voice', name: 'voice.webm', size: blob.size, mime: blob.type, data, duration: dur, waveform }], '');
        }
      };

      const hideMenus = () => {
        msgMenu.classList.add('hidden');
        sheet.classList.add('hidden');
        emojiMenu.classList.add('hidden');
        pinnedManager.classList.add('hidden');
      };

      const messageById = (id) => client.messages[currentChat?.id]?.find((m) => m.id === id);
      const imageFromMessage = (message) => message?.image || (message?.text || '').match(IMAGE_URL_RE)?.[0] || '';
      const selectedMessages = () => [...selected].map((id) => messageById(id)).filter((m) => m && !m.system && !m.deleted);
      const toggleSelected = (id) => {
        if (selected.has(id)) selected.delete(id);
        else selected.add(id);
        renderRoom(currentChat, client.messages[currentChat.id] || []);
      };
      const jumpToMessage = (id) => {
        const el = feed.querySelector(`.msg[data-id="${id}"]`);
        if (!el) return;
        el.scrollIntoView({ block: 'center', behavior: 'smooth' });
        el.classList.remove('flash');
        void el.offsetWidth;
        el.classList.add('flash');
      };

      const updateRoomSearch = (step = 0) => {
        for (const el of feed.querySelectorAll('.msg.search-hit')) el.classList.remove('search-hit');
        const query = roomSearchInput.value.trim().toLocaleLowerCase('ru');
        roomSearchIds = query && currentChat ? (client.messages[currentChat.id] || [])
          .filter((m) => !m.system && !m.deleted && (m.text || '').toLocaleLowerCase('ru').includes(query))
          .map((m) => m.id) : [];
        if (!roomSearchIds.length) roomSearchIndex = -1;
        else if (step) roomSearchIndex = (roomSearchIndex + step + roomSearchIds.length) % roomSearchIds.length;
        else roomSearchIndex = Math.min(Math.max(0, roomSearchIndex), roomSearchIds.length - 1);
        roomSearchCount.textContent = roomSearchIds.length ? `${roomSearchIndex + 1} из ${roomSearchIds.length}` : '0 из 0';
        for (const id of roomSearchIds) feed.querySelector(`.msg[data-id="${id}"]`)?.classList.add('search-hit');
        if (roomSearchIndex >= 0) jumpToMessage(roomSearchIds[roomSearchIndex]);
      };
      const openRoomSearch = () => { if (!currentChat) return; roomSearchBar.classList.remove('hidden'); roomSearchInput.focus(); roomSearchInput.select(); updateRoomSearch(); };
      const closeRoomSearch = () => { roomSearchBar.classList.add('hidden'); roomSearchInput.value = ''; roomSearchIds = []; roomSearchIndex = -1; updateRoomSearch(); };

      const feedOptions = () => ({
        onMessageContext: openMessageMenu,
        onReaction: (id, emoji) => client.toggleReaction(currentChat.id, id, emoji),
        onQuickReaction: (id, emoji) => client.toggleReaction(currentChat.id, id, emoji),
        onVote: (id, opt) => client.votePoll(currentChat.id, id, opt),
        onReply: (id) => setReply(messageById(id)),
        onReplyJump: jumpToMessage,
        onMessageClick: (id) => { if (selected.size) toggleSelected(id); },
        isSelected: (id) => selected.has(id),
      });

      const renderReplyDraft = () => {
        replyDraft.classList.toggle('hidden', !replyTo);
        if (!replyTo) return;
        const quotes = replyTo.quotes || [replyTo];
        replyDraft.querySelector('b').textContent = quotes.length > 1 ? `${quotes.length} цитаты` : (replyTo.name || '');
        replyDraft.querySelector('span').textContent = quotes.map((q) => q.text || '').join(' · ');
      };

      const setReply = (message, quote = '', append = false) => {
        if (!message || message.deleted) replyTo = null;
        else {
          const next = { id: message.id, name: message.name, text: quote || message.text, quote: Boolean(quote) };
          const existing = append && replyTo ? (replyTo.quotes || [replyTo]) : [];
          const quotes = [...existing, next].filter((q, i, all) => all.findIndex((x) => x.id === q.id && x.text === q.text) === i).slice(0, 8);
          replyTo = quotes.length > 1 ? { ...quotes[0], quote: true, quotes } : quotes[0];
        }
        renderReplyDraft();
        input.focus();
      };

      const syncSelectionQuote = () => {
        const selection = window.getSelection();
        const text = selection && !selection.isCollapsed ? selection.toString().trim().slice(0, 500) : '';
        const anchorEl = selection?.anchorNode?.nodeType === 1 ? selection.anchorNode : selection?.anchorNode?.parentElement;
        const focusEl = selection?.focusNode?.nodeType === 1 ? selection.focusNode : selection?.focusNode?.parentElement;
        const msgEl = anchorEl?.closest?.('.msg[data-id]');
        const message = msgEl && msgEl.contains(focusEl) ? messageById(msgEl.dataset.id) : null;
        if (!text || !message || !(message.text || '').includes(text)) {
          selectionQuoteData = null; selectionQuote.classList.add('hidden'); return;
        }
        selectionQuoteData = { message, text };
        const r = selection.getRangeAt(0).getBoundingClientRect();
        selectionQuote.style.left = `${Math.max(8, Math.min(innerWidth - 126, r.left + r.width / 2 - 58))}px`;
        selectionQuote.style.top = `${Math.max(8, r.top - 42)}px`;
        selectionQuote.classList.remove('hidden');
      };
      document.addEventListener('selectionchange', syncSelectionQuote);
      selectionQuote.onclick = (e) => {
        e.preventDefault(); e.stopPropagation();
        if (selectionQuoteData) setReply(selectionQuoteData.message, selectionQuoteData.text, true);
        window.getSelection()?.removeAllRanges();
        selectionQuoteData = null; selectionQuote.classList.add('hidden');
      };

      const renderSelectionBar = () => {
        const messages = selectedMessages();
        selectionBar.classList.toggle('hidden', !messages.length);
        if (!messages.length) {
          selectionBar.innerHTML = '';
          return;
        }
        const ownOnly = messages.every((m) => m.name === client.self.name);
        const pinnedIds = client.messages[currentChat.id]?.pinnedIds || (client.messages[currentChat.id]?.pinnedId ? [client.messages[currentChat.id].pinnedId] : []);
        const onePinned = messages.length === 1 && pinnedIds.includes(messages[0].id);
        const plural = messages.length === 1 ? 'сообщение' : 'сообщения';
        const act = (name, label, icon, cls = '') =>
          `<button class="sel-btn ${cls}" data-act="${name}" title="${label}" aria-label="${label}">${icon}</button>`;
        selectionBar.innerHTML = `
          <button class="sel-close" data-act="clear" title="Снять выделение" aria-label="Снять выделение">${ICONS.close}</button>
          <span class="sel-count">${messages.length} ${plural}</span>
          <div class="sel-actions">
            ${act('copy', 'Копировать', ICONS.copy)}
            ${act('forward', 'Переслать', ICONS.forward)}
            ${messages.length === 1 ? act('pin', onePinned ? 'Открепить' : 'Закрепить', ICONS.pin) : ''}
            ${ownOnly ? act('delete', 'Удалить', ICONS.trash, 'danger') : ''}
          </div>`;
        for (const btn of selectionBar.querySelectorAll('button')) {
          btn.onclick = async () => {
            const a = btn.dataset.act;
            const current = selectedMessages();
            if (a === 'copy') {
              await navigator.clipboard?.writeText(current.map((m) => `${m.name}: ${m.text}`).join('\n'));
              window.Segment?.toast?.('Выбранное скопировано');
            } else if (a === 'forward') {
              window.Segment?.startForward?.({
                text: current.map((m) => `${m.name}: ${m.text}`).join('\n'),
                fromName: current.length === 1 ? current[0].name : `${current.length} сообщений`,
                chatName: currentChat?.name || '',
              });
            } else if (a === 'pin' && current[0]) {
              client.toggleMessagePin(currentChat.id, current[0].id);
            } else if (a === 'delete') {
              current.forEach((m) => client.deleteMessage(currentChat.id, m.id));
            }
            if (a === 'clear' || a === 'delete' || a === 'forward') selected.clear();
            renderRoom(currentChat, client.messages[currentChat.id] || []);
          };
        }
      };


      const renderPinnedBar = () => {
        const list = currentChat ? client.messages[currentChat.id] : null;
        if (currentChat?.id !== pinnedRoomId) { pinnedRoomId = currentChat?.id || null; pinnedIndex = 0; }
        const ids = list ? (list.pinnedIds || (list.pinnedId ? [list.pinnedId] : [])) : [];
        const pins = ids.map((id) => list.find((m) => m.id === id && !m.deleted)).filter(Boolean);
        pinnedIndex = Math.min(pinnedIndex, Math.max(0, pins.length - 1));
        const pinned = pins[pinnedIndex];
        pinnedBar.classList.toggle('hidden', !pinned);
        if (!pinned) { pinnedBar.innerHTML = ''; return; }
        const preview = pinned.text || attachLabel(pinned) || 'Сообщение';
        pinnedBar.innerHTML = `
          <span class="pin-rail" aria-hidden="true">${pins.map((_, i) => `<i class="${i === pinnedIndex ? 'active' : ''}"></i>`).join('')}</span>
          <span class="pin-body"><b>Закреплённое <em data-act="manage" title="Все закреплённые">${pinnedIndex + 1}/${pins.length}</em></b><span>${esc(preview)}</span></span>
          ${pins.length > 1 ? `<span class="pin-nav"><span data-act="prev" title="Предыдущее">‹</span><span data-act="next" title="Следующее">›</span></span>` : ''}
          <span class="pin-unpin" data-act="unpin" title="Открепить" aria-label="Открепить">${ICONS.close}</span>`;
        pinnedBar.onclick = (e) => {
          if (e.target.closest('[data-act="manage"]')) { renderPinnedManager(); return; }
          if (e.target.closest('[data-act="prev"]')) { pinnedIndex = (pinnedIndex - 1 + pins.length) % pins.length; renderPinnedBar(); return; }
          if (e.target.closest('[data-act="next"]')) { pinnedIndex = (pinnedIndex + 1) % pins.length; renderPinnedBar(); return; }
          if (e.target.closest('[data-act="unpin"]')) {
            client.toggleMessagePin(currentChat.id, pinned.id);
            return;
          }
          jumpToMessage(pinned.id);
        };
        pinnedBar.onwheel = (e) => {
          if (pins.length < 2) return;
          e.preventDefault();
          pinnedIndex = (pinnedIndex + (e.deltaY > 0 ? 1 : -1) + pins.length) % pins.length;
          renderPinnedBar();
        };
      };

      const renderPinnedManager = () => {
        if (!currentChat) return;
        const list = client.messages[currentChat.id] || [];
        const ids = list.pinnedIds || (list.pinnedId ? [list.pinnedId] : []);
        const pins = ids.map((id) => list.find((m) => m.id === id && !m.deleted)).filter(Boolean);
        pinnedManager.innerHTML = `
          <div class="pinned-manager-head"><div><b>Закреплённые</b><span>${pins.length} сообщений</span></div><button data-pm="close" title="Закрыть">${ICONS.close}</button></div>
          <div class="pinned-manager-list">${pins.map((m, i) => `
            <div class="pinned-manager-row" draggable="true" data-pin-id="${esc(m.id)}">
              <span class="pm-grip" title="Перетащить">⠿</span>
              <button class="pm-message" data-pm="jump"><b>${esc(m.name || '')}</b><span>${esc(m.text || attachLabel(m) || 'Сообщение')}</span></button>
              <span class="pm-order"><button data-pm="up"${i ? '' : ' disabled'} title="Выше">↑</button><button data-pm="down"${i < pins.length - 1 ? '' : ' disabled'} title="Ниже">↓</button></span>
              <button class="pm-unpin" data-pm="unpin" title="Открепить">${ICONS.close}</button>
            </div>`).join('')}</div>`;
        pinnedManager.classList.remove('hidden');
        pinnedManager.querySelector('[data-pm="close"]').onclick = () => pinnedManager.classList.add('hidden');
        for (const row of pinnedManager.querySelectorAll('.pinned-manager-row')) {
          const id = row.dataset.pinId;
          row.querySelector('[data-pm="jump"]').onclick = () => { pinnedManager.classList.add('hidden'); pinnedIndex = Math.max(0, ids.indexOf(id)); renderPinnedBar(); jumpToMessage(id); };
          row.querySelector('[data-pm="unpin"]').onclick = () => { client.toggleMessagePin(currentChat.id, id); renderPinnedManager(); };
          row.querySelector('[data-pm="up"]').onclick = () => { const i = ids.indexOf(id); if (i > 0) { client.reorderMessagePin(currentChat.id, id, ids[i - 1]); renderPinnedManager(); } };
          row.querySelector('[data-pm="down"]').onclick = () => { const i = ids.indexOf(id); if (i >= 0 && i < ids.length - 1) { client.reorderMessagePin(currentChat.id, ids[i + 1], id); renderPinnedManager(); } };
          row.ondragstart = (e) => { e.dataTransfer.setData('text/pinned-message', id); row.classList.add('dragging'); };
          row.ondragend = () => row.classList.remove('dragging');
          row.ondragover = (e) => e.preventDefault();
          row.ondrop = (e) => { e.preventDefault(); const from = e.dataTransfer.getData('text/pinned-message'); if (from && from !== id) { client.reorderMessagePin(currentChat.id, from, id); renderPinnedManager(); } };
        }
      };

      function openMessageMenu(id, x, y) {
        const message = messageById(id);
        if (!currentChat || !message || message.system) return;
        const mine = message.name === client.self.name;
        const pinnedIds = client.messages[currentChat.id]?.pinnedIds || (client.messages[currentChat.id]?.pinnedId ? [client.messages[currentChat.id].pinnedId] : []);
        const pinned = pinnedIds.includes(id);
        const msgEl = feed.querySelector(`.msg[data-id="${id}"]`);
        const selection = window.getSelection();
        const selectedText = selection && !selection.isCollapsed && msgEl?.contains(selection.anchorNode) && msgEl.contains(selection.focusNode)
          ? selection.toString().trim().slice(0, 500)
          : '';
        const quoteText = selectedText && (message.text || '').includes(selectedText) ? selectedText : '';
        const imageUrl = imageFromMessage(message);
        const item = (act, label, icon, extra = '') =>
          `<button class="ctx-item${extra.includes('danger') ? ' danger' : ''}" data-act="${act}"${extra.includes('disabled') ? ' disabled' : ''}>${icon}<span>${label}</span></button>`;
        msgMenu.innerHTML = `
          <div class="reaction-row">${QUICK_REACTIONS.map((r) => `<button class="react-btn" data-emoji="${r}">${r}</button>`).join('')}<button class="react-btn react-more" data-more title="Ещё реакции">+</button></div>
          <div class="react-picker hidden">${REACTIONS_ALL.map((r) => `<button class="react-btn" data-emoji="${r}">${r}</button>`).join('')}</div>
          <div class="ctx-list">
            ${item('reply', 'Ответить', ICONS.reply)}
            ${quoteText ? item('quote', 'Цитировать фрагмент', ICONS.reply) : ''}
            ${mine && !message.deleted ? item('edit', 'Изменить', ICONS.edit) : ''}
            ${item('pin', pinned ? 'Открепить' : 'Закрепить', ICONS.pin)}
            ${item('copy-text', 'Копировать текст', ICONS.copy)}
            ${imageUrl ? item('copy-image', 'Копировать изображение', ICONS.image) : ''}
            ${item('forward', 'Переслать', ICONS.forward)}
            ${mine && !message.deleted ? item('delete', 'Удалить', ICONS.trash, 'danger') : ''}
            ${item('select', selected.has(id) ? 'Снять выделение' : 'Выбрать', ICONS.select)}
          </div>`;
        hideMenus();
        msgMenu.classList.remove('hidden');
        placeFloating(msgMenu, x, y, roomEl);
        const picker = msgMenu.querySelector('.react-picker');
        for (const btn of msgMenu.querySelectorAll('.react-btn')) {
          btn.onclick = () => {
            if (btn.dataset.more != null) {
              picker.classList.toggle('hidden');
              placeFloating(msgMenu, x, y, roomEl);
              return;
            }
            client.toggleReaction(currentChat.id, id, btn.dataset.emoji);
            hideMenus();
          };
        }
        for (const btn of msgMenu.querySelectorAll('.ctx-item')) {
          btn.onclick = async () => {
            const act = btn.dataset.act;
            if (act === 'reply') setReply(message);
            else if (act === 'quote') setReply(message, quoteText, true);
            else if (act === 'copy-text') {
              await navigator.clipboard?.writeText(message.text);
              window.Segment?.toast?.('Текст скопирован');
            } else if (act === 'copy-image' && imageUrl) {
              await navigator.clipboard?.writeText(imageUrl);
              window.Segment?.toast?.('Ссылка на картинку скопирована');
            } else if (act === 'forward') {
              window.Segment?.startForward?.({ ...message, chatName: currentChat.name });
            } else if (act === 'select') {
              toggleSelected(id);
            }
            else if (act === 'pin') client.toggleMessagePin(currentChat.id, id);
            else if (act === 'edit') {
              input.value = message.text;
              input.dataset.editing = id;
              input.focus();
            } else if (act === 'delete') client.deleteMessage(currentChat.id, id);
            hideMenus();
          };
        }
      }


      const collectInfo = () => {
        const msgs = client.messages[currentChat.id] || [];
        const media = []; const files = []; const links = [];
        const members = new Map();
        for (const m of msgs) {
          if (m.system) continue;
          if (m.name && !m.deleted) members.set(m.name, { name: m.name, color: m.color });
          if (m.deleted) continue;
          for (const a of m.attachments || []) {
            if (a.kind === 'photo' || a.kind === 'video' || a.kind === 'circle') media.push({ ...a, author: m.name, color: m.color });
            else if (a.kind === 'file') files.push({ a, m });
          }
          const urls = (m.text || '').match(/https?:\/\/[^\s]+/g);
          if (urls) for (const u of urls) links.push({ u, m });
        }
        for (const u of client.online || []) members.set(u.name, { name: u.name, color: null });
        members.set(client.self.name, { name: client.self.name, color: client.self.color, me: true });
        return { media, files, links, members: [...members.values()] };
      };

      let infoTab = 'media';
      const openChatSheet = () => { if (currentChat) { infoTab = 'media'; renderInfo(); sheet.classList.remove('hidden'); } };

      const renderInfo = () => {
        if (!currentChat) return;
        const chat = currentChat;
        const info = collectInfo();
        const subtitle = chatStatus(chat, client).text;
        const typeText = { saved: 'Избранное', dm: 'Личный чат', chat: 'Группа', channel: 'Канал' }[chat.type] || 'Чат';
        const muted = client.isMuted(chat.id);
        const chatPinned = client.pinned.has(chat.id);
        const editable = client.canEditChat(chat.id);
        const showMembers = chat.type === 'chat' || chat.type === 'channel';
        const leaveLabel = { channel: 'Выйти из канала', chat: 'Выйти из группы', dm: 'Удалить чат' }[chat.type] || 'Удалить чат';

        const tab = (id, label, n) => `<button class="info-tab ${infoTab === id ? 'active' : ''}" data-tab="${id}">${label}${n ? ` <span>${n}</span>` : ''}</button>`;
        let content = '';
        if (infoTab === 'media') {
          content = info.media.length
            ? `<div class="info-media">${info.media.map((a, i) =>
                `<button class="info-cell ${a.kind !== 'photo' ? 'has-play' : ''}" data-media="${i}"><img src="${esc(a.poster || a.data)}" alt="">${a.kind !== 'photo' ? '<span class="info-play">▶</span>' : ''}</button>`).join('')}</div>`
            : '<div class="info-empty">Нет медиа</div>';
        } else if (infoTab === 'files') {
          content = info.files.length
            ? info.files.map(({ a }) => `<a class="info-file" href="${esc(a.data)}" download="${esc(a.name || 'file')}"><span class="info-file-ico">📎</span><span class="info-file-info"><b>${esc(a.name || 'Файл')}</b><span>${esc(fmtSize(a.size))}</span></span></a>`).join('')
            : '<div class="info-empty">Нет файлов</div>';
        } else if (infoTab === 'links') {
          content = info.links.length
            ? info.links.map(({ u }) => `<a class="info-link" href="${esc(u)}" target="_blank" rel="noopener noreferrer">${esc(u)}</a>`).join('')
            : '<div class="info-empty">Нет ссылок</div>';
        } else if (infoTab === 'members') {
          content = info.members.map((mem) => `
            <div class="info-member">
              <div class="chat-icon" style="background:${avatarColor(mem.name)}">${esc(mem.name[0].toUpperCase())}</div>
              <div class="info-member-info"><b>${esc(mem.name)}</b><span>${mem.me ? 'вы' : (chat.type === 'channel' ? 'подписчик' : 'участник')}</span></div>
            </div>`).join('');
        }

        sheet.innerHTML = `
          <div class="info-top">
            <button class="info-close" data-act="close" title="Закрыть">${ICONS.close}</button>
            <div class="info-avatar" style="background:${avatarColor(chat.id)}">${chat.icon || esc(chat.name[0].toUpperCase())}</div>
            <div class="info-title">${esc(chat.name)}</div>
            <div class="info-sub">${esc(subtitle || typeText)}</div>
            <div class="info-actions">
              <button class="info-act" data-act="mute">${muted ? ICONS.bell : ICONS.bellOff}<span>${muted ? 'Вкл. звук' : 'Без звука'}</span></button>
              <button class="info-act" data-act="pin-chat">${chatPinned ? ICONS.unpin : ICONS.pin}<span>${chatPinned ? 'Открепить' : 'Закрепить'}</span></button>
              <button class="info-act" data-act="open-block">${ICONS.newBlock}<span>В блок</span></button>
              ${editable ? `<button class="info-act" data-act="rename">${ICONS.rename}<span>Название</span></button>` : ''}
            </div>
          </div>
          <div class="info-tabs">
            ${tab('media', 'Медиа', info.media.length)}
            ${tab('files', 'Файлы', info.files.length)}
            ${tab('links', 'Ссылки', info.links.length)}
            ${showMembers ? tab('members', 'Участники', info.members.length) : ''}
          </div>
          <div class="info-body">${content}</div>
          <div class="info-foot">
            <button class="ctx-item danger" data-act="clear"${info.media.length || client.messages[chat.id]?.length ? '' : ' disabled'}>${ICONS.broom}<span>Очистить историю</span></button>
            ${editable ? `<button class="ctx-item danger" data-act="leave">${ICONS.logout}<span>${leaveLabel}</span></button>` : ''}
          </div>`;

        for (const t of sheet.querySelectorAll('.info-tab')) t.onclick = () => { infoTab = t.dataset.tab; renderInfo(); };
        const mediaData = info.media.map((a) => ({ type: a.kind === 'photo' ? 'photo' : 'video', src: a.data, poster: a.poster, name: a.name, size: a.size, author: a.author, color: a.color }));
        for (const cell of sheet.querySelectorAll('.info-cell')) {
          cell.onclick = () => window.Segment?.openMedia?.(mediaData, Number(cell.dataset.media) || 0);
        }
        for (const btn of sheet.querySelectorAll('[data-act]')) {
          btn.onclick = () => {
            const act = btn.dataset.act;
            if (act === 'close') hideMenus();
            else if (act === 'open-block') { window.Segment?.workspace?.addPanel(chatViewPanel(client, chat)); hideMenus(); }
            else if (act === 'pin-chat') { client.togglePin(chat.id); renderInfo(); }
            else if (act === 'mute') { client.toggleMute(chat.id); renderInfo(); }
            else if (act === 'clear') { if (confirm(`Очистить историю чата «${chat.name}»?`)) { client.clearHistory(chat.id); renderInfo(); } }
            else if (act === 'rename') { const name = prompt('Новое название', chat.name); if (name) { client.renameChat(chat.id, name); renderInfo(); } }
            else if (act === 'leave') { client.removeChat(chat.id); hideMenus(); }
          };
        }
      };

      const renderRoom = (chat, messages) => {
        const chatChanged = chat?.id !== currentChat?.id;
        if (chatChanged) {
          if (currentChat) drafts[currentChat.id] = input.value;
          pending = []; selected.clear(); renderAttachDraft();
          closeRoomSearch();
        }
        currentChat = chat;
        roomEl.classList.toggle('is-empty', !chat);
        typingEl.innerHTML = '';
        if (!chat) {
          selected.clear();
          renderSelectionBar();
          renderPinnedBar();
          feed.innerHTML = `
            <div class="empty">
              <div class="empty-badge">
                <svg viewBox="0 0 24 24" width="34" height="34" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z"/></svg>
              </div>
              <div class="empty-title">Выберите чат</div>
              <div class="empty-sub">Откройте диалог, чтобы начать переписку</div>
            </div>`;
          statusEl.textContent = '';
          return;
        }
        avatarEl.textContent = chat.icon;
        titleEl.textContent = chat.name;
        const status = chatStatus(chat, client);
        statusEl.textContent = status.text;
        statusEl.classList.toggle('online', status.online);
        statusEl.classList.toggle('muted', !status.online);
        input.placeholder = chat.local ? 'Заметка для себя...' : (chat.type === 'channel' ? 'Публикация в канал...' : 'Сообщение...');

        renderFeed(feed, chat, messages, client.self.name, {
          ...feedOptions(),
          scrollMode: chatChanged ? 'bottom' : 'anchor',
          firstUnread: chatChanged ? client.firstUnread[chat.id] : null,
        });
        if (chatChanged) { awayCount = 0; input.value = drafts[chat.id] || ''; syncActions(); }
        renderSelectionBar();
        renderPinnedBar();
        if (!roomSearchBar.classList.contains('hidden')) updateRoomSearch();
        updateScrollDown();
      };

      const offs = [
        client.on('room', ({ chat, messages }) => renderRoom(chat, messages)),
        client.on('append', ({ message, current, wasEmpty }) => {
          if (!current) return;

          const stick = feed.scrollHeight - feed.scrollTop - feed.clientHeight < 80 || wasEmpty;
          if (wasEmpty) feed.innerHTML = '';
          if (message.system) renderSystem(feed, message.text);
          else renderMessage(feed, message, client.self.name, feedOptions());
          if (stick) scrollFeedToBottom(feed);

          else if (!message.system && message.name !== client.self.name) awayCount++;
          updateScrollDown();
        }),
        client.on('status', () => {
          if (!currentChat) return;
          const status = chatStatus(currentChat, client);
          statusEl.textContent = status.text;
          statusEl.classList.toggle('online', status.online);
          statusEl.classList.toggle('muted', !status.online);
        }),
        client.on('connection', ({ connected }) => {
          if (!connected && currentChat && !currentChat.local) {
            statusEl.textContent = 'переподключение...';
            statusEl.classList.remove('online');
            statusEl.classList.add('muted');
          }
        }),
        client.on('typing', ({ name }) => {
          showTyping(typingEl, name);
          clearTimeout(typingTimer);
          typingTimer = setTimeout(() => { typingEl.innerHTML = ''; }, TYPING_HIDE_MS);
        }),
      ];

      const submit = () => {
        if (!currentChat) return;
        if (pending.length && !input.dataset.editing) {
          client.sendAttachments(currentChat.id, pending, input.value, replyTo);
          pending = [];
          renderAttachDraft();
          if (replyTo) { replyTo = null; renderReplyDraft(); }
          input.value = '';
          delete drafts[currentChat.id];
          syncActions();
          input.focus();
          return;
        }
        if (input.dataset.editing) {
          client.editMessage(currentChat.id, input.dataset.editing, input.value);
          delete input.dataset.editing;
        } else if (replyTo) {
          client.sendReply(currentChat.id, input.value, replyTo);
          replyTo = null;
          renderReplyDraft();
        } else client.send(input.value);
        input.value = '';
        if (currentChat) delete drafts[currentChat.id];
        syncActions();
        input.focus();
      };

      sendBtn.onclick = submit;
      input.addEventListener('input', () => {
        syncActions();
        if (currentChat) drafts[currentChat.id] = input.value;
        acUpdate();
      });
      input.addEventListener('blur', () => setTimeout(acClose, 120));
      for (const btn of formatBar.querySelectorAll('.fmt-btn')) {
        btn.addEventListener('mousedown', (e) => {
          e.preventDefault();
          if (btn.dataset.fmt) applyFormat(btn.dataset.fmt);
          else if (btn.dataset.command === 'clear') {
            input.focus();
            document.execCommand('removeFormat');
            input.dispatchEvent(new Event('input'));
            syncFormatState();
          } else if (btn.dataset.command) {
            input.focus();
            document.execCommand(btn.dataset.command);
            input.dispatchEvent(new Event('input'));
            syncFormatState();
          }
        });
      }
      const syncComposerFormat = () => {
        if (document.activeElement === input) syncFormatState();
      };
      document.addEventListener('selectionchange', syncComposerFormat);
      feed.addEventListener('scroll', updateScrollDown, { passive: true });
      scrollDown.onclick = () => { awayCount = 0; scrollFeedToBottom(feed); updateScrollDown(); };
      replyCancel.onclick = () => setReply(null);
      head.onclick = openChatSheet;
      roomSearchOpen.onclick = (e) => { e.stopPropagation(); openRoomSearch(); };
      q('roomSearchClose').onclick = closeRoomSearch;
      q('roomSearchPrev').onclick = () => updateRoomSearch(-1);
      q('roomSearchNext').onclick = () => updateRoomSearch(1);
      roomSearchInput.oninput = () => { roomSearchIndex = 0; updateRoomSearch(); };
      roomSearchInput.onkeydown = (e) => { if (e.key === 'Enter') updateRoomSearch(e.shiftKey ? -1 : 1); else if (e.key === 'Escape') closeRoomSearch(); };
      const roomSearchShortcut = (e) => { if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'f' && currentChat) { e.preventDefault(); openRoomSearch(); } };
      document.addEventListener('keydown', roomSearchShortcut);
      const attachShortcut = (e) => {
        if ((e.ctrlKey || e.metaKey) && !e.shiftKey && e.key.toLowerCase() === 'o' && currentChat) {
          e.preventDefault(); fileInput.accept = ''; fileInput.click();
        }
      };
      document.addEventListener('keydown', attachShortcut);
      const deleteShortcut = (e) => {
        if (e.key !== 'Delete' || !currentChat) return;
        if (/INPUT|TEXTAREA/.test(e.target.tagName) || e.target.isContentEditable) return;
        const messages = selectedMessages();
        if (!messages.length || !messages.every((m) => m.name === client.self.name)) return;
        e.preventDefault();
        messages.forEach((m) => client.deleteMessage(currentChat.id, m.id));
        selected.clear();
        renderRoom(currentChat, client.messages[currentChat.id] || []);
      };
      document.addEventListener('keydown', deleteShortcut);


      let attachHideTimer = null;
      const openAttachMenu = () => { clearTimeout(attachHideTimer); attachMenu.classList.remove('hidden'); };
      const scheduleAttachHide = () => { clearTimeout(attachHideTimer); attachHideTimer = setTimeout(() => attachMenu.classList.add('hidden'), 260); };
      attachWrap.addEventListener('mouseenter', openAttachMenu);
      attachWrap.addEventListener('mouseleave', scheduleAttachHide);
      attachBtn.onclick = (e) => { e.stopPropagation(); attachMenu.classList.toggle('hidden'); };
      for (const b of attachMenu.querySelectorAll('[data-att]')) {
        b.onclick = (e) => {
          e.stopPropagation();
          attachMenu.classList.add('hidden');
          const kind = b.dataset.att;
          if (kind === 'poll') { openPoll(); return; }
          fileInput.accept = kind === 'photo' ? 'image/*,video/*' : '';
          fileInput.click();
        };
      }

      const LOCK_DY = -56, CANCEL_DX = -90, HOLD_MS = 180;
      recBtn.addEventListener('pointerdown', (e) => {
        if (e.button != null && e.button !== 0) return;
        if (!currentChat || currentChat.local) { window.Segment?.toast?.('Запись — только в чатах'); return; }
        e.preventDefault();
        pressPointer = e.pointerId; recStartRequested = false;
        holdX = e.clientX; holdY = e.clientY;
        try { recBtn.setPointerCapture(e.pointerId); } catch {}
        holdTimer = setTimeout(() => { holdTimer = null; recStartRequested = true; beginRecord(); }, HOLD_MS);
      });
      recBtn.addEventListener('pointermove', (e) => {
        if (pressPointer !== e.pointerId || !recSession || recSession.locked) return;
        const dy = e.clientY - holdY, dx = e.clientX - holdX;
        recLock.style.setProperty('--pull', `${Math.max(0, Math.min(1, -dy / -LOCK_DY))}`);
        if (dy <= LOCK_DY) lockRecord();
        else if (dx <= CANCEL_DX) { finishRecord(false); pressPointer = null; }
      });
      const endPress = (e) => {
        if (pressPointer !== e.pointerId) return;
        pressPointer = null;
        recLock.style.removeProperty('--pull');
        if (holdTimer) { clearTimeout(holdTimer); holdTimer = null; toggleRecMode(); return; }
        recStartRequested = false;
        if (recSession && !recSession.locked) finishRecord(true);
      };
      recBtn.addEventListener('pointerup', endPress);
      recBtn.addEventListener('pointercancel', endPress);
      fileInput.onchange = () => {
        const files = [...fileInput.files];
        fileInput.value = '';
        addFiles(files);
      };


      input.addEventListener('paste', (e) => {
        const files = [...(e.clipboardData?.files || [])];
        if (files.length) { e.preventDefault(); addFiles(files); }
      });


      const onDragOver = (e) => {
        if (!currentChat || !e.dataTransfer?.types?.includes('Files')) return;
        e.preventDefault();
        roomEl.classList.add('drop-active');
      };
      const onDragLeave = (e) => {
        if (e.relatedTarget && roomEl.contains(e.relatedTarget)) return;
        roomEl.classList.remove('drop-active');
      };
      const onDrop = (e) => {
        roomEl.classList.remove('drop-active');
        const files = [...(e.dataTransfer?.files || [])];
        if (!files.length || !currentChat) return;
        e.preventDefault();
        addFiles(files);
      };
      roomEl.addEventListener('dragover', onDragOver);
      roomEl.addEventListener('dragleave', onDragLeave);
      roomEl.addEventListener('drop', onDrop);
      emojiBtn.onclick = (e) => {
        e.stopPropagation();
        const wasHidden = emojiMenu.classList.contains('hidden');
        emojiMenu.innerHTML = EMOJIS.map((emoji) => `<button data-emoji="${emoji}">${emoji}</button>`).join('');
        emojiMenu.classList.toggle('hidden', !wasHidden);
        if (wasHidden) {
          const r = emojiBtn.getBoundingClientRect();
          placeFloating(emojiMenu, r.left, r.top, roomEl);
        }
        for (const btn of emojiMenu.querySelectorAll('button')) {
          btn.onclick = () => {
            input.value += btn.dataset.emoji;
            emojiMenu.classList.add('hidden');
            syncActions();
            input.focus();
          };
        }
      };

      const editLast = () => {
        const list = currentChat ? client.messages[currentChat.id] : null;
        if (!list) return false;
        for (let i = list.length - 1; i >= 0; i--) {
          const m = list[i];
          if (!m.system && !m.deleted && m.name === client.self.name && m.text) {
            input.value = m.text;
            input.dataset.editing = m.id;
            syncActions();
            jumpToMessage(m.id);
            input.focus();
            return true;
          }
        }
        return false;
      };

      input.onkeydown = (e) => {
        if (acKeydown(e)) return;
        if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submit(); }
        else if ((e.ctrlKey || e.metaKey) && !e.shiftKey && 'bise'.includes(e.key.toLowerCase())) {
          const kind = { b: 'B', i: 'I', s: 'S', e: 'CODE' }[e.key.toLowerCase()];
          if (kind) { e.preventDefault(); applyFormat(kind); }
        }
        else if (e.key === 'ArrowUp' && !input.value && !input.dataset.editing) {
          if (editLast()) e.preventDefault();
        }
        else if (e.key === 'Escape' && input.dataset.editing) {
          input.value = '';
          delete input.dataset.editing;
          syncActions();
        } else if (e.key === 'Escape' && replyTo) {
          e.stopPropagation(); setReply(null);
        } else client.notifyTyping();
      };
      roomEl.addEventListener('pointerdown', (e) => {
        if (!msgMenu.contains(e.target) && !sheet.contains(e.target) && !emojiMenu.contains(e.target) && !pinnedManager.contains(e.target) && !head.contains(e.target) && !emojiBtn.contains(e.target)) hideMenus();
        if (!attachWrap.contains(e.target)) attachMenu.classList.add('hidden');
      });

      renderRoom(client.chatById(client.currentRoom), client.messages[client.currentRoom]);

      return () => {
        offs.forEach((off) => off());
        clearTimeout(typingTimer);
        clearTimeout(holdTimer);
        document.removeEventListener('keydown', roomSearchShortcut);
        document.removeEventListener('selectionchange', syncSelectionQuote);
        document.removeEventListener('selectionchange', syncComposerFormat);
        if (recSession) finishRecord(false);
      };
    },
  };
}
