import { mountSettings } from '../settings.js';

export function profilePanel(client) {
  return {
    id: 'profile', title: 'Профиль', label: 'Профиль', icon: '👤', hideable: true, weight: 0.7,
    mount(body) {
      body.innerHTML = `<div class="profile">
        <div class="profile-avatar"></div>
        <div class="profile-info"><div class="profile-name">гость</div><div class="profile-status"><span class="status-dot"></span><span class="profile-state">не в сети</span></div></div>
        <button class="profile-settings" aria-label="Настройки"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg></button>
      </div>`;
      const avatar = body.querySelector('.profile-avatar');
      const name = body.querySelector('.profile-name');
      const state = body.querySelector('.profile-state');
      const dot = body.querySelector('.status-dot');
      const renderIdentity = () => {
        name.textContent = client.self.name || 'гость';
        avatar.innerHTML = client.self.avatar ? `<img src="${client.self.avatar}" alt="">` : '';
        if (!client.self.avatar) avatar.textContent = client.self.name?.trim()[0]?.toUpperCase() || '·';
        avatar.style.background = client.self.color;
      };
      const offs = [
        client.on('identity', renderIdentity),
        client.on('connection', ({ connected }) => { dot.classList.toggle('off', !connected); state.textContent = connected ? 'в сети' : 'не в сети'; }),
      ];
      body.querySelector('.profile-settings').onclick = (event) => {
        event.stopPropagation();
        window.Segment?.workspace?.openSurface({
          id: 'settings', sourceId: 'profile', minWidth: 370, maxWidth: 720, className: 'settings-surface',
          mount(settings, close) { return mountSettings(settings, close, client, renderIdentity); },
        });
      };
      renderIdentity();
      return () => { window.Segment?.workspace?.closeSurface('settings'); offs.forEach((off) => off()); };
    },
  };
}
