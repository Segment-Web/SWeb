import { renderFeed, renderMessage, renderSystem } from '../ui.js';
import { esc, placeFloatingMenu } from '../util.js';
import { ICONS } from '../icons.js';

let seq = 0;

const QUICK_REACTIONS = ['👍', '❤️', '😂', '🔥', '👏', '🥰', '😮', '😢'];
const EMOJIS = ['😀', '😂', '😍', '😎', '🤝', '👍', '🔥', '❤️', '🎉', '💡', '👀', '✅'];
const IMAGE_URL_RE = /(https?:\/\/\S+\.(?:png|jpe?g|gif|webp))(?:\?\S*)?/i;

function chatStatus(chat, client) {
  if (!chat || chat.local) return { text: '', online: false };
  if (chat.type === 'channel') {
    const n = Number(chat.subscribers ?? chat.memberCount ?? 0);
    return { text: `${n.toLocaleString('ru-RU')} подписчиков`, online: false };
  }
  if (chat.type === 'dm') {
    const online = client.online?.length > 0;
    return { text: online ? 'в сети' : 'был(а) в сети 1 час назад', online };
  }
  const members = Number(chat.members ?? chat.memberCount ?? 0);
  return { text: `${members} участников`, online: false };
}

export function chatViewPanel(client, chat) {
  const id = `chatview:${chat.id}:${++seq}`;

  return {
    id,
    title: chat.name,
    label: chat.name,
    icon: chat.icon,
    removable: true,
    hideable: true,
    mount(body) {
      body.innerHTML = `
        <div class="room">
          <header class="room-head" data-el="head">
            <div class="room-avatar" data-el="avatar">${esc(chat.icon || chat.name?.[0] || '')}</div>
            <div class="room-headinfo">
              <div class="room-title" data-el="title">${esc(chat.name)}</div>
              <div class="room-status" data-el="status"></div>
            </div>
          </header>
          <main class="feed" data-el="feed"></main>
          <div class="selection-bar hidden" data-el="selectionBar"></div>
          <footer class="composer">
            <div class="reply-draft hidden" data-el="replyDraft"><b></b><span></span><button data-el="replyCancel" aria-label="Отменить">×</button></div>
            <div class="composer-field">
              <input class="composer-input" data-el="input" placeholder="Сообщение..." autocomplete="off">
              <div class="composer-tools">
                <button class="composer-tool" data-el="attach" aria-label="Прикрепить файл">
                  <svg viewBox="0 0 24 24" width="19" height="19" fill="none" stroke="currentColor" stroke-width="2"><path d="M21.4 11.6 12 21a6 6 0 0 1-8.5-8.5l10-10a4 4 0 1 1 5.7 5.7L9.6 17.8a2 2 0 0 1-2.8-2.8l8.9-8.9"/></svg>
                </button>
                <button class="composer-tool" data-el="emoji" aria-label="Эмодзи">
                  <svg viewBox="0 0 24 24" width="19" height="19" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="9"/><path d="M8.5 10h.01"/><path d="M15.5 10h.01"/><path d="M8 14c1 1.4 2.3 2 4 2s3-.6 4-2"/></svg>
                </button>
              </div>
              <input class="file-input" data-el="file" type="file" multiple>
            </div>
            <button class="composer-send" data-el="send" aria-label="Отправить">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 2 11 13"/><path d="M22 2 15 22l-4-9-9-4 20-7z"/></svg>
            </button>
          </footer>
          <div class="msg-menu hidden" data-el="msgMenu"></div>
          <div class="emoji-menu hidden" data-el="emojiMenu"></div>
          <div class="chat-sheet hidden" data-el="sheet"></div>
        </div>`;

      const q = (name) => body.querySelector(`[data-el="${name}"]`);
      const roomEl = body.querySelector('.room');
      const feed = q('feed');
      const titleEl = q('title');
      const avatarEl = q('avatar');
      const statusEl = q('status');
      const selectionBar = q('selectionBar');
      const input = q('input');
      const msgMenu = q('msgMenu');
      const emojiMenu = q('emojiMenu');
      const sheet = q('sheet');
      const replyDraft = q('replyDraft');
      const head = q('head');
      const attachBtn = q('attach');
      const emojiBtn = q('emoji');
      const fileInput = q('file');
      let replyTo = null;
      const drafts = client.storage.getDrafts?.() || {};
      let draftSaveTimer = null;
      const saveDraft = () => {
        const text = input.value;
        if (!text && !replyTo) delete drafts[chat.id];
        else drafts[chat.id] = { text, replyTo, updatedAt: Date.now() };
        clearTimeout(draftSaveTimer);
        draftSaveTimer = setTimeout(() => {
          client.storage.setDrafts?.(drafts);
          client._emit('chats');
        }, 120);
      };
      const storedDraft = drafts[chat.id];
      input.value = typeof storedDraft === 'string' ? storedDraft : (storedDraft?.text || '');
      replyTo = typeof storedDraft === 'object' ? (storedDraft.replyTo || null) : null;
      const selected = new Set();
      const canPublish = chat.type !== 'channel' || !chat.ownerId || chat.ownerId === client.self.id;
      input.disabled = !canPublish;
      attachBtn.disabled = !canPublish;
      emojiBtn.disabled = !canPublish;
      q('send').disabled = !canPublish;
      if (!canPublish) input.placeholder = 'Публиковать могут только владельцы канала';

      const current = () => client.chatById(chat.id);
      const messageById = (mid) => client.messages[chat.id]?.find((m) => m.id === mid);
      const imageFromMessage = (message) => message?.image || (message?.text || '').match(IMAGE_URL_RE)?.[0] || '';
      const selectedMessages = () => [...selected].map((mid) => messageById(mid)).filter((m) => m && !m.system && !m.deleted);
      const toggleSelected = (mid) => {
        if (selected.has(mid)) selected.delete(mid);
        else selected.add(mid);
        draw();
      };
      const hideMenu = () => {
        msgMenu.classList.add('hidden');
        emojiMenu.classList.add('hidden');
        sheet.classList.add('hidden');
      };
      const options = () => ({
        onMessageContext: openMessageMenu,
        onReaction: (mid, emoji) => client.toggleReaction(chat.id, mid, emoji),
        onQuickReaction: (mid, emoji) => client.toggleReaction(chat.id, mid, emoji),
        onReply: (mid) => setReply(messageById(mid)),
        onSelect: toggleSelected,
        onMessageClick: (mid) => { if (selected.size) toggleSelected(mid); },
        isSelected: (mid) => selected.has(mid),
      });

      const setReply = (message, quote = '', append = false) => {
        if (!message || message.deleted) replyTo = null;
        else {
          const next = { id: message.id, name: message.name, text: quote || message.text, quote: Boolean(quote) };
          const existing = append && replyTo ? (replyTo.quotes || [replyTo]) : [];
          const quotes = [...existing, next].filter((q, i, all) => all.findIndex((x) => x.id === q.id && x.text === q.text) === i).slice(0, 8);
          replyTo = quotes.length > 1 ? { ...quotes[0], quote: true, quotes } : quotes[0];
        }
        replyDraft.classList.toggle('hidden', !replyTo);
        if (replyTo) {
          const quotes = replyTo.quotes || [replyTo];
          replyDraft.querySelector('b').textContent = quotes.length > 1 ? `${quotes.length} цитаты` : (replyTo.name || '');
          replyDraft.querySelector('span').textContent = quotes.map((q) => q.text || '').join(' · ');
        }
        saveDraft();
        input.focus();
      };

      const renderSelectionBar = () => {
        const messages = selectedMessages();
        selectionBar.classList.toggle('hidden', !messages.length);
        if (!messages.length) {
          selectionBar.innerHTML = '';
          return;
        }
        const ownOnly = messages.every((m) => m.name === client.self.name);
        const pinnedIds = client.messages[chat.id]?.pinnedIds || (client.messages[chat.id]?.pinnedId ? [client.messages[chat.id].pinnedId] : []);
        const onePinned = messages.length === 1 && pinnedIds.includes(messages[0].id);
        const plural = messages.length === 1 ? 'сообщение' : 'сообщения';
        const action = (name, label, icon, className = '') =>
          `<button class="sel-btn ${className}" data-act="${name}" aria-label="${label}">${icon}</button>`;
        selectionBar.innerHTML = `
          <button class="sel-close" data-act="clear" aria-label="Снять выделение">${ICONS.close}</button>
          <span class="sel-count">${messages.length} ${plural}</span>
          <div class="sel-actions">
            ${action('copy', 'Копировать', ICONS.copy)}
            ${action('forward', 'Переслать', ICONS.forward)}
            ${messages.length === 1 ? action('pin', onePinned ? 'Открепить' : 'Закрепить', ICONS.pin) : ''}
            ${ownOnly ? action('delete', 'Удалить', ICONS.trash, 'danger') : ''}
          </div>`;
        for (const btn of selectionBar.querySelectorAll('button')) {
          btn.onclick = async () => {
            const act = btn.dataset.act;
            const currentMessages = selectedMessages();
            if (act === 'copy') {
              await navigator.clipboard?.writeText(currentMessages.map((m) => `${m.name}: ${m.text}`).join('\n'));
              window.Segment?.toast?.('Выбранное скопировано');
            } else if (act === 'forward') {
              window.Segment?.startForward?.({
                text: currentMessages.map((m) => `${m.name}: ${m.text}`).join('\n'),
                fromName: currentMessages.length === 1 ? currentMessages[0].name : `${currentMessages.length} сообщений`,
                chatName: current()?.name || chat.name,
              });
            } else if (act === 'pin' && currentMessages[0]) {
              client.toggleMessagePin(chat.id, currentMessages[0].id);
            } else if (act === 'delete') {
              currentMessages.forEach((m) => client.deleteMessage(chat.id, m.id));
            }
            if (act === 'clear' || act === 'delete' || act === 'forward') selected.clear();
            draw();
          };
        }
      };

      function openMessageMenu(mid, x, y) {
        const message = messageById(mid);
        if (!message || message.system) return;
        const mine = message.name === client.self.name;
        const pinnedIds = client.messages[chat.id]?.pinnedIds || (client.messages[chat.id]?.pinnedId ? [client.messages[chat.id].pinnedId] : []);
        const pinned = pinnedIds.includes(mid);
        const msgEl = feed.querySelector(`.msg[data-id="${mid}"]`);
        const selection = window.getSelection();
        const selectedText = selection && !selection.isCollapsed && msgEl?.contains(selection.anchorNode) && msgEl.contains(selection.focusNode)
          ? selection.toString().trim().slice(0, 500)
          : '';
        const quoteText = selectedText && (message.text || '').includes(selectedText) ? selectedText : '';
        const imageUrl = imageFromMessage(message);
        msgMenu.innerHTML = `
          <div class="reaction-row">${QUICK_REACTIONS.map((r) => `<button class="react-btn" data-emoji="${r}">${r}</button>`).join('')}</div>
          <button class="ctx-item" data-act="reply">Ответить</button>
          ${quoteText ? '<button class="ctx-item" data-act="quote">Цитировать фрагмент</button>' : ''}
          <button class="ctx-item" data-act="copy-text">Копировать текст</button>
          <button class="ctx-item" data-act="copy-image"${imageUrl ? '' : ' disabled'}>Копировать картинку</button>
          <button class="ctx-item" data-act="forward">Переслать</button>
          <button class="ctx-item" data-act="select">${selected.has(mid) ? 'Снять выделение' : 'Выделить'}</button>
          <button class="ctx-item" data-act="pin">${pinned ? 'Открепить' : 'Закрепить'}</button>
          ${mine && !message.deleted ? '<button class="ctx-item" data-act="edit">Редактировать</button>' : ''}
          ${mine && !message.deleted ? '<button class="ctx-item danger" data-act="delete">Удалить</button>' : ''}`;
        msgMenu.classList.remove('hidden');
        placeFloatingMenu(msgMenu, x, y, roomEl);
        for (const btn of msgMenu.querySelectorAll('.react-btn')) {
          btn.onclick = () => { client.toggleReaction(chat.id, mid, btn.dataset.emoji); hideMenu(); };
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
              window.Segment?.startForward?.({ ...message, chatName: current()?.name || chat.name });
            } else if (act === 'select') {
              toggleSelected(mid);
            }
            else if (act === 'pin') client.toggleMessagePin(chat.id, mid);
            else if (act === 'edit') {
              input.value = message.text;
              input.dataset.editing = mid;
              input.focus();
            } else if (act === 'delete') client.deleteMessage(chat.id, mid);
            hideMenu();
          };
        }
      }

      const openChatSheet = () => {
        const c = current();
        if (!c) return;
        const messages = client.messages[c.id] || [];
        const subtitle = chatStatus(c, client).text;
        const typeText = { saved: 'Избранное', dm: 'Личный чат', chat: 'Группа', channel: 'Канал' }[c.type] || 'Чат';
        sheet.innerHTML = `
          <div class="sheet-head">
            <div class="room-avatar">${esc(c.icon || '')}</div>
            <div><b>${esc(c.name)}</b><span>${esc(subtitle || typeText)}</span></div>
            <button data-act="close">×</button>
          </div>
          <div class="sheet-stats">
            <div><b>${messages.filter((m) => !m.system).length}</b><span>сообщений</span></div>
            <div><b>${client.online?.length || 0}</b><span>онлайн</span></div>
          </div>
          <button class="ctx-item" data-act="pin-chat">${client.pinned.has(c.id) ? 'Открепить чат' : 'Закрепить чат'}</button>
          ${client.canEditChat(c.id) ? '<button class="ctx-item" data-act="rename">Переименовать</button>' : ''}
          ${client.canEditChat(c.id) ? '<button class="ctx-item danger" data-act="leave">Удалить / выйти</button>' : ''}`;
        hideMenu();
        sheet.classList.remove('hidden');
        for (const btn of sheet.querySelectorAll('[data-act]')) {
          btn.onclick = () => {
            const act = btn.dataset.act;
            if (act === 'close') hideMenu();
            else if (act === 'pin-chat') client.togglePin(c.id);
            else if (act === 'rename') {
              const name = prompt('Новое название', c.name);
              if (name) client.renameChat(c.id, name);
            } else if (act === 'leave') client.removeChat(c.id);
            if (act !== 'rename') hideMenu();
          };
        }
      };

      const draw = () => {
        const c = current();
        if (!c) { selected.clear(); renderSelectionBar(); feed.innerHTML = '<div class="empty">чат удалён</div>'; return; }
        titleEl.textContent = c.name;
        avatarEl.textContent = c.icon;
        const status = chatStatus(c, client);
        statusEl.textContent = status.text;
        statusEl.classList.toggle('online', status.online);
        statusEl.classList.toggle('muted', !status.online);
        input.placeholder = c.local ? 'Заметка для себя...' : (c.type === 'channel' ? 'Публикация в канал...' : 'Сообщение...');
        renderFeed(feed, c, client.messages[chat.id] || [], client.self.name, options());
        renderSelectionBar();
      };

      const offs = [
        client.on('append', ({ roomId, message, wasEmpty }) => {
          if (roomId !== chat.id) return;
          if (wasEmpty) feed.innerHTML = '';
          if (message.system) renderSystem(feed, message.text);
          else renderMessage(feed, message, client.self.name, options());
          feed.scrollTop = feed.scrollHeight;
          const ws = window.Segment?.workspace;
          if (ws?.isDocked(id)) ws.flagDockUnread(id);
        }),
        client.on('room', draw),
        client.on('chats', draw),
        client.on('status', draw),
      ];

      const submit = () => {
        if (!canPublish) return;
        if (input.dataset.editing) {
          client.editMessage(chat.id, input.dataset.editing, input.value);
          delete input.dataset.editing;
        } else if (replyTo) {
          client.sendReply(chat.id, input.value, replyTo);
          setReply(null);
        } else client.sendTo(chat.id, input.value);
        input.value = '';
        replyTo = null;
        replyDraft.classList.add('hidden');
        delete drafts[chat.id];
        saveDraft();
        input.focus();
      };

      q('send').onclick = submit;
      q('replyCancel').onclick = () => setReply(null);
      head.onclick = openChatSheet;
      attachBtn.onclick = () => fileInput.click();
      fileInput.onchange = () => {
        const names = [...fileInput.files].map((f) => f.name).join(', ');
        if (names) input.value = `${input.value}${input.value ? ' ' : ''}📎 ${names}`;
        fileInput.value = '';
        input.focus();
      };
      emojiBtn.onclick = (e) => {
        e.stopPropagation();
        emojiMenu.innerHTML = EMOJIS.map((emoji) => `<button data-emoji="${emoji}">${emoji}</button>`).join('');
        emojiMenu.classList.toggle('hidden');
        for (const btn of emojiMenu.querySelectorAll('button')) {
          btn.onclick = () => {
            input.value += btn.dataset.emoji;
            saveDraft();
            emojiMenu.classList.add('hidden');
            input.focus();
          };
        }
      };
      input.addEventListener('input', saveDraft);
      input.onkeydown = (e) => { if (e.key === 'Enter') submit(); };
      roomEl.addEventListener('pointerdown', (e) => {
        if (!msgMenu.contains(e.target) && !sheet.contains(e.target) && !emojiMenu.contains(e.target) && !head.contains(e.target) && !emojiBtn.contains(e.target)) hideMenu();
      });

      draw();
      if (replyTo) setReply(replyTo);
      return () => {
        saveDraft();
        clearTimeout(draftSaveTimer);
        client.storage.setDrafts?.(drafts);
        offs.forEach((off) => off());
      };
    },
  };
}
