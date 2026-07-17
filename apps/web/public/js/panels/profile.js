import { mountSettings } from '../settings.js';
import { esc } from '../util.js';
import { ICONS } from '../icons.js';

const BADGES = {
  early: { icon: '⚡', title: 'Ранний участник', text: 'С аккаунтом с раннего этапа Segment' },
  creator: { icon: '◆', title: 'Создатель', text: 'Развивает собственные сообщества' },
  mods: { icon: '🧩', title: 'Модификатор', text: 'Настраивает Segment под себя' },
  supporter: { icon: '♥', title: 'Поддержка', text: 'Поддерживает развитие проекта' },
};

const avatarHtml = (user, className) => `<div class="${className}" style="background:${user.color || 'var(--accent)'}">${user.avatar ? `<img src="${esc(user.avatar)}" alt="">` : esc(user.name?.trim()[0]?.toUpperCase() || 'S')}</div>`;
const profileApi = async (patch) => {
  const response = await fetch('/api/auth/profile', { method:'PATCH', credentials:'same-origin', headers:{'Content-Type':'application/json'}, body:JSON.stringify(patch) });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || 'REQUEST_FAILED');
  return data.user;
};

const resizeProfileImage = (file, { width, height, quality = .84 }) => new Promise((resolve, reject) => {
  if (!file?.type?.startsWith('image/')) return reject(new Error('INVALID_IMAGE'));
  const reader = new FileReader();
  reader.onerror = reject;
  reader.onload = () => {
    const image = new Image();
    image.onerror = reject;
    image.onload = () => {
      const canvas = document.createElement('canvas'); canvas.width = width; canvas.height = height;
      const context = canvas.getContext('2d'); const scale = Math.max(width / image.width, height / image.height);
      context.drawImage(image, (width - image.width * scale) / 2, (height - image.height * scale) / 2, image.width * scale, image.height * scale);
      resolve(canvas.toDataURL('image/jpeg', quality));
    };
    image.src = reader.result;
  };
  reader.readAsDataURL(file);
});

function collectProfileContent(client, user, { includeShared = true } = {}) {
  const posts = Array.isArray(user.profile?.publications) ? user.profile.publications.slice(0,100).reverse() : [];
  const media = []; const files = []; const links = [];
  const matches = (message) => {
    if (message.system || message.deleted || message.channelName) return false;
    if (user.id && message.authorId) return message.authorId === user.id;
    if (user.username && message.username) return message.username === user.username;
    return message.name === user.name;
  };
  if (!includeShared) return { posts, media, files, links };
  for (const [roomId, messages] of Object.entries(client.messages || {})) {
    const room = client.chatById(roomId);
    for (const message of messages || []) {
      if (!matches(message)) continue;
      if (message.text) for (const url of message.text.match(/https?:\/\/[^\s]+/g) || []) links.push({ url, text: message.text, room: room?.name || 'Чат' });
      for (const attachment of message.attachments || []) {
        const entry = { ...attachment, room: room?.name || 'Чат', message };
        if (['photo','video','circle'].includes(attachment.kind)) media.push(entry);
        else files.push(entry);
      }
    }
  }
  return { posts, media: media.reverse(), files: files.reverse(), links: links.reverse() };
}

