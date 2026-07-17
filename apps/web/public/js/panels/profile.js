import { mountSettings } from '../settings.js';
import { esc } from '../util.js';
import { ICONS } from '../icons.js';

const BADGES = {
  early: { icon: '⚡', title: 'Ранний участник', text: 'С аккаунтом с раннего этапа Segment' },
  creator: { icon: '◆', title: 'Создатель', text: 'Развивает собственные сообщества' },
  mods: { icon: '🧩', title: 'Модификатор', text: 'Настраивает Segment под себя' },
  supporter: { icon: '♥', title: 'Поддержка', text: 'Поддерживает развитие проекта' },
};
let activeAccountModal = null;

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

const loadProfileImage = (source) => new Promise((resolve, reject) => {
  const image = new Image();
  image.onload = () => resolve(image);
  image.onerror = reject;
  image.src = source;
});

function copyProfileText(value) {
  const input = document.createElement('textarea');
  input.value = value; input.setAttribute('readonly',''); input.style.position='fixed'; input.style.opacity='0';
  document.body.appendChild(input); input.select();
  const copied = document.execCommand('copy'); input.remove();
  if (!copied) navigator.clipboard?.writeText(value).catch(()=>{});
  return copied || Boolean(navigator.clipboard);
}

const profileQrUrl = (user, options) => `/api/auth/profile-qr?username=${encodeURIComponent(user.username)}&dark=${encodeURIComponent(options.dark)}`;

async function makeProfileQrPng(user, options) {
  const response = await fetch(profileQrUrl(user, options), { credentials:'same-origin' });
  if (!response.ok) throw new Error('QR_FAILED');
  const objectUrl = URL.createObjectURL(await response.blob());
  try {
    const qr = await loadProfileImage(objectUrl);
    const canvas = document.createElement('canvas'); canvas.width = 1200; canvas.height = 1200;
    const context = canvas.getContext('2d');
    context.beginPath(); context.roundRect(0,0,1200,1200,92); context.clip();
    context.fillStyle = '#fff'; context.fillRect(0,0,1200,1200);
    context.drawImage(qr,0,0,1200,1200);
    if (options.avatar && user.avatar) {
      const avatar = await loadProfileImage(user.avatar);
      context.save(); context.beginPath(); context.arc(600,600,116,0,Math.PI*2); context.fillStyle='#fff'; context.fill();
      context.beginPath(); context.arc(600,600,98,0,Math.PI*2); context.clip(); context.drawImage(avatar,502,502,196,196); context.restore();
    }
    return await new Promise((resolve, reject) => canvas.toBlob((blob) => blob ? resolve(blob) : reject(new Error('QR_FAILED')), 'image/png'));
  } finally { URL.revokeObjectURL(objectUrl); }
}

function openProfileQrModal(user, root) {
  if (!user.username) return;
  const host = root.closest('.workspace-surface') || document.body;
  host.querySelector('.profile-qr-modal')?.remove();
  const modal = document.createElement('div');
  modal.className = 'profile-qr-modal';
  modal.innerHTML = `<div class="profile-qr-dialog" role="dialog" aria-modal="true" aria-label="QR-код профиля">
    <button class="profile-qr-close" type="button" data-qr-close aria-label="Закрыть"></button>
    <header><div><b>QR-код профиля</b><span>@${esc(user.username)}</span></div></header>
    <div class="profile-qr-preview"><img data-qr-image alt="QR-код профиля"><span class="profile-qr-avatar">${user.avatar ? `<img src="${esc(user.avatar)}" alt="">` : esc(user.name?.trim()[0]?.toUpperCase() || 'S')}</span></div>
    <div class="profile-qr-actions">
      <label class="profile-qr-action profile-qr-color"><span class="profile-qr-color-dot" style="--qr-color:#0b1320"></span><b>Цвет</b><input type="color" value="#0b1320" data-qr-color></label>
      <button class="profile-qr-action" type="button" data-qr-download>${ICONS.image}<b>Скачать</b></button>
    </div>
  </div>`;
  host.appendChild(modal);
  const image = modal.querySelector('[data-qr-image]');
  const avatar = modal.querySelector('.profile-qr-avatar');
  const color = modal.querySelector('[data-qr-color]');
  const colorDot = modal.querySelector('.profile-qr-color-dot');
  const options = () => ({ dark:color.value, avatar:Boolean(user.avatar) });
  const refresh = () => { const state=options(); image.src=profileQrUrl(user,state); avatar.classList.toggle('hidden',!state.avatar); colorDot.style.setProperty('--qr-color',state.dark); };
  const close = () => { document.removeEventListener('keydown',onKey); modal.remove(); };
  const onKey = (event) => { if(event.key==='Escape')close(); };
  color.oninput=refresh;
  modal.querySelector('[data-qr-close]').onclick=close;
  modal.onclick=(event)=>{if(event.target===modal)close();};
  modal.querySelector('[data-qr-download]').onclick=async()=>{try{const blob=await makeProfileQrPng(user,options());const link=document.createElement('a');link.href=URL.createObjectURL(blob);link.download=`${user.username}-qr.png`;link.click();setTimeout(()=>URL.revokeObjectURL(link.href),1000);}catch{window.Segment?.toast?.('Не удалось создать QR-код');}};
  document.addEventListener('keydown',onKey);
  requestAnimationFrame(()=>modal.classList.add('is-open'));
  refresh();
}

