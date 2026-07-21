import { ICONS } from './icons.js';
import { esc } from './util.js';

const ROOM_TYPES = {
  channel: { label: 'Канал', title: 'Новый канал', icon: '📢', placeholder: 'Название канала', hint: 'Публичные публикации для подписчиков' },
  chat: { label: 'Группа', title: 'Новая группа', icon: '💬', placeholder: 'Название группы', hint: 'Общение и обмен файлами для участников' },
  dm: { label: 'Личный чат', title: 'Новое сообщение', icon: '👤', placeholder: 'Имя собеседника', hint: 'Приватный диалог один на один' },
};

const roomTypeLabel = (type) => ({ channel: 'Канал', chat: 'Групповой чат', dm: 'Личный чат', saved: 'Избранное' }[type] || 'Чат');
const slugify = (value) => String(value || '').toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 32) || 'ch-generated';
const roomAvatar = (chat, className = 'room-surface-avatar') => `<div class="${className}">${esc(chat.icon || chat.name?.[0] || '💬')}</div>`;

export function openRoomCreator(client, sourceId = 'chat-list', initialType = 'chat') {
  let type = ROOM_TYPES[initialType] ? initialType : 'chat';
  return window.Segment?.workspace?.openSurface({
    id: 'room-create', sourceId, minWidth: 390, maxWidth: 620, className: 'room-manager-surface',
    mount(root, close) {
      const render = () => {
        const preset = ROOM_TYPES[type];
        root.innerHTML = `<div class="room-manager room-creator">
          <header class="room-manager-head"><div><span>Создание</span><h2>${preset.title}</h2></div></header>
          <div class="room-type-switch" role="tablist">
            ${Object.entries(ROOM_TYPES).map(([id, item]) => `<button type="button" data-room-type="${id}" class="${id === type ? 'active' : ''}"><span>${item.icon}</span>${item.label}</button>`).join('')}
          </div>
          <form class="room-manager-form">
            <div class="room-create-identity">
              <label class="room-icon-field"><span>Значок</span><input name="icon" maxlength="16" value="${preset.icon}" aria-label="Значок"></label>
              <label class="room-main-field"><span>Название</span><input name="name" maxlength="64" placeholder="${preset.placeholder}" autocomplete="off" required></label>
            </div>
            <p class="room-manager-hint">${preset.hint}</p>
            ${type === 'channel' ? `<div class="room-manager-card room-channel-address"><span>Публичная ссылка</span><b>${esc(location.host)}/c/<i data-channel-slug>channel</i></b><small>Адрес создаётся из названия и позже остаётся постоянным.</small></div>` : ''}
            <div class="room-manager-card room-create-summary">
              <div>${ICONS.info}<span><b>${type === 'channel' ? 'Публичный канал' : 'Закрытое пространство'}</b><small>${type === 'channel' ? 'Канал виден по ссылке, публиковать может владелец.' : 'Войти смогут только приглашённые участники.'}</small></span></div>
              <div>${ICONS.image}<span><b>Медиа и файлы</b><small>История и вложения синхронизируются между устройствами.</small></span></div>
            </div>
            <div class="room-manager-actions"><button type="button" class="room-secondary" data-cancel>Отмена</button><button type="submit" class="room-primary">Создать</button></div>
          </form>
        </div>`;
        const form = root.querySelector('form');
        const name = form.elements.name;
        const slug = root.querySelector('[data-channel-slug]');
        name.oninput = () => { if (slug) slug.textContent = slugify(name.value); };
        for (const button of root.querySelectorAll('[data-room-type]')) button.onclick = () => { type = button.dataset.roomType; render(); };
        root.querySelector('[data-cancel]').onclick = close;
        form.onsubmit = async (event) => {
          event.preventDefault();
          const submit = form.querySelector('[type="submit"]');
          submit.disabled = true; submit.textContent = 'Создаём…';
          const chat = await client.createChat({ name: name.value, icon: form.elements.icon.value, type });
          if (chat) { close(); window.Segment?.toast?.(`${ROOM_TYPES[type].label} создан${type === 'channel' ? '' : type === 'chat' ? 'а' : ''}`); }
          else { submit.disabled = false; submit.textContent = 'Создать'; name.focus(); window.Segment?.toast?.('Не удалось создать'); }
        };
        requestAnimationFrame(() => name.focus());
      };
      render();
    },
  });
}