function renderTabContent(tab, content) {
  if (tab === 'media') return content.media.length ? `<div class="profile-media-grid">${content.media.map((item,index) => `<button data-profile-media="${index}"><img src="${esc(item.poster || item.data || '')}" alt="">${item.kind !== 'photo' ? '<span>▶</span>' : ''}</button>`).join('')}</div>` : '<div class="profile-content-empty">Медиа пока нет</div>';
  if (tab === 'files') return content.files.length ? `<div class="profile-files">${content.files.map((item) => `<a href="${esc(item.data || '')}" download="${esc(item.name || 'file')}">${ICONS.copy}<span><b>${esc(item.name || 'Файл')}</b><small>${esc(item.room)}</small></span></a>`).join('')}</div>` : '<div class="profile-content-empty">Файлов пока нет</div>';
  if (tab === 'links') return content.links.length ? `<div class="profile-links">${content.links.map((item) => `<a href="${esc(item.url)}" target="_blank" rel="noreferrer"><b>${esc(item.url)}</b><small>${esc(item.room)}</small></a>`).join('')}</div>` : '<div class="profile-content-empty">Ссылок пока нет</div>';
  return content.posts.length ? `<div class="profile-publications">${content.posts.map((post) => {
    const createdAt = post.createdAt ? new Date(post.createdAt) : null;
    const date = createdAt && Number.isFinite(createdAt.getTime()) ? createdAt.toLocaleDateString('ru-RU') : '';
    return `<article>${post.media ? `<img src="${esc(post.media)}" alt="">` : ''}<div><p>${esc(post.text || '')}</p>${date ? `<small>${esc(date)}</small>` : ''}</div></article>`;
  }).join('')}</div>` : '<div class="profile-content-empty profile-publications-empty">Публикаций пока нет</div>';
}