function collectProfileContent(client, user, { includeShared = true } = {}) {
  const posts = Array.isArray(user.profile?.publications) ? user.profile.publications.slice(0,100).reverse() : [];
  const archive = Array.isArray(user.profile?.publicationArchive) ? user.profile.publicationArchive.slice(0,100).reverse() : [];
  const media = []; const files = []; const links = [];
  const matches = (message) => {
    if (message.system || message.deleted || message.channelName) return false;
    if (user.id && message.authorId) return message.authorId === user.id;
    if (user.username && message.username) return message.username === user.username;
    return message.name === user.name;
  };
  if (!includeShared) return { posts, archive, media, files, links };
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
  return { posts, archive, media: media.reverse(), files: files.reverse(), links: links.reverse() };
}

function renderPublications(items, emptyText) {
  return items.length ? `<div class="profile-publications">${items.map((post) => {
    const createdAt = post.createdAt ? new Date(post.createdAt) : null;
    const date = createdAt && Number.isFinite(createdAt.getTime()) ? createdAt.toLocaleDateString('ru-RU') : '';
    return `<article>${post.media ? `<img src="${esc(post.media)}" alt="">` : ''}<div><p>${esc(post.text || '')}</p>${date ? `<small>${esc(date)}</small>` : ''}</div></article>`;
  }).join('')}</div>` : `<div class="profile-content-empty profile-publications-empty">${emptyText}</div>`;
}

function renderTabContent(tab, content) {
  if (tab === 'media') return content.media.length ? `<div class="profile-media-grid">${content.media.map((item,index) => `<button data-profile-media="${index}"><img src="${esc(item.poster || item.data || '')}" alt="">${item.kind !== 'photo' ? '<span>▶</span>' : ''}</button>`).join('')}</div>` : '<div class="profile-content-empty">Медиа пока нет</div>';
  if (tab === 'files') return content.files.length ? `<div class="profile-files">${content.files.map((item) => `<a href="${esc(item.data || '')}" download="${esc(item.name || 'file')}">${ICONS.copy}<span><b>${esc(item.name || 'Файл')}</b><small>${esc(item.room)}</small></span></a>`).join('')}</div>` : '<div class="profile-content-empty">Файлов пока нет</div>';
  if (tab === 'links') return content.links.length ? `<div class="profile-links">${content.links.map((item) => `<a href="${esc(item.url)}" target="_blank" rel="noreferrer"><b>${esc(item.url)}</b><small>${esc(item.room)}</small></a>`).join('')}</div>` : '<div class="profile-content-empty">Ссылок пока нет</div>';
  if (tab === 'archive') return renderPublications(content.archive || [], 'Архив публикаций пуст');
  return renderPublications(content.posts, 'Публикаций пока нет');
}