export function openRoomSettings(client, roomId, sourceId = 'chat-room') {
  const chat = client.chatById(roomId);
  if (!chat) return null;
  return window.Segment?.workspace?.openSurface({
    id: `room-settings:${roomId}`, sourceId, minWidth: 390, maxWidth: 680, className: 'room-manager-surface',
    mount(root, close) {
      let disposed = false;
      const showInvites = async () => {
        let invites;
        try { invites = await client.listInvites(roomId); }
        catch { window.Segment?.toast?.('Не удалось загрузить приглашения'); return; }
        if (disposed) return;
        const rows = invites.map((invite) => {
          const expires = new Date(invite.expires_at || invite.expiresAt).toLocaleString('ru-RU');
          return `<div class="room-invite-row"><span><b>${Number(invite.uses || 0)} из ${Number(invite.max_uses || invite.maxUses || 20)} использований</b><small>Действует до ${esc(expires)}</small></span><button type="button" data-revoke-invite="${esc(invite.id)}">Отозвать</button></div>`;
        }).join('');
        root.innerHTML = `<div class="room-manager room-settings"><header class="room-manager-head"><button type="button" data-invites-back aria-label="Назад">‹</button><div><span>Доступ</span><h2>Пригласительные ссылки</h2></div></header><section class="room-settings-section"><div class="room-settings-list">${rows || '<div class="room-manager-hint">Активных ссылок нет</div>'}</div><button type="button" class="room-primary room-save" data-create-invite>Создать и скопировать ссылку</button></section></div>`;
        root.querySelector('[data-invites-back]').onclick = render;
        root.querySelector('[data-create-invite]').onclick = async () => {
          const link = await client.createInvite(roomId).catch(() => null);
          if (!link) { window.Segment?.toast?.('Не удалось создать ссылку'); return; }
          await navigator.clipboard.writeText(link); window.Segment?.toast?.('Ссылка скопирована'); await showInvites();
        };
        for (const button of root.querySelectorAll('[data-revoke-invite]')) button.onclick = async () => {
          await client.revokeInvite(roomId, button.dataset.revokeInvite).catch(() => null);
          await showInvites();
        };
      };
      const render = () => {
        if (disposed) return;
        const current = client.chatById(roomId);
        if (!current) { close(); return; }
        const owner = client.canEditChat(roomId);
        const removeLabel = owner
          ? ({ channel: 'Удалить канал', chat: 'Удалить группу', dm: 'Удалить чат' }[current.type] || 'Удалить чат')
          : ({ channel: 'Покинуть канал', chat: 'Покинуть группу', dm: 'Удалить чат' }[current.type] || 'Покинуть чат');
        const muted = client.isMuted(roomId);
        const pinned = client.pinned.has(roomId);
        const archived = client.isArchived(roomId);
        root.innerHTML = `<div class="room-manager room-settings">
          <div class="room-settings-hero">${roomAvatar(current)}<div><h2>${esc(current.name)}</h2><p>${roomTypeLabel(current.type)}${current.slug ? ` · @${esc(current.slug)}` : ''}</p></div></div>
          ${owner ? `<form class="room-manager-form room-identity-form">
            <h3>Оформление</h3>
            <div class="room-create-identity">
              <label class="room-icon-field"><span>Значок</span><input name="icon" maxlength="16" value="${esc(current.icon || '')}"></label>
              <label class="room-main-field"><span>Название</span><input name="name" maxlength="64" value="${esc(current.name)}" required></label>
            </div>
            <button class="room-primary room-save" type="submit">Сохранить</button>
          </form>` : ''}
          <section class="room-settings-section"><h3>Чат</h3><div class="room-settings-list">
            <button type="button" data-action="pin">${pinned ? ICONS.unpin : ICONS.pin}<span><b>${pinned ? 'Открепить' : 'Закрепить'}</b><small>Положение в списке чатов</small></span><em>›</em></button>
            <button type="button" data-action="mute">${muted ? ICONS.bell : ICONS.bellOff}<span><b>${muted ? 'Включить звук' : 'Выключить звук'}</b><small>Общие уведомления этой комнаты</small></span><em>›</em></button>
            ${current.type !== 'saved' ? `<button type="button" data-action="archive">${ICONS.archive}<span><b>${archived ? 'Вернуть из архива' : 'Перенести в архив'}</b><small>Скрыть из основного списка</small></span><em>›</em></button>` : ''}
            ${owner ? `<button type="button" data-action="invite">${ICONS.open}<span><b>Пригласительные ссылки</b><small>Создание и отзыв активных ссылок</small></span><em>›</em></button>` : ''}
          </div></section>
          ${owner && (current.type === 'chat' || current.type === 'channel') ? `<section class="room-settings-section"><h3>История</h3><div class="room-settings-list">
            <button type="button" data-action="history" ${current.historyVisibility === 'full' ? 'disabled' : ''}>${ICONS.info}<span><b>${current.historyVisibility === 'full' ? 'Вся история доступна' : 'Открыть всю историю'}</b><small>${current.historyVisibility === 'full' ? 'Новые участники видят сообщения с самого начала.' : 'Необратимо: новые участники увидят старые сообщения.'}</small></span><em>›</em></button>
          </div></section>` : ''}
          <section class="room-settings-section"><h3>Данные</h3><div class="room-settings-list danger-list">
            <button type="button" data-action="clear">${ICONS.broom}<span><b>Очистить историю</b><small>Удалить сообщения только из вашей истории</small></span><em>›</em></button>
            ${current.type !== 'saved' ? `<button type="button" data-action="remove">${ICONS.logout}<span><b>${removeLabel}</b><small>${owner ? 'Комната и её история будут удалены для всех.' : 'Вы потеряете доступ к комнате.'}</small></span><em>›</em></button>` : ''}
          </div></section>
        </div>`;

        const form = root.querySelector('.room-identity-form');
        if (form) form.onsubmit = (event) => {
          event.preventDefault();
          if (client.updateChat(roomId, { name: form.elements.name.value, icon: form.elements.icon.value })) {
            window.Segment?.toast?.('Настройки сохранены'); render();
          }
        };
        for (const button of root.querySelectorAll('[data-action]')) button.onclick = async () => {
          const action = button.dataset.action;
          if (action === 'pin') client.togglePin(roomId);
          else if (action === 'mute') client.toggleMute(roomId);
          else if (action === 'archive') client.toggleArchive(roomId);
          else if (action === 'invite') {
            await showInvites(); return;
          } else if (action === 'history' && confirm('Открыть всю историю новым участникам? Это действие нельзя отменить.')) {
            const updated = await client.enableFullHistory(roomId).catch(() => null);
            if (updated) { current.historyVisibility = updated.historyVisibility; window.Segment?.toast?.('Вся история теперь доступна'); }
          } else if (action === 'clear' && confirm(`Очистить историю «${current.name}» на этом аккаунте?`)) client.clearHistory(roomId);
          else if (action === 'remove' && confirm(owner ? `Удалить «${current.name}» для всех?` : `Покинуть «${current.name}»?`)) { client.removeChat(roomId); close(); return; }
          render();
        };
      };
      render();
      return () => { disposed = true; };
    },
  });
}
