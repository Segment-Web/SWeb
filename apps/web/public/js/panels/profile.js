
//



const PALETTE = ['#7c5cff', '#00d4ff', '#ff5c8a', '#3ddc84', '#ffb347', '#ff6b6b', '#4facfe', '#a166ff'];

export function profilePanel(client) {
  return {
    id: 'profile',
    title: 'Профиль',
    label: 'Профиль',
    icon: '👤',
    hideable: true,
    weight: 0.7,
    mount(body) {
      body.innerHTML = `
        <div class="profile">
          <div class="profile-avatar"></div>
          <div class="profile-info">
            <div class="profile-name">гость</div>
            <div class="profile-status">
              <span class="status-dot"></span>
              <span class="profile-state">не в сети</span>
            </div>
          </div>
          <button class="profile-settings" aria-label="Настройки">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>
          </button>
        </div>`;

      const avatarEl = body.querySelector('.profile-avatar');
      const nameEl = body.querySelector('.profile-name');
      const stateEl = body.querySelector('.profile-state');
      const dotEl = body.querySelector('.status-dot');
      const setProfile = (name) => {
        nameEl.textContent = name || 'гость';
        if (client.self.avatar) avatarEl.innerHTML = `<img src="${client.self.avatar}" alt="">`;
        else avatarEl.textContent = name ? name.trim()[0].toUpperCase() : '·';
        avatarEl.style.background = client.self.color;
      };

      const renderSettings = (settings, close) => {
        settings.innerHTML = `
          <div class="sheet-head">
            <b>Настройки</b>
          </div>
          <label class="settings-label">Имя</label>
          <div class="settings-name">
            <input data-el="name" maxlength="24" value="${(client.self.name || '').replace(/"/g, '&quot;')}">
            <button data-act="save">Сохранить</button>
          </div>
          <label class="settings-label">Цвет</label>
          <div class="settings-colors">
            ${PALETTE.map((c) => `<button class="settings-color${c === client.self.color ? ' active' : ''}" data-color="${c}" style="background:${c}"></button>`).join('')}
          </div>
          <label class="settings-label">Плотность интерфейса</label>
          <div class="settings-segmented">
            <button data-density="compact">Компактно</button><button data-density="comfortable">Обычно</button><button data-density="spacious">Просторно</button>
          </div>
          <label class="settings-label">Масштаб текста <span data-el="scaleValue"></span></label>
          <input class="settings-range" data-el="scale" type="range" min="0.9" max="1.15" step="0.05">
          <label class="settings-toggle"><input type="checkbox" data-el="reduce"><span>Меньше анимаций</span></label>
          <button class="settings-action" data-act="reset-layout">Сбросить раскладку панелей</button>
          <button class="ctx-item danger" data-act="logout">Выйти</button>`;

        const nameInput = settings.querySelector('[data-el="name"]');
        settings.querySelector('[data-act="save"]').onclick = async () => {
          const response = await fetch('/api/auth/profile', { method: 'PATCH', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: nameInput.value }) });
          const data = await response.json().catch(() => ({}));
          if (response.ok) {
            client.self = { ...client.self, ...data.user };
            client.storage.setName(data.user.name); setProfile(data.user.name);
            window.Segment?.toast?.('Имя обновлено');
          } else window.Segment?.toast?.('Не удалось обновить имя');
        };
        for (const btn of settings.querySelectorAll('.settings-color')) {
          btn.onclick = () => {
            fetch('/api/auth/profile', { method: 'PATCH', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ color: btn.dataset.color }) })
              .then((response) => response.json().then((data) => ({ response, data })))
              .then(({ response, data }) => { if (!response.ok) return; client.self = { ...client.self, ...data.user }; client.storage.setColor(data.user.color); setProfile(client.self.name); renderSettings(settings, close); });
          };
        }
        const prefs = window.Segment?.uiPrefs || {};
        for (const btn of settings.querySelectorAll('[data-density]')) {
          btn.classList.toggle('active', btn.dataset.density === (prefs.density || 'comfortable'));
          btn.onclick = () => { window.Segment?.saveUiPrefs?.({ density: btn.dataset.density }); renderSettings(settings, close); };
        }
        const scale = settings.querySelector('[data-el="scale"]'); const scaleValue = settings.querySelector('[data-el="scaleValue"]');
        scale.value = prefs.scale || 1; scaleValue.textContent = `${Math.round(scale.value * 100)}%`;
        scale.oninput = () => { scaleValue.textContent = `${Math.round(scale.value * 100)}%`; window.Segment?.saveUiPrefs?.({ scale: Number(scale.value) }); };
        const reduce = settings.querySelector('[data-el="reduce"]'); reduce.checked = !!prefs.reduceMotion;
        reduce.onchange = () => window.Segment?.saveUiPrefs?.({ reduceMotion: reduce.checked });
        settings.querySelector('[data-act="reset-layout"]').onclick = () => { window.Segment?.workspace?.resetLayout(); window.Segment?.toast?.('Раскладка сброшена'); close(); };
        settings.querySelector('[data-act="logout"]').onclick = async () => {
          await fetch('/api/auth/logout', { method: 'POST', credentials: 'same-origin' }).catch(() => {});
          client.logout();
          location.reload();
        };
      };

      const offs = [
        client.on('identity', ({ name }) => setProfile(name)),
        client.on('connection', ({ connected }) => {
          dotEl.classList.toggle('off', !connected);
          stateEl.textContent = connected ? 'в сети' : 'не в сети';
        }),
      ];

      body.querySelector('.profile-settings').onclick = (e) => {
        e.stopPropagation();
        window.Segment?.workspace?.openSurface({
          id: 'settings',
          sourceId: 'profile',
          minWidth: 320,
          maxWidth: 620,
          className: 'settings-surface',
          mount(settings, close) { renderSettings(settings, close); },
        });
      };

      setProfile(client.self.name);

      return () => { window.Segment?.workspace?.closeSurface('settings'); offs.forEach((off) => off()); };
    },
  };
}
