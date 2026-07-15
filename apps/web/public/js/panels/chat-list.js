
//



import { renderChatList } from '../ui.js';
import { ICONS } from '../icons.js';
import { chatViewPanel } from './chat-view.js';
import { esc } from '../util.js';

export function chatListPanel(client) {
  return {
    id: 'chat-list',
    title: 'Чаты',
    mount(body) {
      body.innerHTML = `
        <div class="chat-search">
          <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="7"/><path d="M21 21l-4.3-4.3"/></svg>
          <input type="text" placeholder="Поиск чатов и сообщений" aria-label="Поиск">
        </div>
        <div class="chat-filters">
          <button class="chat-filter active" data-filter="all">Все</button>
          <button class="chat-filter" data-filter="unread">Непроч.</button>
          <button class="chat-filter" data-filter="dm">Личные</button>
          <button class="chat-filter" data-filter="groups">Группы</button>
          <button class="chat-filter" data-filter="channels">Каналы</button>
          <button class="folder-add">+ Папка</button>
        </div>
        <div class="selection-bar hidden"><b class="selection-count">0</b><button data-batch="read">Прочитать</button><button data-batch="archive">В архив</button><button data-batch="delete">Удалить</button><button data-batch="cancel">Отмена</button></div>
        <div class="archive-head hidden">
          <button class="archive-back" aria-label="Назад">
            <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 18l-6-6 6-6"/></svg>
          </button>
          <span>Архив</span>
        </div>
        <div class="chat-list"></div>

        <div class="fab-menu hidden">
          <button class="fab-item" data-type="channel">
            <span class="fab-ico">📢</span>
            <span><b>Новый канал</b><small>вещание для подписчиков</small></span>
          </button>
          <button class="fab-item" data-type="chat">
            <span class="fab-ico">💬</span>
            <span><b>Новая группа</b><small>общий чат участников</small></span>
          </button>
          <button class="fab-item" data-type="dm">
            <span class="fab-ico">✉️</span>
            <span><b>Личное сообщение</b><small>диалог один на один</small></span>
          </button>
        </div>

        <button class="fab" aria-label="Создать">+</button>

        <div class="new-chat hidden">
          <div class="new-chat-title">Новый чат</div>
          <div class="new-chat-row">
            <input class="new-chat-emoji" maxlength="2" value="💬" aria-label="Значок">
            <input class="new-chat-name" placeholder="Название" maxlength="24">
          </div>
          <div class="new-chat-actions">
            <button class="nc-cancel">Отмена</button>
            <button class="nc-create">Создать</button>
          </div>
        </div>

        <div class="ctx-menu hidden"></div>`;

      const listEl = body.querySelector('.chat-list');
      const searchIn = body.querySelector('.chat-search input');
      const filtersEl = body.querySelector('.chat-filters');
      const archiveHead = body.querySelector('.archive-head');
      const fab = body.querySelector('.fab');

      let filter = 'all';
      let showArchived = false;
      const menu = body.querySelector('.fab-menu');
      const dialog = body.querySelector('.new-chat');
      const titleEl = body.querySelector('.new-chat-title');
      const emojiIn = body.querySelector('.new-chat-emoji');
      const nameIn = body.querySelector('.new-chat-name');
      const createBtn = body.querySelector('.nc-create');
      const ctx = body.querySelector('.ctx-menu');
      document.body.appendChild(ctx);
      const selectionBar = body.querySelector('.selection-bar');
      const selected = new Set();
      let selectionMode = false;
      let folderId = null;
      const preview = document.createElement('div');
      preview.className = 'chat-preview hidden';
      document.body.appendChild(preview);


      const PRESETS = {
        channel: { title: 'Новый канал', icon: '📢', placeholder: 'Название канала' },
        chat: { title: 'Новая группа', icon: '💬', placeholder: 'Название группы' },
        dm: { title: 'Личное сообщение', icon: '👤', placeholder: 'Имя собеседника' },
      };

      let type = 'chat';
      let editing = null;

      const hideAll = () => {
        menu.classList.add('hidden');
        dialog.classList.add('hidden');
        ctx.classList.add('hidden');
        preview.classList.add('hidden');
      };
      const toggleMenu = () => {
        const open = !menu.classList.contains('hidden');
        hideAll();
        if (!open) menu.classList.remove('hidden');
      };
      const openForm = (t) => {
        editing = null;
        type = t;
        const p = PRESETS[t];
        titleEl.textContent = p.title;
        emojiIn.value = p.icon;
        emojiIn.disabled = false;
        nameIn.placeholder = p.placeholder;
        nameIn.value = '';
        createBtn.textContent = 'Создать';
        hideAll();
        dialog.classList.remove('hidden');
        nameIn.focus();
      };
      const openRename = (id) => {
        const chat = client.chatById(id);
        if (!chat) return;
        editing = id;
        titleEl.textContent = 'Переименовать';
        emojiIn.value = chat.icon;
        emojiIn.disabled = true;
        nameIn.value = chat.name;
        createBtn.textContent = 'Сохранить';
        hideAll();
        dialog.classList.remove('hidden');
        nameIn.focus();
        nameIn.select();
      };
      const submit = () => {
        const ok = editing
          ? client.renameChat(editing, nameIn.value)
          : client.createChat({ name: nameIn.value, icon: emojiIn.value.trim(), type });
        if (ok) hideAll();
        else nameIn.focus();
      };


      const openContext = (id, x, y) => {
        const chat = client.chatById(id);
        if (!chat) return;
        const pinned = client.pinned.has(id);
        const muted = client.isMuted(id);
        const editable = client.canEditChat(id);
        const hasUnread = !!client.unread[id] || client.unreadDot.has(id);
        const isCurrent = client.currentRoom === id;
        const hasHistory = (client.messages[id] || []).length > 0;
        const removeLabel = { channel: 'Выйти из канала', chat: 'Выйти из группы', dm: 'Удалить чат' }[chat.type] || 'Удалить';
        const ws = window.Segment?.workspace;
        const views = ws ? ws.panels.filter((p) => p.id.startsWith('chatview:')) : [];
        const openBlocks = views.filter((p) => ws.isOpen(p.id)).length;
        const alreadyOpen = views.some((p) => p.id.startsWith(`chatview:${id}:`));
        const rows = [
          { act: 'open', label: 'Открыть чат', icon: ICONS.open },
          { act: 'newblock', label: 'Открыть в новом блоке', icon: ICONS.newBlock, disabled: alreadyOpen || openBlocks >= 3 },
          { act: 'info', label: 'Информация о чате', icon: ICONS.info },
          { act: 'select', label: 'Выбрать', icon: ICONS.markRead },
          ...client.folders.map((f) => ({ act: `folder:${f.id}`, label: `${f.chats.includes(id) ? 'Убрать из' : 'В папку'} «${f.name}»`, icon: ICONS.open })),
          { sep: true },
          hasUnread
            ? { act: 'read', label: 'Отметить прочитанным', icon: ICONS.markRead }
            : { act: 'unread', label: 'Отметить непрочитанным', icon: ICONS.markUnread, disabled: isCurrent },
          { act: 'pin', label: pinned ? 'Открепить' : 'Закрепить', icon: pinned ? ICONS.unpin : ICONS.pin },
          { act: 'mute', label: muted ? 'Включить уведомления' : 'Выключить уведомления', icon: muted ? ICONS.bell : ICONS.bellOff },
          chat.type !== 'saved' && { act: 'archive', label: client.isArchived(id) ? 'Вернуть из архива' : 'В архив', icon: ICONS.archive },
          editable && { act: 'rename', label: 'Переименовать', icon: ICONS.rename },
          chat.ownerId && { act: 'invite', label: 'Пригласить (скопировать ссылку)', icon: ICONS.open },
          (chat.ownerId && chat.ownerId === client.self.id && (chat.type === 'chat' || chat.type === 'channel') && chat.historyVisibility !== 'full')
            && { act: 'fullhistory', label: 'Показать всю историю', icon: ICONS.info },
          { sep: true },
          { act: 'clear', label: 'Очистить историю', icon: ICONS.broom, disabled: !hasHistory, danger: true },
          editable && { act: 'remove', label: removeLabel, icon: ICONS.logout, danger: true },
        ].filter(Boolean);

        ctx.innerHTML = rows.map((r) => (r.sep
          ? '<div class="ctx-sep"></div>'
          : `<button class="ctx-item ${r.danger ? 'danger' : ''}" data-act="${r.act}"${r.disabled ? ' disabled' : ''}>${r.icon}<span>${r.label}</span></button>`)).join('');
        hideAll();
        ctx.classList.remove('hidden');
        const cw = ctx.offsetWidth || 180;
        const ch = ctx.offsetHeight || 120;
        ctx.style.left = `${Math.max(6, Math.min(x, window.innerWidth - cw - 6))}px`;
        ctx.style.top = `${Math.max(6, Math.min(y, window.innerHeight - ch - 6))}px`;

        for (const btn of ctx.querySelectorAll('.ctx-item')) {
          btn.onclick = () => {
            const act = btn.dataset.act;
            if (act === 'newblock') {
              const wsp = window.Segment?.workspace;
              const vs = wsp ? wsp.panels.filter((p) => p.id.startsWith('chatview:')) : [];
              const openN = vs.filter((p) => wsp.isOpen(p.id)).length;
              const dup = vs.some((p) => p.id.startsWith(`chatview:${id}:`));
              if (dup || openN >= 3) { hideAll(); return; }
              wsp?.addPanel(chatViewPanel(client, chat));
            }
            else if (act === 'open') client.openRoom(id);
            else if (act === 'select') { selectionMode = true; selected.add(id); render(); }
            else if (act.startsWith('folder:')) {
              const fid = act.slice(7); const f = client.folders.find((x) => x.id === fid);
              if (f) client.updateFolder(fid, f.chats.includes(id) ? f.chats.filter((x) => x !== id) : [...f.chats, id]);
            }
            else if (act === 'info') {
              client.openRoom(id);
              setTimeout(() => document.querySelector('.panel[data-id="chat-room"] [data-el="head"]')?.click(), 0);
            }
            else if (act === 'pin') client.togglePin(id);
            else if (act === 'mute') {
              client.toggleMute(id);
              window.Segment?.toast?.(client.isMuted(id) ? 'Уведомления выключены' : 'Уведомления включены');
            }
            else if (act === 'archive') client.toggleArchive(id);
            else if (act === 'read') client.markRead(id);
            else if (act === 'unread') client.markUnread(id);
            else if (act === 'clear') {
              if (confirm(`Очистить историю чата «${chat.name}»?`)) client.clearHistory(id);
            }
            else if (act === 'rename') { openRename(id); return; }
            else if (act === 'invite') {
              client.createInvite(id)
                .then(async (link) => {
                  if (!link) return;
                  try { await navigator.clipboard.writeText(link); window.Segment?.toast?.('Ссылка-приглашение скопирована'); }
                  catch { prompt('Ссылка-приглашение:', link); }
                })
                .catch(() => window.Segment?.toast?.('Не удалось создать приглашение'));
            }
            else if (act === 'fullhistory') {
              if (confirm('Включить показ всей истории новым участникам? Отменить это будет нельзя.')) {
                client.enableFullHistory(id)
                  .then((room) => {
                    const c = client.chatById(id);
                    if (c && room) c.historyVisibility = room.historyVisibility;
                    window.Segment?.toast?.('Новые участники теперь видят всю историю');
                  })
                  .catch(() => window.Segment?.toast?.('Не удалось изменить видимость'));
              }
            }
            else if (act === 'remove') client.removeChat(id);
            hideAll();
          };
        }
      };

      const openPreview = (id, x, y) => {
        const chat = client.chatById(id); if (!chat) return;
        const lines = (client.messages[id] || []).filter((m) => !m.system && !m.deleted).slice(-5).reverse();
        preview.innerHTML = `<div class="chat-preview-head"><div class="chat-preview-avatar">${esc(chat.icon || chat.name[0])}</div><div><h3>${esc(chat.name)}</h3><span>${chat.type === 'dm' ? 'Личный чат' : chat.type === 'channel' ? 'Канал' : 'Групповой чат'}</span></div></div><div class="chat-preview-messages">${lines.length ? lines.map((m) => { const author = m.channelName || m.name || ''; return `<div class="chat-preview-line"><b>${esc(author)}</b>${author ? ': ' : ''}${esc(m.text || 'Вложение')}</div>`; }).join('') : '<div class="chat-preview-empty">Сообщений пока нет</div>'}</div><button class="chat-preview-open">Открыть чат</button>`;
        preview.classList.remove('hidden');
        const r = preview.getBoundingClientRect();
        preview.style.left = `${Math.max(8, Math.min(x + 10, innerWidth - r.width - 8))}px`;
        preview.style.top = `${Math.max(8, Math.min(y + 10, innerHeight - r.height - 8))}px`;
        preview.querySelector('.chat-preview-open').onclick = () => { preview.classList.add('hidden'); client.openRoom(id); };
      };

      fab.onclick = (e) => { e.stopPropagation(); toggleMenu(); };
      for (const item of menu.querySelectorAll('.fab-item')) {
        item.onclick = () => openForm(item.dataset.type);
      }
      body.querySelector('.nc-cancel').onclick = hideAll;
      createBtn.onclick = submit;
      nameIn.onkeydown = (e) => {
        if (e.key === 'Enter') submit();
        else if (e.key === 'Escape') hideAll();
      };

      const onOutside = (e) => {
        if (!fab.contains(e.target) && !menu.contains(e.target)
          && !dialog.contains(e.target) && !ctx.contains(e.target)) hideAll();
      };
      document.addEventListener('pointerdown', onOutside);

      const openMessage = (chatId, msgId) => {
        hideAll();
        client.openRoom(chatId);
        setTimeout(() => {
          const el = document.querySelector(`.panel[data-id="chat-room"] .msg[data-id="${msgId}"]`);
          if (!el) return;
          el.scrollIntoView({ block: 'center', behavior: 'smooth' });
          el.classList.remove('flash'); void el.offsetWidth; el.classList.add('flash');
        }, 60);
      };


      const filterCount = (f) => client.chats.filter((c) => {
        if (client.archived.has(c.id)) return false;
        const hasUnread = !!client.unread[c.id] || client.unreadDot.has(c.id);
        if (!hasUnread) return false;
        if (f === 'dm') return c.type === 'dm';
        if (f === 'groups') return c.type === 'chat';
        if (f === 'channels') return c.type === 'channel';
        return true;
      }).length;

      const updateFilterBadges = () => {
        for (const btn of filtersEl.querySelectorAll('.chat-filter')) {
          const n = filterCount(btn.dataset.filter);
          let badge = btn.querySelector('.filter-badge');
          if (n > 0) {
            if (!badge) { badge = document.createElement('span'); badge.className = 'filter-badge'; btn.appendChild(badge); }
            badge.textContent = n;
          } else if (badge) badge.remove();
        }
      };

      const render = () => {

        const searching = !!searchIn.value.trim();
        filtersEl.classList.toggle('hidden', searching || showArchived);
        archiveHead.classList.toggle('hidden', !showArchived);
        updateFilterBadges();
        for (const old of filtersEl.querySelectorAll('[data-folder]')) old.remove();
        for (const folder of client.folders) {
          const b = document.createElement('button'); b.className = `chat-filter${folderId === folder.id ? ' active' : ''}`;
          b.dataset.folder = folder.id; b.textContent = folder.name; b.onclick = () => { folderId = folderId === folder.id ? null : folder.id; render(); };
          b.oncontextmenu = (e) => {
            e.preventDefault();
            const name = prompt('Переименовать папку', folder.name);
            if (name === null) return;
            if (!name.trim()) { if (confirm(`Удалить папку «${folder.name}»?`)) { client.removeFolder(folder.id); if (folderId === folder.id) folderId = null; } }
            else client.renameFolder(folder.id, name);
          };
          filtersEl.insertBefore(b, filtersEl.querySelector('.folder-add'));
        }
        listEl.classList.toggle('selection-mode', selectionMode);
        selectionBar.classList.toggle('hidden', !selectionMode);
        selectionBar.querySelector('.selection-count').textContent = selected.size;
        renderChatList(listEl, client.view(), {
          onOpen: (id) => {
            if (id === '__archive__') { showArchived = true; render(); return; }
            hideAll();
            const draft = window.Segment?.forwardDraft;
            if (draft) {
              client.forwardMessage(id, draft);
              window.Segment.cancelForward?.();
              window.Segment.toast?.('Переслано');
            }
            client.openRoom(id);
          },
          onContext: openContext,
          onAvatarPreview: openPreview,
          onReorderPinned: (id, beforeId) => client.reorderPinned(id, beforeId),
          selected,
          selectionMode,
          folderId,
          onToggleSelect: (id) => {
            selected.has(id) ? selected.delete(id) : selected.add(id);
            if (!selected.size) selectionMode = false;
            render();
          },
          onOpenMessage: openMessage,
          onSwipeArchive: (id) => {
            client.toggleArchive(id);
            window.Segment?.toast?.(client.isArchived(id) ? 'В архиве' : 'Возвращено');
          },
          onSwipeRead: (id) => { client.markRead(id); },
          query: searchIn.value,
          filter,
          showArchived,
        });
      };

      body.querySelector('.folder-add').onclick = () => {
        const name = prompt('Название папки'); if (!name) return;
        const id = client.createFolder(name, [...selected]); folderId = id; selected.clear(); selectionMode = false; render();
      };
      selectionBar.onclick = (e) => {
        const act = e.target.closest('button')?.dataset.batch; if (!act) return;
        if (act === 'read') for (const id of selected) client.markRead(id);
        if (act === 'archive') for (const id of [...selected]) client.toggleArchive(id);
        if (act === 'delete' && confirm(`Удалить выбранные чаты (${selected.size})?`)) for (const id of [...selected]) client.removeChat(id);
        if (act === 'cancel' || act === 'read' || act === 'archive' || act === 'delete') { selected.clear(); selectionMode = false; render(); }
      };

      for (const btn of filtersEl.querySelectorAll('.chat-filter')) {
        btn.onclick = () => {
          filter = btn.dataset.filter;
          for (const b of filtersEl.querySelectorAll('.chat-filter')) b.classList.toggle('active', b === btn);
          render();
        };
      }
      body.querySelector('.archive-back').onclick = () => { showArchived = false; render(); };

      const off = client.on('chats', render);
      searchIn.oninput = render;


      body.querySelector('.chat-search').onclick = () => searchIn.focus();

      render();

      return () => { off(); ctx.remove(); preview.remove(); document.removeEventListener('pointerdown', onOutside); };
    },
  };
}
