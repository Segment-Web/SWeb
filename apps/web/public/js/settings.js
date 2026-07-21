import { THEME_PRESETS, THEME_SCHEMA, normalizeThemePack } from './appearance.js';

const PALETTE = ['#7c5cff', '#00d4ff', '#ff5c8a', '#3ddc84', '#ffb347', '#ff6b6b', '#4facfe', '#a166ff'];
const FEATURES = { 'compact-bubbles': 'Компактные сообщения', 'square-media': 'Меньше скругления медиа', 'hide-reactions': 'Скрыть реакции' };
const PROFILE_BADGES = {
  early: { icon: '⚡', title: 'Ранний участник', text: 'С аккаунтом с раннего этапа Segment' },
  creator: { icon: '◆', title: 'Создатель', text: 'Создаёт собственные сообщества' },
  mods: { icon: '🧩', title: 'Модификатор', text: 'Использует модификации интерфейса' },
  supporter: { icon: '♥', title: 'Поддержка', text: 'Поддерживает развитие проекта' },
};
const escapeHtml = (value) => String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
const safeProfileImage = (value) => /^data:image\/(?:png|jpeg|webp);base64,[a-z0-9+/=]+$/i.test(String(value || '')) ? value : '';
const api = async (path, options = {}) => {
  const response = await fetch(path, { credentials: 'same-origin', headers: { 'Content-Type': 'application/json', ...(options.headers || {}) }, ...options });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || 'REQUEST_FAILED');
  return data;
};
const savePrefs = (patch) => window.Segment?.saveUiPrefs?.(patch);
const toast = (text) => window.Segment?.toast?.(text);
const field = (label, name, value = '', attrs = '') => `<label class="settings-field"><span>${label}</span><input name="${name}" value="${escapeHtml(value)}" ${attrs}></label>`;
const toggle = (name, label, checked, hint = '') => `<label class="settings-toggle-row"><span><b>${label}</b>${hint ? `<small>${hint}</small>` : ''}</span><input type="checkbox" name="${name}" ${checked ? 'checked' : ''}></label>`;
const iconPaths = {
  profile: '<circle cx="12" cy="8" r="4"/><path d="M4.5 20c.8-4 3.2-6 7.5-6s6.7 2 7.5 6"/>',
  privacy: '<rect x="5" y="10" width="14" height="10" rx="3"/><path d="M8 10V7a4 4 0 0 1 8 0v3"/>',
  appearance: '<path d="M12 3a9 9 0 1 0 0 18c1.5 0 2-1 1.2-2.1-.8-1.2.1-2.4 1.5-2.4H17a4 4 0 0 0 4-4.1A9 9 0 0 0 12 3Z"/><circle cx="7.5" cy="10" r=".8"/><circle cx="10" cy="6.7" r=".8"/><circle cx="14" cy="6.5" r=".8"/>',
  chats: '<path d="M20 15a3 3 0 0 1-3 3H9l-5 3v-6a3 3 0 0 1-1-2V7a3 3 0 0 1 3-3h11a3 3 0 0 1 3 3Z"/>',
  devices: '<rect x="4" y="3" width="16" height="13" rx="2"/><path d="M9 21h6M12 16v5"/>',
  storage: '<ellipse cx="12" cy="5" rx="8" ry="3"/><path d="M4 5v6c0 1.7 3.6 3 8 3s8-1.3 8-3V5M4 11v6c0 1.7 3.6 3 8 3s8-1.3 8-3v-6"/>',
  language: '<path d="M4 5h9M8.5 3v2c0 5-2 8-5 10M5 9c1.5 3 4 5 7 6M14 20l4-10 4 10M15.5 16h5"/>',
  mods: '<path d="M8 3v3M16 3v3M8 18v3M16 18v3M3 8h3M18 8h3M3 16h3M18 16h3"/><rect x="6" y="6" width="12" height="12" rx="3"/><circle cx="12" cy="12" r="2"/>',
};
const icon = (name) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${iconPaths[name] || ''}</svg>`;

const resizeAvatar = (file) => new Promise((resolve, reject) => {
  if (!file?.type.startsWith('image/')) return reject(new Error('INVALID'));
  const reader = new FileReader();
  reader.onerror = reject;
  reader.onload = () => {
    const image = new Image();
    image.onerror = reject;
    image.onload = () => {
      const size = 256; const canvas = document.createElement('canvas'); canvas.width = size; canvas.height = size;
      const ctx = canvas.getContext('2d'); const scale = Math.max(size / image.width, size / image.height);
      ctx.drawImage(image, (size - image.width * scale) / 2, (size - image.height * scale) / 2, image.width * scale, image.height * scale);
      resolve(canvas.toDataURL('image/jpeg', .86));
    };
    image.src = reader.result;
  };
  reader.readAsDataURL(file);
});

const resizeCover = (file) => new Promise((resolve, reject) => {
  if (!file?.type.startsWith('image/')) return reject(new Error('INVALID'));
  const reader = new FileReader(); reader.onerror = reject;
  reader.onload = () => {
    const image = new Image(); image.onerror = reject;
    image.onload = () => {
      const width = 1200; const height = 400; const canvas = document.createElement('canvas'); canvas.width = width; canvas.height = height;
      const ctx = canvas.getContext('2d'); const scale = Math.max(width / image.width, height / image.height);
      ctx.drawImage(image, (width - image.width * scale) / 2, (height - image.height * scale) / 2, image.width * scale, image.height * scale);
      resolve(canvas.toDataURL('image/jpeg', .82));
    };
    image.src = reader.result;
  };
  reader.readAsDataURL(file);
});

const normalizeMod = (raw) => {
  if (!raw || raw.schema !== 1 || raw.type !== 'declarative') throw new Error('INVALID');
  const id = String(raw.id || '').toLowerCase().replace(/[^a-z0-9-]/g, '').slice(0, 40);
  const name = String(raw.name || '').trim().slice(0, 60);
  const features = [...new Set((raw.features || []).filter((item) => item in FEATURES))];
  if (!id || !name || !features.length) throw new Error('INVALID');
  return { id, name, version: String(raw.version || '1.0.0').slice(0, 20), features, enabled: true };
};
const bytesToB64 = (bytes) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
const b64ToBytes = (text) => Uint8Array.from(atob(text.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(text.length / 4) * 4, '=')), (char) => char.charCodeAt(0));
const sealDevicePayload = async (value) => {
  const secret = crypto.getRandomValues(new Uint8Array(32)); const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await crypto.subtle.importKey('raw', secret, 'AES-GCM', false, ['encrypt']);
  const cipher = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(JSON.stringify(value))));
  return { secret: bytesToB64(secret), payload: `${bytesToB64(iv)}.${bytesToB64(cipher)}` };
};
const openDevicePayload = async (payload, secretText) => {
  const [ivText, cipherText] = String(payload).split('.');
  const key = await crypto.subtle.importKey('raw', b64ToBytes(secretText), 'AES-GCM', false, ['decrypt']);
  const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: b64ToBytes(ivText) }, key, b64ToBytes(cipherText));
  return JSON.parse(new TextDecoder().decode(plain));
};

export function mountSettings(root, close, client, renderIdentity, initialPage = 'home') {
  let page = initialPage;
  const prefs = () => window.Segment?.uiPrefs || {};
  const home = () => {
    const self = client.self;
    root.innerHTML = `<div class="settings-shell">
      <div class="settings-hero"><div class="settings-hero-avatar">${safeProfileImage(self.avatar) ? `<img src="${escapeHtml(self.avatar)}" alt="">` : escapeHtml(self.name?.[0]?.toUpperCase() || 'S')}</div><div><h2>${escapeHtml(self.name)}</h2><p>@${escapeHtml(self.username || '')}</p></div></div>
      <div class="settings-nav">
        ${[['profile','Аккаунт','Имя, username, фото и информация'],['appearance','Настройки чатов','Темы, масштаб и анимации'],['privacy','Конфиденциальность','Видимость профиля и данные'],['chats','Сообщения и медиа','Отправка и отображение'],['storage','Данные и память','Хранилище и локальные данные'],['devices','Устройства','Активные сеансы и перенос ключей'],['language','Язык и доступность','Русский язык и контраст'],['mods','Модификации','Безопасные дополнения интерфейса']].map(([id,title,desc]) => `<button class="settings-nav-item" data-page="${id}"><i>${icon(id)}</i><span><b>${title}</b><small>${desc}</small></span><em>›</em></button>`).join('')}
      </div><button class="settings-logout" data-action="logout">Выйти из аккаунта</button>
    </div>`;
    root.querySelectorAll('[data-page]').forEach((button) => { button.onclick = () => show(button.dataset.page); });
    root.querySelector('[data-action="logout"]').onclick = async () => { await fetch('/api/auth/logout', { method: 'POST', credentials: 'same-origin' }).catch(() => {}); client.logout(); location.reload(); };
  };
  const shell = (title, subtitle, body) => {
    root.innerHTML = `<div class="settings-shell settings-page"><header><button data-back aria-label="Назад">‹</button><div><h2>${title}</h2>${subtitle ? `<p>${subtitle}</p>` : ''}</div></header>${body}</div>`;
    root.querySelector('[data-back]').onclick = () => show('home');
  };
  const profile = () => {
    const self = client.self; const links = [...(self.links || []), {}, {}, {}].slice(0, 3); const meta = self.profile || {};
    const safeAvatar = safeProfileImage(self.avatar); const safeCover = safeProfileImage(meta.cover);
    const rooms = client.chats.filter((chat) => chat.type !== 'saved' && !chat.local);
    shell('Профиль', 'Эти данные будут видны другим пользователям', `<form class="settings-stack" data-profile>
      <div class="settings-cover-editor" style="${safeCover ? `background-image:url('${safeCover}')` : ''}"><span>Обложка профиля</span><label class="settings-file">Выбрать обложку<input data-cover-file type="file" accept="image/*"></label>${safeCover ? '<button type="button" data-cover-remove>Убрать</button>' : ''}</div>
      <div class="settings-avatar-editor"><div class="settings-avatar-preview">${safeAvatar ? `<img src="${safeAvatar}" alt="">` : escapeHtml(self.name?.[0] || 'S')}</div><label class="settings-file">Изменить фото<input type="file" accept="image/*"></label></div>
      ${field('Имя','name',self.name,'maxlength="40"')}${field('Username','username',self.username,'maxlength="24"')}${field('О себе','bio',self.bio,'maxlength="160"')}${field('Статус','status',self.status,'maxlength="80"')}
      <div class="settings-card"><b>Закреплённое сообщество</b><p>В профиле будет показано одно сообщество, участником которого вы являетесь.</p><select name="pinnedCommunity"><option value="">Не показывать</option>${rooms.map((chat) => `<option value="${escapeHtml(chat.id)}" ${meta.pinnedCommunity?.id === chat.id ? 'selected' : ''}>${escapeHtml(chat.icon || '💬')} ${escapeHtml(chat.name)}</option>`).join('')}</select></div>
      <div class="settings-card"><b>Закреплённое достижение</b><p>Выберите одно достижение, которое будет показано в профиле.</p><div class="settings-badge-grid">${Object.entries(PROFILE_BADGES).map(([id,badge]) => `<label><input type="radio" name="badge" value="${id}" ${(meta.pinnedBadges || [])[0] === id ? 'checked' : ''}><span><i>${badge.icon}</i><b>${badge.title}</b><small>${badge.text}</small></span></label>`).join('')}</div></div>
      <div class="settings-card"><b>Ссылки</b>${links.map((link, index) => `<div class="settings-link-row"><input name="linkLabel${index}" placeholder="Название" value="${escapeHtml(link.label)}"><input name="linkUrl${index}" placeholder="https://" value="${escapeHtml(link.url)}"></div>`).join('')}</div>
      <div class="settings-card settings-integrations"><b>Интеграции активности</b><div><span>Spotify</span><small>Подключение появится после настройки OAuth</small><button type="button" disabled>Скоро</button></div><div><span>Steam</span><small>Игровая активность будет показываться здесь</small><button type="button" disabled>Скоро</button></div></div>
      <div class="settings-card"><b>Цвет профиля</b><div class="settings-colors">${PALETTE.map((color) => `<button type="button" class="settings-color${color === self.color ? ' active' : ''}" data-color="${color}" style="background:${color}"></button>`).join('')}</div></div>
      <button class="settings-primary" type="submit">Сохранить</button></form>`);
    const form = root.querySelector('[data-profile]'); let avatar = safeAvatar; let cover = safeCover; let color = self.color;
    form.querySelector('.settings-avatar-editor input[type=file]').onchange = async (event) => { try { avatar = await resizeAvatar(event.target.files[0]); form.querySelector('.settings-avatar-preview').innerHTML = `<img src="${avatar}" alt="">`; } catch { toast('Не удалось обработать фото'); } };
    form.querySelector('[data-cover-file]').onchange = async (event) => { try { cover = await resizeCover(event.target.files[0]); const editor=form.querySelector('.settings-cover-editor'); editor.style.backgroundImage=`url('${cover}')`; } catch { toast('Не удалось обработать обложку'); } };
    form.querySelector('[data-cover-remove]')?.addEventListener('click',()=>{cover='';form.querySelector('.settings-cover-editor').style.backgroundImage='';});
    form.querySelectorAll('[data-color]').forEach((button) => { button.onclick = () => { color = button.dataset.color; form.querySelectorAll('[data-color]').forEach((item) => item.classList.toggle('active', item === button)); }; });
    form.onsubmit = async (event) => { event.preventDefault(); const data = new FormData(form); const links = [0,1,2].map((i) => ({ label: data.get(`linkLabel${i}`), url: data.get(`linkUrl${i}`) })).filter((item) => item.url.trim());
      try { const result = await api('/api/auth/profile', { method:'PATCH', body:JSON.stringify({ name:data.get('name'), username:data.get('username'), bio:data.get('bio'), status:data.get('status'), avatar, color, links, profile:{cover,pinnedBadges:data.getAll('badge'),pinnedCommunityId:data.get('pinnedCommunity')} }) }); client.self = { ...client.self, ...result.user }; client.storage.setName(result.user.name); client.storage.setUsername?.(result.user.username); client.storage.setAvatar?.(result.user.avatar); client.storage.setColor(result.user.color); client._emit('identity', { name: result.user.name, user: result.user }); renderIdentity(); toast('Профиль сохранён'); show('home'); } catch (error) { toast(error.message === 'USERNAME_TAKEN' ? 'Username уже занят' : 'Не удалось сохранить профиль'); }
    };
  };
  const privacy = () => {
    const value = client.self.privacy || {}; const options = '<option value="everyone">Все</option><option value="members">Общие чаты</option><option value="nobody">Никто</option>';
    shell('Конфиденциальность', 'Управляйте видимостью данных профиля', `<form class="settings-stack" data-privacy>${[['avatar','Фото профиля'],['bio','О себе'],['status','Статус'],['links','Ссылки']].map(([key,label]) => `<label class="settings-select-row"><span>${label}</span><select name="${key}">${options}</select></label>`).join('')}<div class="settings-note">Ваши имя и username всегда видны — по ним другие пользователи могут найти профиль.</div><button class="settings-primary">Сохранить</button></form>`);
    const form = root.querySelector('[data-privacy]'); Object.entries(value).forEach(([key, val]) => { if (form.elements[key]) form.elements[key].value = val; });
    form.onsubmit = async (event) => { event.preventDefault(); const data = new FormData(form); try { const result = await api('/api/auth/profile',{method:'PATCH',body:JSON.stringify({privacy:Object.fromEntries(['avatar','bio','status','links'].map((key)=>[key,data.get(key)]))})}); client.self={...client.self,...result.user}; toast('Настройки сохранены'); } catch { toast('Не удалось сохранить настройки'); } };
  };
  const appearance = () => {
    const p = prefs(); shell('Оформление', 'Встроенные темы и собственная палитра', `<div class="settings-stack"><div class="theme-grid">${THEME_PRESETS.map((theme) => `<button class="theme-card${(p.themeId || 'night') === theme.id ? ' active' : ''}" data-theme="${theme.id}"><span class="theme-preview" style="--preview-bg:${theme.tokens.bg || '#0b1320'};--preview-surface:${theme.tokens.surface || '#172433'};--preview-accent:${theme.tokens.accent || '#58a8e8'}"></span><b>${theme.name}</b><small>${theme.description}</small></button>`).join('')}</div><div class="settings-card"><b>Своя тема</b><p>Импортируйте безопасный JSON-файл палитры без скриптов.</p><textarea data-theme-json rows="6" spellcheck="false" placeholder='{"schema":1,"name":"My theme","tokens":{...}}'></textarea><div class="settings-inline"><button class="settings-secondary" data-import-theme>Импортировать</button><button class="settings-secondary" data-export-theme>Экспортировать</button></div></div>${toggle('reduceMotion','Меньше анимаций',!!p.reduceMotion)}<label class="settings-range-row"><span>Масштаб текста <b data-scale-value>${Math.round((p.scale || 1)*100)}%</b></span><input data-scale type="range" min="0.85" max="1.2" step="0.05" value="${p.scale || 1}"></label></div>`);
    root.querySelectorAll('[data-theme]').forEach((button) => { button.onclick = () => { savePrefs({themeId:button.dataset.theme}); appearance(); }; });
    root.querySelector('[name=reduceMotion]').onchange = (event) => savePrefs({reduceMotion:event.target.checked});
    const scale=root.querySelector('[data-scale]'); scale.oninput=()=>{root.querySelector('[data-scale-value]').textContent=`${Math.round(scale.value*100)}%`;savePrefs({scale:Number(scale.value)});};
    root.querySelector('[data-import-theme]').onclick=()=>{try{const theme=normalizeThemePack(JSON.parse(root.querySelector('[data-theme-json]').value));savePrefs({themeId:'custom',customTheme:theme});toast('Тема установлена');appearance();}catch{toast('Проверьте формат темы');}};
    root.querySelector('[data-export-theme]').onclick=async()=>{const theme=p.customTheme || {schema:THEME_SCHEMA,id:'my-theme',name:'My theme',author:'',tokens:{bg:'#0b1320',surface:'#172433',text:'#f5f8fb',accent:'#58a8e8'}};await navigator.clipboard.writeText(JSON.stringify(theme,null,2));toast('JSON темы скопирован');};
  };
  const chats = () => { const p=prefs(); shell('Чаты','Поведение сообщений и медиа',`<div class="settings-stack">${toggle('sendByEnter','Отправка по Enter',p.sendByEnter !== false,'Если выключено, отправка по Ctrl+Enter')}${toggle('mediaPreview','Предпросмотр медиа',p.mediaPreview !== false)}${toggle('showChannelAvatars','Аватары сообщений каналов',!!p.showChannelAvatars)}<div class="settings-card"><b>Плотность интерфейса</b><div class="settings-segmented"><button data-density="compact">Компактно</button><button data-density="comfortable">Обычно</button><button data-density="spacious">Просторно</button></div></div><button class="settings-secondary" data-reset-layout>Сбросить расположение панелей</button></div>`); root.querySelectorAll('input[type=checkbox]').forEach((input)=>input.onchange=()=>savePrefs({[input.name]:input.checked})); root.querySelectorAll('[data-density]').forEach((button)=>{button.classList.toggle('active',button.dataset.density===(p.density||'comfortable'));button.onclick=()=>{savePrefs({density:button.dataset.density});chats();};}); root.querySelector('[data-reset-layout]').onclick=()=>{window.Segment?.workspace?.resetLayout();toast('Расположение сброшено');close();}; };
  const devices = () => {
    shell('Устройства','Активные сеансы аккаунта',`<div class="settings-stack"><div class="settings-card"><b>Ключи шифрования устройств</b><p>До пяти устройств. Если вход на новом устройстве остановлен лимитом, удалите здесь старую запись.</p><div data-crypto-devices class="settings-sessions"><div class="settings-session-loading">Загрузка…</div></div></div><div data-sessions class="settings-sessions"><div class="settings-session-loading">Загрузка…</div></div><div class="settings-card"><b>Связать новое устройство</b><p>Одноразовый код переносит ключи истории и черновики в зашифрованном виде.</p><button class="settings-secondary" data-make-link>Создать код</button><div class="device-link-code hidden" data-link-code><span></span><button data-copy-link>Копировать</button></div><div class="device-link-claim"><input data-claim-code placeholder="Код с другого устройства"><button data-claim-link>Подключить</button></div></div></div>`);
    const cryptoBox=root.querySelector('[data-crypto-devices]');
    api('/api/auth/devices').then(({devices})=>{const currentId=client.kit?.deviceId;cryptoBox.innerHTML=devices.map((device)=>`<div class="settings-session${device.deviceId===currentId?' current':''}" data-device-id="${escapeHtml(device.deviceId)}"><div class="settings-session-icon">${device.deviceId===currentId?'●':'○'}</div><div class="settings-session-copy"><b>${device.deviceId===currentId?'Это устройство':'Устройство шифрования'}</b><span>${escapeHtml(new Date(device.lastSeenAt).toLocaleString('ru'))}</span></div>${device.deviceId===currentId?'':'<button data-forget-device>Удалить</button>'}</div>`).join('')||'<div class="settings-note">Устройств пока нет</div>';cryptoBox.querySelectorAll('[data-forget-device]').forEach((button)=>button.onclick=async()=>{const row=button.closest('[data-device-id]');await api(`/api/auth/devices/${row.dataset.deviceId}`,{method:'DELETE'});row.remove();toast('Устройство удалено');});}).catch(()=>{cryptoBox.innerHTML='<div class="settings-note">Не удалось загрузить ключи устройств</div>';});
    const box=root.querySelector('[data-sessions]');
    api('/api/auth/sessions').then(({sessions})=>{box.innerHTML=sessions.map((s)=>`<div class="settings-session${s.current?' current':''}" data-id="${s.id}"><div class="settings-session-icon">${s.current?'●':'○'}</div><div class="settings-session-copy"><b>${s.current?'Это устройство':'Браузер'}</b><span>${escapeHtml(new Date(s.last_seen_at).toLocaleString('ru'))} · ${escapeHtml(s.ip||'IP скрыт')}</span></div>${s.current?'':'<button data-revoke>Завершить</button>'}</div>`).join('');box.querySelectorAll('[data-revoke]').forEach((button)=>button.onclick=async()=>{const row=button.closest('[data-id]');await api(`/api/auth/sessions/${row.dataset.id}`,{method:'DELETE'});row.remove();toast('Сеанс завершён');});}).catch(()=>{box.innerHTML='<div class="settings-note">Не удалось загрузить устройства</div>';});
    let generatedCode='';
    root.querySelector('[data-make-link]').onclick=async()=>{try{const sealed=await sealDevicePayload({historyKeys:client.historyKeysExport(),historyKeyArchive:client.historyKeyArchiveExport?.()||{},historyKeyEpochs:Object.fromEntries(client.historyKeyEpochs||[]),drafts:client.storage.getDrafts?.()||{}});const data=await api('/api/auth/device-links',{method:'POST',body:JSON.stringify({payload:sealed.payload})});generatedCode=`${data.token}.${sealed.secret}`;const row=root.querySelector('[data-link-code]');row.querySelector('span').textContent=generatedCode;row.classList.remove('hidden');}catch{toast('Не удалось создать код');}};
    root.querySelector('[data-copy-link]').onclick=async()=>{if(generatedCode){await navigator.clipboard.writeText(generatedCode);toast('Код скопирован');}};
    root.querySelector('[data-claim-link]').onclick=async()=>{const full=root.querySelector('[data-claim-code]').value.trim();const at=full.lastIndexOf('.');if(at<1){toast('Неверный код');return;}try{const data=await api('/api/auth/device-links/claim',{method:'POST',body:JSON.stringify({token:full.slice(0,at)})});const payload=await openDevicePayload(data.payload,full.slice(at+1));client._adoptHistoryKeys(payload.historyKeys||{},payload.historyKeyEpochs||{});client.historyKeyArchive=new Map(Object.entries(payload.historyKeyArchive||{}));client.historyKeyEpochs=new Map(Object.entries(payload.historyKeyEpochs||{}).map(([roomId,epoch])=>[roomId,Number(epoch)||0]));client.storage.setHistoryKeyArchive?.(payload.historyKeyArchive||{});client.storage.setHistoryKeyEpochs?.(payload.historyKeyEpochs||{});client.storage.setDrafts?.(payload.drafts||{});toast('Устройство подключено');}catch{toast('Код истёк или повреждён');}};
  };
  const storage = () => { const bytes=Object.keys(localStorage).reduce((sum,key)=>sum+(localStorage.getItem(key)?.length||0)*2,0); shell('Данные и память','Данные этого браузера',`<div class="settings-stack"><div class="storage-card"><span>Занято локально</span><b>${bytes<1024?`${bytes} Б`:`${(bytes/1024).toFixed(1)} КБ`}</b><small>Ключи шифрования, черновики и параметры интерфейса</small></div><button class="settings-secondary" data-clear-drafts>Очистить черновики</button><div class="settings-note">История сообщений и медиа хранится на сервере. Локальные ключи не удаляются без выхода из аккаунта.</div></div>`);root.querySelector('[data-clear-drafts]').onclick=()=>{client.storage.setDrafts?.({});toast('Черновики очищены');}; };
  const language = () => { const p=prefs(); shell('Язык и доступность','Параметры чтения интерфейса',`<div class="settings-stack"><label class="settings-select-row"><span>Язык</span><select disabled><option>Русский</option></select></label>${toggle('highContrast','Повышенный контраст',!!p.highContrast)}${toggle('reduceMotion','Меньше анимаций',!!p.reduceMotion)}</div>`);root.querySelectorAll('input').forEach((input)=>input.onchange=()=>savePrefs({[input.name]:input.checked})); };
  const mods = () => { const installed=prefs().installedMods||[]; shell('Модификации','Только декларативные изменения интерфейса',`<div class="settings-stack"><div class="settings-note">Модификации Segment не запускают JavaScript и не получают доступ к сообщениям. Поддерживаются только заранее разрешённые визуальные функции.</div><div data-mod-list>${installed.map((mod)=>`<div class="mod-card"><span><b>${escapeHtml(mod.name)}</b><small>v${escapeHtml(mod.version)} · ${(mod.features||[]).map((f)=>FEATURES[f]).join(', ')}</small></span><label><input type="checkbox" data-mod="${escapeHtml(mod.id)}" ${mod.enabled?'checked':''}></label><button data-remove="${escapeHtml(mod.id)}">×</button></div>`).join('')||'<div class="settings-empty">Модификаций пока нет</div>'}</div><div class="settings-card"><b>Установить манифест</b><textarea data-mod-json rows="6" spellcheck="false" placeholder='{"schema":1,"type":"declarative","id":"compact","name":"Compact","version":"1.0.0","features":["compact-bubbles"]}'></textarea><button class="settings-primary" data-install-mod>Установить</button></div></div>`);root.querySelectorAll('[data-mod]').forEach((input)=>input.onchange=()=>{savePrefs({installedMods:installed.map((mod)=>mod.id===input.dataset.mod?{...mod,enabled:input.checked}:mod)});});root.querySelectorAll('[data-remove]').forEach((button)=>button.onclick=()=>{savePrefs({installedMods:installed.filter((mod)=>mod.id!==button.dataset.remove)});mods();});root.querySelector('[data-install-mod]').onclick=()=>{try{const mod=normalizeMod(JSON.parse(root.querySelector('[data-mod-json]').value));savePrefs({installedMods:[...installed.filter((item)=>item.id!==mod.id),mod]});toast('Модификация установлена');mods();}catch{toast('Манифест не поддерживается');}}; };
  const pages={home,profile,privacy,appearance,chats,devices,storage,language,mods};
  const show=(next)=>{page=next;pages[page]();};
  show(page);
  return () => {};
}