function mountProfileView(root, close, client, user, { own = false, openSettings = null } = {}) {
  let tab = 'media';
  const content = collectProfileContent(client, user, { includeShared: !own });
  if (own || (!content.media.length && content.posts.length)) tab = 'posts';
  const render = () => {
    const meta = user.profile || {};
    const pinnedBadges = (meta.pinnedBadges || []).filter((id) => BADGES[id]).slice(0,1);
    const pinnedBadge = pinnedBadges[0] ? BADGES[pinnedBadges[0]] : null;
    const community = meta.pinnedCommunity;
    const cover = meta.cover || content.media[0]?.poster || content.media[0]?.data || '';
    const music = meta.music;
    const game = meta.game;
    const tabs = own ? [['posts','Публикации'],['archive','Архив публикаций']] : [['posts','Публикации'],['media','Медиа'],['files','Файлы'],['links','Ссылки']];
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
        ${pinnedBadge ? `<button class="profile-chip profile-achievements" type="button"><span>${pinnedBadge.icon}</span><b>${esc(pinnedBadge.title)}</b></button>` : ''}
        ${avatarHtml(user,'profile-card-avatar')}
        ${community ? `<button class="profile-chip profile-community" type="button"><span>${esc(community.icon || '◇')}</span><b>${esc(community.name)}</b></button>` : ''}
        <div class="profile-card-name"><h2>${esc(user.name)}</h2>${user.username ? `<button type="button" data-copy-username>@${esc(user.username)}</button>` : ''}${!own && user.status ? `<small>${esc(user.status)}</small>` : ''}</div>
      </div>
      <div class="profile-card-actions ${own ? 'own-actions' : ''}">
        ${own ? `<button data-profile-action="photo">${ICONS.image}<span>Выбрать фото</span></button><button data-profile-action="edit">${ICONS.edit}<span>Изменить</span></button><button data-profile-action="settings">${ICONS.settings}<span>Настройки</span></button>` : `<button data-profile-action="message">${ICONS.open}<span>Чат</span></button><button data-profile-action="sound">${ICONS.bell}<span>Звук</span></button><button data-profile-action="call">${ICONS.phone}<span>Звонок</span></button><button data-profile-action="block">${ICONS.newBlock}<span>+Блок</span></button>`}
      </div>
      ${presence ? `<section class="profile-presence">${presence}</section>` : ''}
      ${user.bio ? `<section class="profile-about"><p>${esc(user.bio)}</p><span>О себе</span></section>` : ''}
      <nav class="profile-content-tabs ${own ? 'is-profile-owner' : ''}">${tabs.map(([id,label]) => `<button data-profile-tab="${id}" class="${tab === id ? 'active' : ''}">${label}</button>`).join('')}</nav>
      <div class="profile-content">${renderTabContent(tab, content)}</div>
      </div>
      <div class="profile-detail-popover hidden"></div>
      ${own ? '<input class="profile-card-file-input" data-profile-avatar-file type="file" accept="image/*"><input class="profile-card-file-input" data-profile-cover-file type="file" accept="image/*">' : ''}
    </div>`;

    for (const button of root.querySelectorAll('[data-profile-tab]')) button.onclick = () => { tab = button.dataset.profileTab; render(); };
    root.querySelector('.profile-cover-code').onclick = () => openProfileQrModal(user,root);
    root.querySelector('[data-copy-username]')?.addEventListener('click',async()=>{if(await copyProfileText(`@${user.username}`))window.Segment?.toast?.('Username скопирован');else window.Segment?.toast?.('Не удалось скопировать username');});
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
    const achievements = root.querySelector('.profile-achievements');
    if (achievements) achievements.onclick = () => {
      const popover = root.querySelector('.profile-detail-popover');
      popover.classList.remove('is-menu');
      const badgeEntries = own ? Object.entries(BADGES) : Object.entries(BADGES).filter(([id]) => pinnedBadges.includes(id));
      popover.innerHTML = `<div class="profile-detail-head"><button type="button" aria-label="Закрыть"></button><div><b>Достижение</b><span>${own ? 'Выберите одно закреплённое достижение' : pinnedBadge.title}</span></div></div><div class="profile-badge-list">${badgeEntries.map(([id,badge]) => `<label class="${pinnedBadges.includes(id) ? 'active' : ''}">${own ? `<input type="radio" name="pinnedBadge" value="${id}" ${pinnedBadges.includes(id) ? 'checked' : ''}>` : ''}<i>${badge.icon}</i><span><b>${badge.title}</b><small>${badge.text}</small></span></label>`).join('')}</div>${own ? '<button class="profile-badge-save" type="button">Сохранить</button>' : ''}`;
      popover.classList.remove('hidden');
      popover.querySelector('.profile-detail-head button').onclick = () => popover.classList.add('hidden');
      popover.querySelector('.profile-badge-save')?.addEventListener('click', async () => {
        const selected = popover.querySelector('input:checked')?.value;
        try { const updated = await profileApi({ profile:{ pinnedBadges:selected ? [selected] : [] } }); Object.assign(client.self,updated); Object.assign(user,updated); client._emit('identity',{name:updated.name,user:updated}); window.Segment?.toast?.('Достижение закреплено'); render(); } catch { window.Segment?.toast?.('Не удалось сохранить'); }
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

function mountAccountModal(modal, body) {
  if (activeAccountModal?.isConnected) {
    activeAccountModal.classList.add('is-open');
    activeAccountModal.querySelector('input:not([type="hidden"])')?.focus({ preventScroll:true });
    modal.remove();
    return;
  }
  if (activeAccountModal) {
    activeAccountModal._accountCleanup?.();
    activeAccountModal.remove();
  }
  activeAccountModal = modal;
  modal._accountOwner = body;
  const panel = body.closest('.panel[data-id="profile"]') || body;
  const dialog = modal.querySelector('.account-add-dialog');
  const oldClose = dialog.querySelector('[data-close]');
  oldClose.outerHTML = `<div class="account-dialog-bars"><button class="account-dialog-move" type="button" data-account-move aria-label="Переместить окно"><i></i></button><button class="account-dialog-close" type="button" data-close aria-label="Закрыть"><i></i></button></div>`;
  const codeInput = dialog.querySelector('input[name="code"]');
  codeInput.removeAttribute('maxlength'); codeInput.classList.add('account-code-value');
  const codeCells = document.createElement('div');
  codeCells.className = 'account-code-cells'; codeCells.setAttribute('aria-hidden','true');
  codeCells.innerHTML = '<i></i>'.repeat(6); codeInput.insertAdjacentElement('afterend',codeCells);
  const renderCode = () => {
    codeInput.value = codeInput.value.replace(/\D/g,'').slice(0,6);
    [...codeCells.children].forEach((cell,index) => { cell.textContent=codeInput.value[index]||''; cell.classList.toggle('filled',index<codeInput.value.length); });
  };
  codeInput.addEventListener('input',renderCode); codeCells.addEventListener('click',()=>codeInput.focus()); renderCode();
  const place = () => {
    const panelRect = panel.getBoundingClientRect();
    const dialogRect = dialog.getBoundingClientRect();
    const margin = 16;
    const desiredX = modal._accountDragged ? Number.parseFloat(dialog.style.left) : panelRect.left + panelRect.width / 2;
    const desiredY = modal._accountDragged ? Number.parseFloat(dialog.style.top) : panelRect.top + panelRect.height / 2;
    const centerX = Math.min(innerWidth - dialogRect.width / 2 - margin, Math.max(dialogRect.width / 2 + margin, desiredX));
    const centerY = Math.min(innerHeight - dialogRect.height / 2 - margin, Math.max(dialogRect.height / 2 + margin, desiredY));
    modal.style.setProperty('--account-panel-left', `${panelRect.left}px`);
    modal.style.setProperty('--account-panel-top', `${panelRect.top}px`);
    modal.style.setProperty('--account-panel-width', `${panelRect.width}px`);
    modal.style.setProperty('--account-panel-height', `${panelRect.height}px`);
    dialog.style.left = `${centerX}px`;
    dialog.style.top = `${centerY}px`;
  };
  document.body.appendChild(modal);
  const observer = new ResizeObserver(place);
  observer.observe(panel); observer.observe(dialog);
  window.addEventListener('resize', place);
  const moveHandle = dialog.querySelector('[data-account-move]');
  moveHandle.addEventListener('pointerdown',(event)=>{
    if(event.button>0)return; event.preventDefault(); modal._accountDragged=true;
    const startX=event.clientX; const startY=event.clientY; const initialX=Number.parseFloat(dialog.style.left); const initialY=Number.parseFloat(dialog.style.top);
    const move=(next)=>{dialog.style.left=`${initialX+next.clientX-startX}px`;dialog.style.top=`${initialY+next.clientY-startY}px`;place();};
    const finish=()=>{window.removeEventListener('pointermove',move);window.removeEventListener('pointerup',finish);window.removeEventListener('pointercancel',finish);};
    window.addEventListener('pointermove',move);window.addEventListener('pointerup',finish);window.addEventListener('pointercancel',finish);
  });
  modal._accountCleanup = () => { observer.disconnect(); window.removeEventListener('resize', place); if (activeAccountModal === modal) activeAccountModal = null; };
  place();
}

export function profilePanel(client) {
  return {
    id:'profile', title:'Профиль', label:'Профиль', icon:'👤', hideable:true, weight:.7,
    mount(body){
      body.innerHTML=`<div class="profile-shell"><div class="profile" role="button" tabindex="0" aria-label="Открыть профиль"><div class="profile-avatar"></div><div class="profile-info"><div class="profile-name">гость</div><div class="profile-status"><span class="status-dot"></span><span class="profile-state">не в сети</span></div></div><button class="profile-settings" aria-label="Настройки">${ICONS.settings}</button></div><div class="profile-panel-details"><div class="profile-account-carousel" aria-label="Переключение аккаунтов"></div><div class="profile-account-menu hidden"><button data-account-settings type="button">${ICONS.settings}<span>Настройки аккаунта</span></button><button class="danger" data-account-remove type="button">${ICONS.logout}<span>Удалить с устройства</span></button></div></div></div>`;
      const avatar=body.querySelector('.profile-avatar');const name=body.querySelector('.profile-name');const state=body.querySelector('.profile-state');const dot=body.querySelector('.status-dot');
      const renderIdentity=()=>{name.textContent=client.self.name||'гость';avatar.innerHTML=client.self.avatar?`<img src="${client.self.avatar}" alt="">`:'';if(!client.self.avatar)avatar.textContent=client.self.name?.trim()[0]?.toUpperCase()||'·';avatar.style.background=client.self.color;};
      const offs=[client.on('identity',renderIdentity),client.on('connection',({connected})=>{dot.classList.toggle('off',!connected);state.textContent=connected?'в сети':'не в сети';})];
      const openSettings=(page='home')=>window.Segment?.workspace?.openSurface({id:'settings',sourceId:'profile',minWidth:370,maxWidth:720,className:'settings-surface',mount(settings,close){return mountSettings(settings,close,client,renderIdentity,page);}});
      const openProfile=()=>openProfileSurface(client,client.self,{sourceId:'profile',openSettings});
      const carousel=body.querySelector('.profile-account-carousel');const accountMenu=body.querySelector('.profile-account-menu');let deviceAccounts=[client.self];let menuAccount=null;
      const closeAccountMenu=()=>accountMenu.classList.add('hidden');
      const addAccount=()=>{const modal=document.createElement('div');modal.className='account-add-modal';modal.innerHTML=`<form class="account-add-dialog"><button type="button" class="profile-qr-close" data-close aria-label="Закрыть"></button><h3>Добавить аккаунт</h3><p>Войдите по почте. Текущий аккаунт останется на устройстве.</p><div class="account-email-step"><label><span>Электронная почта</span><input type="email" name="email" autocomplete="email" required placeholder="name@example.com"></label></div><div class="account-code-step hidden"><label><span>Код из письма</span><input name="code" inputmode="numeric" maxlength="6" placeholder="000000"></label></div><div class="account-profile-step hidden"><label><span>Имя</span><input name="name" maxlength="40" placeholder="Как вас называть"></label><label><span>Username</span><input name="username" maxlength="24" placeholder="username"></label></div><button class="settings-primary" type="submit">Получить код</button></form>`;mountAccountModal(modal,body);requestAnimationFrame(()=>modal.classList.add('is-open'));const form=modal.querySelector('form');let stage='email';let registrationToken='';const close=()=>{modal._accountCleanup?.();modal.remove();};modal.querySelector('[data-close]').onclick=close;modal.onclick=(event)=>{if(event.target===modal)close();};form.onsubmit=async(event)=>{event.preventDefault();const button=form.querySelector('[type=submit]');button.disabled=true;try{if(stage==='email'){const response=await fetch('/api/auth/request-code',{method:'POST',credentials:'same-origin',headers:{'Content-Type':'application/json'},body:JSON.stringify({email:form.email.value.trim()})});if(!response.ok)throw new Error();stage='code';form.querySelector('.account-code-step').classList.remove('hidden');form.code.required=true;button.textContent='Продолжить';form.code.focus();}else if(stage==='code'){const response=await fetch('/api/auth/verify-code',{method:'POST',credentials:'same-origin',headers:{'Content-Type':'application/json'},body:JSON.stringify({email:form.email.value.trim(),code:form.code.value})});const data=await response.json().catch(()=>({}));if(!response.ok)throw new Error(data.error);if(!data.needsProfile){location.reload();return;}registrationToken=data.registrationToken;stage='profile';form.querySelector('.account-email-step').classList.add('hidden');form.querySelector('.account-code-step').classList.add('hidden');form.querySelector('.account-profile-step').classList.remove('hidden');form.name.required=true;form.username.required=true;button.textContent='Создать аккаунт';form.name.focus();}else{const response=await fetch('/api/auth/register',{method:'POST',credentials:'same-origin',headers:{'Content-Type':'application/json'},body:JSON.stringify({registrationToken,name:form.name.value,username:form.username.value})});const data=await response.json().catch(()=>({}));if(!response.ok)throw new Error(data.error);location.reload();}}catch(error){window.Segment?.toast?.(error.message==='DEVICE_ACCOUNT_LIMIT'?'На устройстве уже 5 аккаунтов':error.message==='USERNAME_TAKEN'?'Этот username уже занят':error.message==='USERNAME_INVALID'?'Username: 3–24 символа, латиница, цифры и _':'Не удалось добавить аккаунт');}finally{button.disabled=false;}};};
      const renderAccounts=()=>{const current=deviceAccounts.find((item)=>item.id===client.self.id)||client.self;const others=deviceAccounts.filter((item)=>item.id!==current.id);const hasAdd=deviceAccounts.length<5;const total=deviceAccounts.length+(hasAdd?1:0);const leftCount=Math.floor((total-1)/2);const slots=[...others.slice(0,leftCount),current,...others.slice(leftCount),...(hasAdd?[null]:[])];carousel.style.setProperty('--account-slots',slots.length);carousel.innerHTML=slots.map((account)=>account?`<button class="profile-account-orbit ${account.id===current.id?'is-current':''}" type="button" data-account-id="${esc(account.id)}"><span style="background:${esc(account.color||'var(--accent)')}">${account.avatar?`<img src="${esc(account.avatar)}" alt="">`:esc(account.name?.[0]?.toUpperCase()||'S')}</span><b>${esc(account.name||'Аккаунт')}</b></button>`:`<button class="profile-account-orbit is-add" type="button" data-add-account aria-label="Добавить аккаунт"><span>+</span><b>Добавить</b></button>`).join('');carousel.querySelector('[data-add-account]')?.addEventListener('click',addAccount);carousel.querySelectorAll('[data-account-id]').forEach((button)=>{const account=deviceAccounts.find((item)=>item.id===button.dataset.accountId);button.onclick=async()=>{if(account.id===client.self.id)return openProfile();carousel.classList.add('is-switching');try{const response=await fetch('/api/auth/switch-account',{method:'POST',credentials:'same-origin',headers:{'Content-Type':'application/json'},body:JSON.stringify({userId:account.id})});if(!response.ok)throw new Error();location.reload();}catch{carousel.classList.remove('is-switching');window.Segment?.toast?.('Не удалось переключить аккаунт');}};button.oncontextmenu=(event)=>{event.preventDefault();menuAccount=account;const details=body.querySelector('.profile-panel-details');const rect=details.getBoundingClientRect();accountMenu.classList.remove('hidden');accountMenu.style.left=`${Math.max(8,Math.min(event.clientX-rect.left,details.clientWidth-238))}px`;accountMenu.style.top=`${Math.max(8,Math.min(event.clientY-rect.top,details.clientHeight-112))}px`;accountMenu.querySelector('[data-account-remove]').classList.toggle('hidden',account.id===client.self.id);};});};
      const loadAccounts=async()=>{try{const response=await fetch('/api/auth/device-accounts',{credentials:'same-origin'});const data=await response.json();if(response.ok&&Array.isArray(data.accounts)&&data.accounts.length)deviceAccounts=data.accounts;}catch{}renderAccounts();};
      accountMenu.querySelector('[data-account-settings]').onclick=()=>{closeAccountMenu();openSettings();};accountMenu.querySelector('[data-account-remove]').onclick=async()=>{if(!menuAccount||menuAccount.id===client.self.id)return;await fetch(`/api/auth/device-accounts/${encodeURIComponent(menuAccount.id)}`,{method:'DELETE',credentials:'same-origin'}).catch(()=>{});closeAccountMenu();loadAccounts();};
      const dismissAccountMenu=(event)=>{if(!accountMenu.contains(event.target))closeAccountMenu();};document.addEventListener('pointerdown',dismissAccountMenu,true);
      body.querySelector('.profile-settings').onclick=(event)=>{event.stopPropagation();openSettings();};const summary=body.querySelector('.profile');summary.onclick=openProfile;summary.onkeydown=(event)=>{if(event.key==='Enter'||event.key===' '){event.preventDefault();openProfile();}};renderIdentity();loadAccounts();
      return()=>{if(activeAccountModal?.isConnected&&activeAccountModal._accountOwner===body){activeAccountModal._accountCleanup?.();activeAccountModal.remove();}document.removeEventListener('pointerdown',dismissAccountMenu,true);window.Segment?.workspace?.closeSurface();offs.forEach((off)=>off());};
    },
  };
}
