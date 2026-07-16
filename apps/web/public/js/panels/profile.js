import { mountSettings } from '../settings.js';

const escapeHtml = (value) => String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
const avatarHtml = (user, className) => `<div class="${className}" style="background:${user.color || 'var(--accent)'}">${user.avatar ? `<img src="${user.avatar}" alt="">` : escapeHtml(user.name?.trim()[0]?.toUpperCase() || 'S')}</div>`;

function mountProfileView(root, close, client, openSettings) {
  const self = client.self;
  const links = Array.isArray(self.links) ? self.links : [];
  root.innerHTML = `<div class="profile-view">
    <div class="profile-view-cover" style="--profile-color:${self.color || 'var(--accent)'}"></div>
    <div class="profile-view-main">
      ${avatarHtml(self, 'profile-view-avatar')}
      <div class="profile-view-identity"><h2>${escapeHtml(self.name)}</h2><p>@${escapeHtml(self.username || '')}</p></div>
      <button class="profile-view-edit" type="button">Изменить</button>
    </div>
    ${self.status ? `<div class="profile-view-status"><i></i>${escapeHtml(self.status)}</div>` : ''}
    <section class="profile-view-section">
      ${self.bio ? `<div class="profile-view-row"><span>О себе</span><p>${escapeHtml(self.bio)}</p></div>` : `<div class="profile-view-row muted"><span>О себе</span><p>Расскажите немного о себе</p></div>`}
      <div class="profile-view-row"><span>Username</span><p>@${escapeHtml(self.username || '')}</p></div>
      ${links.map((link) => `<a class="profile-view-row" href="${escapeHtml(link.url)}" target="_blank" rel="noreferrer"><span>${escapeHtml(link.label)}</span><p>${escapeHtml(link.url.replace(/^https:\/\//, ''))}</p></a>`).join('')}
    </section>
    <section class="profile-view-section profile-view-actions">
      <button type="button" data-action="settings">Настройки профиля</button>
      <button type="button" data-action="copy">Скопировать ссылку</button>
    </section>
  </div>`;
  const edit = () => { close(); requestAnimationFrame(openSettings); };
  root.querySelector('.profile-view-edit').onclick = edit;
  root.querySelector('[data-action=settings]').onclick = edit;
  root.querySelector('[data-action=copy]').onclick = async () => {
    await navigator.clipboard.writeText(`${location.origin}/@${self.username}`);
    window.Segment?.toast?.('Ссылка на профиль скопирована');
  };
}

export function profilePanel(client) {
  return {
    id: 'profile', title: 'Профиль', label: 'Профиль', icon: '👤', hideable: true, weight: 0.7,
    mount(body) {
      body.innerHTML = `<div class="profile-shell">
        <div class="profile" role="button" tabindex="0" aria-label="Открыть профиль">
          <div class="profile-avatar"></div>
          <div class="profile-info"><div class="profile-name">гость</div><div class="profile-status"><span class="status-dot"></span><span class="profile-state">не в сети</span></div></div>
          <button class="profile-settings" aria-label="Настройки"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg></button>
        </div>
        <div class="profile-panel-details">
          <div class="profile-panel-card"><span>Аккаунт</span><b class="profile-panel-username"></b><p class="profile-panel-bio"></p></div>
          <button class="profile-panel-open" type="button">Открыть профиль</button>
        </div>
      </div>`;
      const avatar = body.querySelector('.profile-avatar');
      const name = body.querySelector('.profile-name');
      const state = body.querySelector('.profile-state');
      const dot = body.querySelector('.status-dot');
      const panelUsername = body.querySelector('.profile-panel-username');
      const panelBio = body.querySelector('.profile-panel-bio');
      const renderIdentity = () => {
        name.textContent = client.self.name || 'гость';
        avatar.innerHTML = client.self.avatar ? `<img src="${client.self.avatar}" alt="">` : '';
        if (!client.self.avatar) avatar.textContent = client.self.name?.trim()[0]?.toUpperCase() || '·';
        avatar.style.background = client.self.color;
        panelUsername.textContent = `@${client.self.username || ''}`;
        panelBio.textContent = client.self.bio || client.self.status || 'Добавьте описание профиля';
      };
      const offs = [
        client.on('identity', renderIdentity),
        client.on('connection', ({ connected }) => { dot.classList.toggle('off', !connected); state.textContent = connected ? 'в сети' : 'не в сети'; }),
      ];
      const openSettings = () => window.Segment?.workspace?.openSurface({
        id: 'settings', sourceId: 'profile', minWidth: 370, maxWidth: 720, className: 'settings-surface',
        mount(settings, close) { return mountSettings(settings, close, client, renderIdentity); },
      });
      const openProfile = () => window.Segment?.workspace?.openSurface({
        id: 'profile-view', sourceId: 'profile', minWidth: 370, maxWidth: 620, className: 'profile-view-surface',
        mount(root, close) { mountProfileView(root, close, client, openSettings); },
      });
      body.querySelector('.profile-settings').onclick = (event) => { event.stopPropagation(); openSettings(); };
      const summary = body.querySelector('.profile');
      summary.onclick = openProfile;
      summary.onkeydown = (event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); openProfile(); } };
      body.querySelector('.profile-panel-open').onclick = openProfile;
      renderIdentity();
      return () => { window.Segment?.workspace?.closeSurface(); offs.forEach((off) => off()); };
    },
  };
}