function mountProfileView(root, close, client, user, { own = false, openSettings = null } = {}) {
  let tab = 'media';
  const content = collectProfileContent(client, user, { includeShared: !own });
  if (own || (!content.media.length && content.posts.length)) tab = 'posts';
  const render = () => {
    const meta = user.profile || {};
    const pinnedBadges = (meta.pinnedBadges || []).filter((id) => BADGES[id]);
    const community = meta.pinnedCommunity;
    const cover = meta.cover || content.media[0]?.poster || content.media[0]?.data || '';
    const music = meta.music;
    const game = meta.game;
    const tabs = own ? [['posts','Публикации']] : [['posts','Публикации'],['media','Медиа'],['files','Файлы'],['links','Ссылки']];
    const presence = [
      music?.active ? `<div class="profile-music"><span>♫</span><div><small>Сейчас играет</small><b>${esc(`${music.artist} — ${music.title}`)}</b></div><em>›</em></div>` : '',
      game?.active ? `<div class="profile-game"><span>${esc(game.icon || '🎮')}</span><div><small>Играет в</small><b>${esc(game.title)}</b></div><em>◉</em></div>` : '',
    ].filter(Boolean).join('');
    root.innerHTML = `<div class="profile-card-view ${own ? 'is-own' : ''}"><div class="profile-card-inner">
      <div class="profile-card-cover" style="${cover ? `background-image:linear-gradient(180deg,rgba(8,12,18,.08),rgba(8,12,18,.22)),url('${esc(cover)}')` : `--profile-color:${user.color || 'var(--accent)'}`}">
        <button class="profile-cover-code" type="button" aria-label="Ссылка профиля">${ICONS.qr}</button>
        <button class="profile-cover-menu" type="button" aria-label="${own ? 'Изменить обложку' : 'Меню'}">${own ? ICONS.image : ICONS.more}</button>
      </div>
      <div class="profile-card-identity ${user.status && !own ? 'has-status' : ''}">
        ${pinnedBadges.length ? `<button class="profile-chip profile-achievements" type="button"><span>${BADGES[pinnedBadges[0]].icon}</span><b>${pinnedBadges.length} ${pinnedBadges.length === 1 ? 'достижение' : 'достижения'}</b></button>` : ''}
        ${avatarHtml(user,'profile-card-avatar')}
        ${community ? `<button class="profile-chip profile-community" type="button"><span>${esc(community.icon || '◇')}</span><b>${esc(community.name)}</b></button>` : ''}
        <div class="profile-card-name"><h2>${esc(user.name)}</h2>${user.username ? `<p>@${esc(user.username)}</p>` : ''}${!own && user.status ? `<small>${esc(user.status)}</small>` : ''}</div>
      </div>
      <div class="profile-card-actions ${own ? 'own-actions' : ''}">
        ${own ? `<button data-profile-action="photo">${ICONS.image}<span>Выбрать фото</span></button><button data-profile-action="edit">${ICONS.edit}<span>Изменить</span></button><button data-profile-action="settings">${ICONS.settings}<span>Настройки</span></button>` : `<button data-profile-action="message">${ICONS.open}<span>Чат</span></button><button data-profile-action="sound">${ICONS.bell}<span>Звук</span></button><button data-profile-action="call">${ICONS.phone}<span>Звонок</span></button><button data-profile-action="block">${ICONS.newBlock}<span>+Блок</span></button>`}
      </div>
      ${presence ? `<section class="profile-presence">${presence}</section>` : ''}
      ${user.bio ? `<section class="profile-about"><p>${esc(user.bio)}</p><span>О себе</span></section>` : ''}
      <nav class="profile-content-tabs ${tabs.length === 1 ? 'is-single' : ''}">${tabs.map(([id,label]) => `<button data-profile-tab="${id}" class="${tab === id ? 'active' : ''}">${label}</button>`).join('')}</nav>
      <div class="profile-content">${renderTabContent(tab, content)}</div>
      </div>
      <div class="profile-detail-popover hidden"></div>
      ${own ? '<input class="profile-card-file-input" data-profile-avatar-file type="file" accept="image/*"><input class="profile-card-file-input" data-profile-cover-file type="file" accept="image/*">' : ''}
    </div>`;

    for (const button of root.querySelectorAll('[data-profile-tab]')) button.onclick = () => { tab = button.dataset.profileTab; render(); };
    root.querySelector('.profile-cover-code').onclick = async () => { await navigator.clipboard.writeText(`${location.origin}/@${user.username}`); window.Segment?.toast?.('Ссылка на профиль скопирована'); };
    const applyProfileUpdate = (updated) => {
      Object.assign(client.self,updated); Object.assign(user,updated);
      client.storage.setName(updated.name); client.storage.setUsername?.(updated.username); client.storage.setAvatar?.(updated.avatar); client.storage.setColor(updated.color);
      client._emit('identity',{name:updated.name,user:updated}); render();
    };
    const avatarInput = root.querySelector('[data-profile-avatar-file]');
    const coverInput = root.querySelector('[data-profile-cover-file]');
    avatarInput?.addEventListener('change',async () => {
      const file=avatarInput.files?.[0]; if(!file)return;
      try { applyProfileUpdate(await profileApi({avatar:await resizeProfileImage(file,{width:512,height:512,quality:.86})})); window.Segment?.toast?.('Фото профиля обновлено'); }
      catch { window.Segment?.toast?.('Не удалось обновить фото'); }
    });
    coverInput?.addEventListener('change',async () => {
      const file=coverInput.files?.[0]; if(!file)return;
      try { applyProfileUpdate(await profileApi({profile:{cover:await resizeProfileImage(file,{width:1200,height:400,quality:.82})}})); window.Segment?.toast?.('Обложка обновлена'); }
      catch { window.Segment?.toast?.('Не удалось обновить обложку'); }
    });
    root.querySelector('.profile-cover-menu').onclick = own ? () => coverInput?.click() : () => {
      const popover = root.querySelector('.profile-detail-popover');
      popover.classList.add('is-menu');
      popover.innerHTML = `<div class="profile-quick-menu"><button data-copy-profile type="button">${ICONS.copy}<span>Скопировать ссылку</span></button><button data-close-profile type="button">${ICONS.close}<span>Закрыть профиль</span></button></div>`;
      popover.classList.remove('hidden');
      popover.querySelector('[data-copy-profile]').onclick = () => root.querySelector('.profile-cover-code').click();
      popover.querySelector('[data-close-profile]').onclick = close;
    };
    root.querySelector('.profile-community')?.addEventListener('click', () => { if (community?.id && client.chatById(community.id)) { close(); client.openRoom(community.id); } });
    root.querySelector('.profile-achievements').onclick = () => {
      const popover = root.querySelector('.profile-detail-popover');
      popover.classList.remove('is-menu');
      popover.innerHTML = `<div class="profile-detail-head"><div><b>Достижения</b><span>${own ? 'Выберите до трёх закреплённых' : `${pinnedBadges.length} закреплено`}</span></div><button type="button">×</button></div><div class="profile-badge-list">${Object.entries(BADGES).map(([id,badge]) => `<label class="${pinnedBadges.includes(id) ? 'active' : ''}">${own ? `<input type="checkbox" value="${id}" ${pinnedBadges.includes(id) ? 'checked' : ''}>` : ''}<i>${badge.icon}</i><span><b>${badge.title}</b><small>${badge.text}</small></span></label>`).join('')}</div>${own ? '<button class="profile-badge-save" type="button">Сохранить</button>' : ''}`;
      popover.classList.remove('hidden');
      popover.querySelector('.profile-detail-head button').onclick = () => popover.classList.add('hidden');
      popover.querySelector('.profile-badge-save')?.addEventListener('click', async () => {
        const selected = [...popover.querySelectorAll('input:checked')].slice(0,3).map((input) => input.value);
        try { const updated = await profileApi({ profile:{ pinnedBadges:selected } }); Object.assign(client.self,updated); Object.assign(user,updated); client._emit('identity',{name:updated.name,user:updated}); window.Segment?.toast?.('Достижения закреплены'); render(); } catch { window.Segment?.toast?.('Не удалось сохранить'); }
      });
    };
    for (const item of root.querySelectorAll('[data-profile-media]')) item.onclick = () => window.Segment?.openMedia?.(content.media.map((entry) => ({type:entry.kind === 'photo' ? 'photo' : 'video',src:entry.data,poster:entry.poster,name:entry.name,author:user.name})),Number(item.dataset.profileMedia));
    const action = (name, handler) => root.querySelector(`[data-profile-action="${name}"]`)?.addEventListener('click', handler);
    action('photo',()=>avatarInput?.click()); action('edit',()=>openSettings?.('profile')); action('settings',()=>openSettings?.('home'));
    action('copy',()=>root.querySelector('.profile-cover-code').click());
    for (const id of ['message','sound','call','block']) action(id,()=>window.Segment?.toast?.('Функция будет подключена к профилям следующим этапом'));
  };
  render();
}

export function openProfileSurface(client, user, { sourceId = 'profile', openSettings = null } = {}) {
  const own = Boolean(user?.id && user.id === client.self.id) || user === client.self;
  const settings = openSettings || (own ? (page = 'home') => window.Segment?.workspace?.openSurface({
    id:'settings', sourceId, minWidth:370, maxWidth:720, className:'settings-surface',
    mount(root,close){ return mountSettings(root,close,client,()=>client._emit('identity',{name:client.self.name,user:client.self}),page); },
  }) : null);
  return window.Segment?.workspace?.openSurface({
    id: `profile-view:${user.username || user.id || 'self'}`, sourceId, minWidth:360, maxWidth:2400, className:'profile-view-surface',
    mount(root,close){ mountProfileView(root,close,client,user,{own,openSettings:settings}); },
  });
}

export function profilePanel(client) {
  return {
    id:'profile', title:'Профиль', label:'Профиль', icon:'👤', hideable:true, weight:.7,
    mount(body){
      body.innerHTML=`<div class="profile-shell"><div class="profile" role="button" tabindex="0" aria-label="Открыть профиль"><div class="profile-avatar"></div><div class="profile-info"><div class="profile-name">гость</div><div class="profile-status"><span class="status-dot"></span><span class="profile-state">не в сети</span></div></div><button class="profile-settings" aria-label="Настройки">${ICONS.settings}</button></div><div class="profile-panel-details"><div class="profile-accounts-head"><b>Аккаунты</b><span>1</span></div><button class="profile-account-row is-active" type="button"><span class="profile-account-avatar"></span><span class="profile-account-copy"><b class="profile-account-name"></b><small class="profile-account-username"></small></span><i>Текущий</i></button><div class="profile-account-menu hidden"><button data-account-settings type="button">${ICONS.settings}<span>Настройки аккаунта</span></button><button class="danger" data-account-logout type="button">${ICONS.logout}<span>Удалить с устройства</span></button></div></div></div>`;
      const avatar=body.querySelector('.profile-avatar');const name=body.querySelector('.profile-name');const state=body.querySelector('.profile-state');const dot=body.querySelector('.status-dot');const accountAvatar=body.querySelector('.profile-account-avatar');const accountName=body.querySelector('.profile-account-name');const accountUsername=body.querySelector('.profile-account-username');
      const renderIdentity=()=>{name.textContent=client.self.name||'гость';avatar.innerHTML=client.self.avatar?`<img src="${client.self.avatar}" alt="">`:'';if(!client.self.avatar)avatar.textContent=client.self.name?.trim()[0]?.toUpperCase()||'·';avatar.style.background=client.self.color;accountAvatar.innerHTML=client.self.avatar?`<img src="${client.self.avatar}" alt="">`:esc(client.self.name?.trim()[0]?.toUpperCase()||'·');accountAvatar.style.background=client.self.color;accountName.textContent=client.self.name||'гость';accountUsername.textContent=client.self.username?`@${client.self.username}`:'';};
      const offs=[client.on('identity',renderIdentity),client.on('connection',({connected})=>{dot.classList.toggle('off',!connected);state.textContent=connected?'в сети':'не в сети';})];
      const openSettings=(page='home')=>window.Segment?.workspace?.openSurface({id:'settings',sourceId:'profile',minWidth:370,maxWidth:720,className:'settings-surface',mount(settings,close){return mountSettings(settings,close,client,renderIdentity,page);}});
      const openProfile=()=>openProfileSurface(client,client.self,{sourceId:'profile',openSettings});
      const accountRow=body.querySelector('.profile-account-row');const accountMenu=body.querySelector('.profile-account-menu');
      const closeAccountMenu=()=>accountMenu.classList.add('hidden');
      accountRow.onclick=closeAccountMenu;accountRow.oncontextmenu=(event)=>{event.preventDefault();event.stopPropagation();const details=body.querySelector('.profile-panel-details');const rect=details.getBoundingClientRect();accountMenu.classList.remove('hidden');accountMenu.style.left=`${Math.max(8,Math.min(event.clientX-rect.left,details.clientWidth-238))}px`;accountMenu.style.top=`${Math.max(8,Math.min(event.clientY-rect.top,details.clientHeight-112))}px`;};
      accountMenu.querySelector('[data-account-settings]').onclick=()=>{closeAccountMenu();openSettings();};accountMenu.querySelector('[data-account-logout]').onclick=async()=>{await fetch('/api/auth/logout',{method:'POST',credentials:'same-origin'}).catch(()=>{});client.logout();location.reload();};
      const dismissAccountMenu=(event)=>{if(!accountMenu.contains(event.target))closeAccountMenu();};document.addEventListener('pointerdown',dismissAccountMenu,true);
      body.querySelector('.profile-settings').onclick=(event)=>{event.stopPropagation();openSettings();};const summary=body.querySelector('.profile');summary.onclick=openProfile;summary.onkeydown=(event)=>{if(event.key==='Enter'||event.key===' '){event.preventDefault();openProfile();}};renderIdentity();
      return()=>{document.removeEventListener('pointerdown',dismissAccountMenu,true);window.Segment?.workspace?.closeSurface();offs.forEach((off)=>off());};
    },
  };
}
