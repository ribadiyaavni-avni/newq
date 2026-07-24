/* ============================================================
   NEWQ client — chats, media, voice notes, statuses, search
   ============================================================ */
'use strict';

const $ = (id) => document.getElementById(id);

const state = {
  me: null,
  socket: null,
  chats: [],          // from /api/chats
  contacts: [],
  active: null,       // { type:'direct', peer } | { type:'group', group }
  messages: [],
  oldestId: null,
  loadingOlder: false,
  tab: 'chats',
  attach: null,       // { url, kind, name }
  typingTimer: null,
  peerTyping: {},     // key -> timeout
  statuses: [],
  calls: [],
  deferredInstall: null,
};

/* ---------------- helpers ---------------- */
function esc(s) {
  return (s || '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function initials(name) {
  return (name || '?').trim().split(/\s+/).map(w => w[0]).slice(0, 2).join('').toUpperCase();
}
function fmtTime(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}
function fmtDay(iso) {
  const d = new Date(iso), now = new Date();
  const day = (x) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diff = (day(now) - day(d)) / 86400000;
  if (diff === 0) return 'Today';
  if (diff === 1) return 'Yesterday';
  return d.toLocaleDateString([], { day: 'numeric', month: 'short', year: 'numeric' });
}
function fmtLastSeen(iso) {
  if (!iso) return 'offline';
  return 'last seen ' + fmtDay(iso).toLowerCase() + ' at ' + fmtTime(iso);
}
function fmtDuration(sec) {
  const m = Math.floor(sec / 60), s = sec % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}
function avatarHTML(user, cls = '') {
  const img = user.avatar ? `<img src="${esc(user.avatar)}" alt="">` :
    `<span>${esc(initials(user.display_name || user.name))}</span>`;
  const online = user.online ? ' online' : '';
  return `<div class="avatar ${cls}${online}">${img}<i class="presence-dot"></i></div>`;
}
async function api(url, opts = {}) {
  const res = await fetch(url, Object.assign({
    headers: opts.body && !(opts.body instanceof FormData)
      ? { 'Content-Type': 'application/json' } : undefined,
  }, opts));
  const data = await res.json().catch(() => ({}));
  if (res.status === 401) { location.href = '/login'; throw new Error('auth'); }
  if (!res.ok) throw new Error(data.error || 'Request failed');
  return data;
}

/* ---------------- boot ---------------- */
async function boot() {
  try {
    const data = await api('/api/me');
    state.me = data.user;
  } catch (e) { return; }

  $('myAvatarMini').textContent = initials(state.me.display_name);
  connectSocket();
  await Promise.all([loadChats(), loadContacts()]);
  renderSideList();
  NewqNotify.init();        // notify.js — local notifications
  setupInstall();
  setupTheme();
}

function connectSocket() {
  state.socket = NewqRT.connect();   // polling realtime, Socket.IO-style API
  const s = state.socket;

  s.on('offline', () => toast('Connection lost — retrying…'));
  s.on('new_message', onNewMessage);
  s.on('presence', onPresence);
  s.on('typing', onTyping);
  s.on('messages_seen', onSeen);
  s.on('message_deleted', onDeleted);
  s.on('contact_added', (u) => {
    toast(`${u.display_name} is now a contact 🎉`);
    loadContacts().then(loadChats).then(renderSideList);
  });
  s.on('group_added', () => loadChats().then(renderSideList));
  s.on('group_updated', () => loadChats().then(renderSideList));
  s.on('status_new', (st) => {
    toast(`${st.user_name} posted a status`);
    if (state.tab === 'status') loadStatuses().then(renderSideList);
  });
  s.on('error_toast', (d) => toast(d.message));

  NewqRTC.bindSocket(s);    // webrtc.js
}

/* ---------------- data loads ---------------- */
async function loadChats() { state.chats = (await api('/api/chats')).chats; }
async function loadContacts() { state.contacts = (await api('/api/contacts')).contacts; }
async function loadStatuses() { state.statuses = (await api('/api/status/feed')).statuses; }
async function loadCalls() { state.calls = (await api('/api/calls')).calls; }

/* ---------------- sidebar rendering ---------------- */
function renderSideList() {
  const list = $('sideList');
  list.innerHTML = '';

  if (state.tab === 'chats') {
    if (!state.chats.length) {
      list.innerHTML = `<div class="empty-list">No chats yet.<br>
        Tap <b>Enter code</b> below and type the 4-digit code from your admin
        to connect with people.</div>`;
      return;
    }
    for (const c of state.chats) list.appendChild(chatItem(c));
  } else if (state.tab === 'status') {
    renderStatusList(list);
  } else {
    renderCallList(list);
  }
}

function chatItem(c) {
  const el = document.createElement('div');
  el.className = 'chat-item';
  el.setAttribute('role', 'listitem');
  const who = c.type === 'direct' ? c.peer : { display_name: c.group.name, avatar: c.group.avatar };
  const lm = c.last_message;
  let preview = 'Say hi 👋';
  if (lm) {
    if (lm.deleted) preview = '🚫 Message deleted';
    else if (lm.media_type === 'voice') preview = '🎤 Voice note';
    else if (lm.media_type === 'image') preview = '📷 Photo';
    else if (lm.media_type === 'video') preview = '🎬 Video';
    else if (lm.media_type === 'audio') preview = '🎵 Audio';
    else if (lm.media_type === 'file') preview = '📎 ' + (lm.media_name || 'File');
    else preview = lm.body;
    if (c.type === 'group' && lm.sender_id !== state.me.id)
      preview = lm.sender_name.split(' ')[0] + ': ' + preview;
    if (lm.sender_id === state.me.id) preview = 'You: ' + preview;
  }
  el.innerHTML = `
    ${avatarHTML(who)}
    <div class="meta">
      <div class="name"><span>${esc(who.display_name)}${c.type === 'group' ? ' 👥' : ''}</span>
        <time>${lm ? fmtTime(lm.created_at) : ''}</time></div>
      <div class="preview"><span>${esc(preview)}</span>
        ${c.unread ? `<span class="badge">${c.unread}</span>` : ''}</div>
    </div>`;
  el.addEventListener('click', () => openChat(c));
  const isActive = state.active &&
    ((c.type === 'direct' && state.active.type === 'direct' && state.active.peer.id === c.peer.id) ||
     (c.type === 'group' && state.active.type === 'group' && state.active.group.id === c.group.id));
  if (isActive) el.classList.add('active');
  return el;
}

function renderStatusList(list) {
  loadStatuses().then(() => {
    if (!state.statuses.length) {
      list.innerHTML = `<div class="empty-list">No status updates in the last 24 hours.<br>
        Tap <b>✨ Status</b> to share one.</div>`;
      return;
    }
    list.innerHTML = '';
    for (const st of state.statuses) {
      const el = document.createElement('div');
      el.className = 'chat-item status-item';
      el.innerHTML = `
        ${avatarHTML({ display_name: st.user_name, avatar: st.avatar })}
        <div class="meta">
          <div class="name"><span>${esc(st.user_name)}${st.user_id === state.me.id ? ' (you)' : ''}</span>
            <time>${fmtTime(st.created_at)}</time></div>
          <div class="preview"><span>${esc(st.text || (st.media_type === 'video' ? '🎬 Video' : '📷 Photo'))}</span></div>
        </div>`;
      el.addEventListener('click', () => viewStatus(st));
      list.appendChild(el);
    }
  });
}

function renderCallList(list) {
  loadCalls().then(() => {
    if (!state.calls.length) {
      list.innerHTML = `<div class="empty-list">No calls yet.<br>
        Open a chat and tap 📞 or 🎥 to start one.</div>`;
      return;
    }
    list.innerHTML = '';
    for (const call of state.calls) {
      const outgoing = call.caller_id === state.me.id;
      const otherId = outgoing ? call.callee_id : call.caller_id;
      const other = state.contacts.find(c => c.id === otherId) ||
        { display_name: 'Unknown', avatar: '' };
      const icon = call.kind === 'video' ? '🎥' : '📞';
      const dir = outgoing ? '↗️' : (call.outcome === 'missed' ? '↙️❗' : '↙️');
      const el = document.createElement('div');
      el.className = 'chat-item';
      el.innerHTML = `
        ${avatarHTML(other)}
        <div class="meta">
          <div class="name"><span>${esc(other.display_name)}</span>
            <time>${fmtTime(call.started_at)}</time></div>
          <div class="preview"><span>${dir} ${icon} ${call.outcome}
            ${call.duration_sec ? '· ' + fmtDuration(call.duration_sec) : ''}</span></div>
        </div>`;
      el.addEventListener('click', () => {
        const contact = state.contacts.find(c => c.id === otherId);
        if (contact) openChat({ type: 'direct', peer: contact });
      });
      list.appendChild(el);
    }
  });
}

/* ---------------- open chat & messages ---------------- */
async function openChat(c) {
  state.active = c;
  state.messages = [];
  state.oldestId = null;
  $('chatWelcome').style.display = 'none';
  $('chatView').style.display = 'flex';
  $('app').classList.add('chat-open');
  $('typingBubble').classList.remove('show');
  clearAttachment();

  const who = c.type === 'direct' ? c.peer : { display_name: c.group.name, avatar: c.group.avatar };
  $('chatAvatarTxt').textContent = initials(who.display_name);
  const av = $('chatAvatar');
  av.classList.toggle('online', !!who.online);
  av.querySelector('img')?.remove();
  if (who.avatar) {
    const img = document.createElement('img');
    img.src = who.avatar;
    av.prepend(img);
  }
  $('chatName').textContent = who.display_name;
  updateChatSub();

  const isDirect = c.type === 'direct';
  $('audioCallBtn').style.display = isDirect ? '' : 'none';
  $('videoCallBtn').style.display = isDirect ? '' : 'none';

  const params = isDirect ? `peer_id=${c.peer.id}` : `group_id=${c.group.id}`;
  const data = await api(`/api/messages?${params}`);
  state.messages = data.messages;
  if (state.messages.length) state.oldestId = state.messages[0].id;
  renderMessages(true);
  markSeen();
  renderSideList();
}

function updateChatSub() {
  const c = state.active;
  if (!c) return;
  const sub = $('chatSub');
  sub.className = 'sub';
  if (c.type === 'group') {
    sub.textContent = `${c.group.members.length} members`;
    return;
  }
  if (c.peer.online) { sub.textContent = 'online'; sub.classList.add('online'); }
  else sub.textContent = fmtLastSeen(c.peer.last_seen);
}

function renderMessages(scroll) {
  const box = $('messages');
  const typing = $('typingBubble');
  box.querySelectorAll('.msg, .day-divider').forEach(n => n.remove());
  let lastDay = '';
  for (const m of state.messages) {
    const day = fmtDay(m.created_at);
    if (day !== lastDay) {
      const d = document.createElement('div');
      d.className = 'day-divider';
      d.textContent = day;
      box.insertBefore(d, typing);
      lastDay = day;
    }
    box.insertBefore(messageEl(m), typing);
  }
  if (scroll) box.scrollTop = box.scrollHeight;
}

function messageEl(m) {
  const el = document.createElement('div');
  const mine = m.sender_id === state.me.id;
  el.className = 'msg ' + (mine ? 'me' : 'them');
  el.dataset.id = m.id;

  let inner = '';
  if (state.active?.type === 'group' && !mine)
    inner += `<div class="sender">${esc(m.sender_name)}</div>`;

  if (m.deleted) {
    inner += `<span class="deleted">🚫 This message was deleted</span>`;
  } else {
    if (m.media_type === 'image')
      inner += `<img class="media" src="${esc(m.media_url)}" alt="Photo" loading="lazy">`;
    else if (m.media_type === 'video')
      inner += `<video class="media" src="${esc(m.media_url)}" controls preload="metadata"></video>`;
    else if (m.media_type === 'voice')
      inner += `<span class="voice-tag">🎤 Voice note</span><audio src="${esc(m.media_url)}" controls preload="metadata"></audio>`;
    else if (m.media_type === 'audio')
      inner += `<audio src="${esc(m.media_url)}" controls preload="metadata"></audio>`;
    else if (m.media_type === 'file')
      inner += `<a class="file-chip" href="${esc(m.media_url)}" download="${esc(m.media_name)}" target="_blank" rel="noopener">📄 <span>${esc(m.media_name || 'File')}</span></a>`;
    if (m.body) inner += esc(m.body).replace(/\n/g, '<br>');
  }

  let ticks = '';
  if (mine && !m.deleted) {
    const cls = m.seen ? 'ticks seen' : 'ticks';
    ticks = `<span class="${cls}">${m.delivered || m.seen ? '✓✓' : '✓'}</span>`;
  }
  inner += `<div class="stamp">${fmtTime(m.created_at)} ${ticks}</div>`;
  el.innerHTML = inner;

  el.querySelector('img.media')?.addEventListener('click', () => {
    $('lightboxImg').src = m.media_url;
    $('lightbox').classList.add('show');
  });

  if (mine && !m.deleted) {
    el.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      if (confirm('Delete this message for everyone?'))
        state.socket.emit('delete_message', { id: m.id });
    });
  }
  return el;
}

// Load older messages when scrolled to top
$('messages').addEventListener('scroll', async function () {
  if (this.scrollTop > 40 || state.loadingOlder || !state.oldestId || !state.active) return;
  state.loadingOlder = true;
  const c = state.active;
  const params = c.type === 'direct' ? `peer_id=${c.peer.id}` : `group_id=${c.group.id}`;
  const data = await api(`/api/messages?${params}&before=${state.oldestId}`);
  if (data.messages.length) {
    const prevHeight = this.scrollHeight;
    state.messages = data.messages.concat(state.messages);
    state.oldestId = data.messages[0].id;
    renderMessages(false);
    this.scrollTop = this.scrollHeight - prevHeight;
  } else {
    state.oldestId = null;
  }
  state.loadingOlder = false;
});

function markSeen() {
  const c = state.active;
  if (!c) return;
  if (c.type === 'direct') state.socket.emit('mark_seen', { peer_id: c.peer.id });
  else state.socket.emit('mark_seen', { group_id: c.group.id });
}

/* ---------------- socket handlers ---------------- */
function isForActiveChat(m) {
  const c = state.active;
  if (!c) return false;
  if (m.group_id) return c.type === 'group' && c.group.id === m.group_id;
  return c.type === 'direct' &&
    (m.sender_id === c.peer.id || m.recipient_id === c.peer.id);
}

function onNewMessage(m) {
  if (isForActiveChat(m)) {
    state.messages.push(m);
    const box = $('messages');
    const nearBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 140;
    box.insertBefore(messageEl(m), $('typingBubble'));
    if (nearBottom || m.sender_id === state.me.id) box.scrollTop = box.scrollHeight;
    if (m.sender_id !== state.me.id && document.visibilityState === 'visible') markSeen();
  } else if (m.sender_id !== state.me.id) {
    toast(`💬 ${m.sender_name}: ${m.body ? m.body.slice(0, 40) : 'sent an attachment'}`);
  }
  if (m.sender_id !== state.me.id) {
    NewqNotify.show(m.sender_name,
      m.body ? m.body.slice(0, 90) : '📎 Sent you an attachment');
  }
  loadChats().then(renderSideList);
}

function onPresence(p) {
  const contact = state.contacts.find(c => c.id === p.user_id);
  if (contact) { contact.online = p.online; contact.last_seen = p.last_seen; }
  for (const chat of state.chats) {
    if (chat.type === 'direct' && chat.peer.id === p.user_id) {
      chat.peer.online = p.online;
      chat.peer.last_seen = p.last_seen;
    }
  }
  if (state.active?.type === 'direct' && state.active.peer.id === p.user_id) {
    state.active.peer.online = p.online;
    state.active.peer.last_seen = p.last_seen;
    $('chatAvatar').classList.toggle('online', p.online);
    updateChatSub();
  }
  if (state.tab === 'chats') renderSideList();
}

function onTyping(t) {
  const c = state.active;
  if (!c) return;
  const matches = (t.group_id && c.type === 'group' && c.group.id === t.group_id) ||
                  (t.peer_id && c.type === 'direct' && c.peer.id === t.peer_id);
  if (!matches) return;
  const bubble = $('typingBubble');
  const sub = $('chatSub');
  if (t.typing) {
    bubble.classList.add('show');
    sub.textContent = c.type === 'group' ? `${t.name} is typing…` : 'typing…';
    sub.className = 'sub typing';
    const box = $('messages');
    if (box.scrollHeight - box.scrollTop - box.clientHeight < 140)
      box.scrollTop = box.scrollHeight;
    clearTimeout(state.peerTyping[t.user_id]);
    state.peerTyping[t.user_id] = setTimeout(() => onTyping({ ...t, typing: false }), 3000);
  } else {
    bubble.classList.remove('show');
    updateChatSub();
  }
}

function onSeen(d) {
  if (state.active?.type === 'direct' && state.active.peer.id !== d.by) return;
  for (const m of state.messages)
    if (m.sender_id === state.me.id) { m.seen = true; m.delivered = true; }
  document.querySelectorAll('.msg.me .ticks').forEach(t => {
    t.classList.add('seen');
    t.textContent = '✓✓';
  });
}

function onDeleted(d) {
  const m = state.messages.find(x => x.id === d.id);
  if (m) { m.deleted = true; m.body = ''; m.media_url = ''; }
  const el = document.querySelector(`.msg[data-id="${d.id}"]`);
  if (el && m) el.replaceWith(messageEl(m));
  loadChats().then(renderSideList);
}

/* ---------------- composing ---------------- */
const msgInput = $('msgInput');
msgInput.addEventListener('input', function () {
  this.style.height = 'auto';
  this.style.height = Math.min(this.scrollHeight, 120) + 'px';
  const hasText = this.value.trim().length > 0 || state.attach;
  $('sendBtn').style.display = hasText ? '' : 'none';
  $('micBtn').style.display = hasText ? 'none' : '';
  sendTyping(true);
});
msgInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(); }
});
$('sendBtn').addEventListener('click', sendMessage);

function sendTyping(on) {
  const c = state.active;
  if (!c || !state.socket) return;
  const payload = c.type === 'direct' ? { peer_id: c.peer.id } : { group_id: c.group.id };
  payload.typing = on;
  state.socket.emit('typing', payload);
  if (on) {
    clearTimeout(state.typingTimer);
    state.typingTimer = setTimeout(() => sendTyping(false), 2500);
  }
}

function sendMessage() {
  const c = state.active;
  if (!c) return;
  const body = msgInput.value.trim();
  if (!body && !state.attach) return;
  const payload = {
    body,
    media_url: state.attach?.url || '',
    media_type: state.attach?.kind || '',
    media_name: state.attach?.name || '',
  };
  if (c.type === 'direct') payload.peer_id = c.peer.id;
  else payload.group_id = c.group.id;
  state.socket.emit('send_message', payload);
  msgInput.value = '';
  msgInput.style.height = 'auto';
  $('sendBtn').style.display = 'none';
  $('micBtn').style.display = '';
  clearAttachment();
  sendTyping(false);
}

/* ---------------- attachments ---------------- */
$('attachBtn').addEventListener('click', () => $('fileInput').click());
$('fileInput').addEventListener('change', async function () {
  const file = this.files[0];
  this.value = '';
  if (!file) return;
  toast('Uploading…');
  const fd = new FormData();
  fd.append('file', file);
  try {
    const data = await api('/api/upload', { method: 'POST', body: fd });
    state.attach = { url: data.url, kind: data.kind, name: data.name };
    const prev = $('attachPreview');
    prev.classList.add('show');
    const thumb = $('attachThumb');
    if (data.kind === 'image') { thumb.src = data.url; thumb.style.display = ''; }
    else thumb.style.display = 'none';
    $('attachName').textContent =
      (data.kind === 'image' ? '📷 ' : data.kind === 'video' ? '🎬 ' :
       data.kind === 'audio' ? '🎵 ' : '📎 ') + data.name;
    $('sendBtn').style.display = '';
    $('micBtn').style.display = 'none';
    toast('Ready to send');
  } catch (e) { toast(e.message); }
});
$('attachCancel').addEventListener('click', clearAttachment);
function clearAttachment() {
  state.attach = null;
  $('attachPreview').classList.remove('show');
  if (!msgInput.value.trim()) {
    $('sendBtn').style.display = 'none';
    $('micBtn').style.display = '';
  }
}

/* ---------------- emoji picker ---------------- */
const EMOJIS = ('😀 😃 😄 😁 😆 😅 🤣 😂 🙂 😉 😊 😇 🥰 😍 🤩 😘 😗 😚 😋 😛 😜 🤪 😝 🤑 ' +
  '🤗 🤭 🤫 🤔 🤐 🤨 😐 😑 😶 😏 😒 🙄 😬 😮‍💨 🤥 😌 😔 😪 🤤 😴 😷 🤒 🤕 🤢 🤮 🥵 🥶 ' +
  '😵 🤯 🤠 🥳 😎 🤓 🧐 😕 😟 🙁 😮 😯 😲 😳 🥺 😦 😨 😰 😥 😢 😭 😱 😖 😣 😞 😓 😩 😫 ' +
  '🥱 😤 😡 😠 🤬 💀 💩 🤡 👹 👺 👻 👽 🤖 😺 😸 😹 😻 😼 😽 🙀 😿 😾 🙈 🙉 🙊 ' +
  '❤️ 🧡 💛 💚 💙 💜 🖤 🤍 🤎 💔 ❣️ 💕 💞 💓 💗 💖 💘 💝 💟 ✨ ⭐ 🌟 💫 🔥 💯 💢 💥 ' +
  '👍 👎 👊 ✊ 🤛 🤜 👏 🙌 👐 🤲 🤝 🙏 ✌️ 🤞 🤟 🤘 🤙 👌 🤌 👈 👉 👆 👇 ☝️ ✋ 🤚 🖐️ 🖖 👋 💪 ' +
  '🎉 🎊 🎈 🎁 🏆 🥇 🎂 🍰 🍕 🍔 🍟 🌮 🍜 🍣 ☕ 🍵 🧋 🍺 🥂 🍩 🍪 🍫 🍿 🍎 🥭 🍇 🍉 ' +
  '⚽ 🏏 🏀 🎮 🎧 🎤 🎸 📱 💻 📷 🚗 ✈️ 🚀 🏠 🌈 ☀️ 🌙 ⛅ 🌧️ ⚡ ❄️ 🌊 🌺 🌸 🌹 🌻 🍀')
  .split(/\s+/).filter(e => e && !/[a-z]/i.test(e));

function buildEmojiPanel() {
  const panel = $('emojiPanel');
  for (const e of EMOJIS) {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = e;
    b.addEventListener('click', () => {
      msgInput.value += e;
      msgInput.dispatchEvent(new Event('input'));
      msgInput.focus();
    });
    panel.appendChild(b);
  }
}
buildEmojiPanel();
$('emojiBtn').addEventListener('click', (e) => {
  e.stopPropagation();
  $('emojiPanel').classList.toggle('show');
});
document.addEventListener('click', (e) => {
  if (!$('emojiPanel').contains(e.target) && e.target !== $('emojiBtn'))
    $('emojiPanel').classList.remove('show');
});

/* ---------------- voice notes ---------------- */
let recorder = null, recChunks = [], recStart = 0, recTimer = null, recCancelled = false;

$('micBtn').addEventListener('click', async () => {
  if (recorder && recorder.state === 'recording') { stopRecording(false); return; }
  if (!navigator.mediaDevices?.getUserMedia) { toast('Microphone not available'); return; }
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    const mime = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
      ? 'audio/webm;codecs=opus'
      : (MediaRecorder.isTypeSupported('audio/mp4') ? 'audio/mp4' : '');
    recorder = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
    recChunks = [];
    recCancelled = false;
    recorder.ondataavailable = (e) => { if (e.data.size) recChunks.push(e.data); };
    recorder.onstop = async () => {
      stream.getTracks().forEach(t => t.stop());
      $('recordPill').classList.remove('show');
      msgInput.style.display = '';
      $('micBtn').textContent = '🎤';
      clearInterval(recTimer);
      if (recCancelled || !recChunks.length) return;
      const ext = (recorder.mimeType || '').includes('mp4') ? 'm4a' : 'webm';
      const blob = new Blob(recChunks, { type: recorder.mimeType || 'audio/webm' });
      if (blob.size < 1000) { toast('Recording too short'); return; }
      const fd = new FormData();
      fd.append('file', blob, `voice-note.${ext}`);
      fd.append('kind', 'voice');
      toast('Sending voice note…');
      try {
        const data = await api('/api/upload', { method: 'POST', body: fd });
        state.attach = { url: data.url, kind: 'voice', name: 'Voice note' };
        sendMessage();
      } catch (e) { toast(e.message); }
    };
    recorder.start();
    recStart = Date.now();
    msgInput.style.display = 'none';
    $('recordPill').classList.add('show');
    $('micBtn').textContent = '✅';
    recTimer = setInterval(() => {
      $('recordTime').textContent = fmtDuration(Math.floor((Date.now() - recStart) / 1000));
    }, 250);
  } catch (e) {
    toast('Microphone permission denied');
  }
});
$('recordCancel').addEventListener('click', () => stopRecording(true));
function stopRecording(cancel) {
  recCancelled = cancel;
  if (recorder && recorder.state === 'recording') recorder.stop();
}

/* ---------------- search ---------------- */
let searchTimer = null;
$('searchInput').addEventListener('input', function () {
  clearTimeout(searchTimer);
  const q = this.value.trim();
  if (!q) { renderSideList(); return; }
  searchTimer = setTimeout(async () => {
    const data = await api('/api/search?q=' + encodeURIComponent(q));
    const list = $('sideList');
    list.innerHTML = '';
    if (!data.results.length) {
      list.innerHTML = `<div class="empty-list">No messages match “${esc(q)}”.</div>`;
      return;
    }
    for (const m of data.results) {
      const el = document.createElement('div');
      el.className = 'chat-item';
      const where = m.group_id
        ? (state.chats.find(c => c.type === 'group' && c.group.id === m.group_id)?.group.name || 'Group')
        : (m.sender_id === state.me.id
            ? (state.contacts.find(c => c.id === m.recipient_id)?.display_name || 'Chat')
            : m.sender_name);
      el.innerHTML = `
        <div class="avatar small"><span>🔎</span></div>
        <div class="meta">
          <div class="name"><span>${esc(where)}</span><time>${fmtDay(m.created_at)}</time></div>
          <div class="preview"><span>${esc(m.body.slice(0, 60))}</span></div>
        </div>`;
      el.addEventListener('click', () => {
        $('searchInput').value = '';
        const chat = m.group_id
          ? state.chats.find(c => c.type === 'group' && c.group.id === m.group_id)
          : state.chats.find(c => c.type === 'direct' &&
              (c.peer.id === m.sender_id || c.peer.id === m.recipient_id));
        if (chat) openChat(chat);
        renderSideList();
      });
      list.appendChild(el);
    }
  }, 300);
});

/* ---------------- tabs ---------------- */
document.querySelectorAll('.tab').forEach(t => t.addEventListener('click', function () {
  document.querySelectorAll('.tab').forEach(x => x.classList.remove('active'));
  this.classList.add('active');
  state.tab = this.dataset.tab;
  renderSideList();
}));

$('backBtn').addEventListener('click', () => {
  $('app').classList.remove('chat-open');
  state.active = null;
  $('chatView').style.display = 'none';
  $('chatWelcome').style.display = 'grid';
  renderSideList();
});

/* ---------------- modals ---------------- */
document.querySelectorAll('[data-close]').forEach(b =>
  b.addEventListener('click', () => $(b.dataset.close).classList.remove('show')));
document.querySelectorAll('.overlay').forEach(o =>
  o.addEventListener('click', (e) => {
    if (e.target === o && o.id !== 'callOverlay') o.classList.remove('show');
  }));
$('lightbox').addEventListener('click', () => $('lightbox').classList.remove('show'));

/* --- profile --- */
$('profileBtn').addEventListener('click', () => {
  const me = state.me;
  $('profileAvatarTxt').textContent = initials(me.display_name);
  const pa = $('profileAvatar');
  pa.querySelector('img')?.remove();
  if (me.avatar) {
    const img = document.createElement('img');
    img.src = me.avatar;
    pa.prepend(img);
  }
  $('profName').value = me.display_name;
  $('profAbout').value = me.about || '';
  $('profUsername').value = '@' + me.username;
  $('notifHint').textContent = NewqNotify.statusText();
  $('profileModal').classList.add('show');
});
$('avatarInput').addEventListener('change', async function () {
  const file = this.files[0];
  this.value = '';
  if (!file) return;
  const fd = new FormData();
  fd.append('avatar', file);
  try {
    const data = await api('/api/me/avatar', { method: 'POST', body: fd });
    state.me.avatar = data.avatar;
    $('profileBtn').click();
    toast('Photo updated');
  } catch (e) { toast(e.message); }
});
$('saveProfileBtn').addEventListener('click', async () => {
  try {
    const body = {
      display_name: $('profName').value,
      about: $('profAbout').value,
    };
    if ($('profPassNew').value) {
      body.current_password = $('profPassCur').value;
      body.new_password = $('profPassNew').value;
    }
    const data = await api('/api/me', { method: 'PUT', body: JSON.stringify(body) });
    state.me = data.user;
    $('myAvatarMini').textContent = initials(state.me.display_name);
    $('profPassCur').value = $('profPassNew').value = '';
    $('profileModal').classList.remove('show');
    toast('Profile saved');
  } catch (e) { toast(e.message); }
});
$('logoutBtn').addEventListener('click', async () => {
  await api('/api/logout', { method: 'POST' });
  location.href = '/login';
});

/* --- redeem code --- */
$('redeemBtn').addEventListener('click', () => {
  $('codeInput').value = '';
  $('redeemModal').classList.add('show');
  $('codeInput').focus();
});
$('codeSubmitBtn').addEventListener('click', async () => {
  try {
    const data = await api('/api/codes/redeem', {
      method: 'POST',
      body: JSON.stringify({ code: $('codeInput').value.trim() }),
    });
    $('redeemModal').classList.remove('show');
    if (data.new_contacts.length)
      toast(`Connected with ${data.new_contacts.map(c => c.display_name).join(', ')} 🎉`);
    else
      toast('Code accepted — you\'ll connect when others enter it too.');
    await loadContacts();
    await loadChats();
    renderSideList();
  } catch (e) { toast(e.message); }
});
$('codeInput').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') $('codeSubmitBtn').click();
});

/* --- new group --- */
$('newGroupBtn').addEventListener('click', () => {
  const wrap = $('groupMembers');
  wrap.innerHTML = state.contacts.length ? '' :
    '<p class="hint">No contacts yet — enter a connect code first.</p>';
  for (const c of state.contacts) {
    const label = document.createElement('label');
    label.className = 'member-pick';
    label.innerHTML = `<input type="checkbox" value="${c.id}">
      ${avatarHTML(c, 'small')}<span>${esc(c.display_name)}</span>`;
    wrap.appendChild(label);
  }
  $('groupName').value = '';
  $('groupModal').classList.add('show');
});
$('createGroupBtn').addEventListener('click', async () => {
  const ids = [...document.querySelectorAll('#groupMembers input:checked')]
    .map(i => parseInt(i.value));
  try {
    const data = await api('/api/groups', {
      method: 'POST',
      body: JSON.stringify({ name: $('groupName').value, member_ids: ids }),
    });
    $('groupModal').classList.remove('show');
    await loadChats();
    renderSideList();
    openChat({ type: 'group', group: data.group });
    toast('Group created 🎉');
  } catch (e) { toast(e.message); }
});

/* --- status compose / view --- */
let statusFile = null;
$('newStatusBtn').addEventListener('click', () => {
  statusFile = null;
  $('statusText').value = '';
  $('statusFileName').textContent = '';
  $('statusModal').classList.add('show');
});
$('statusMediaBtn').addEventListener('click', () => $('statusFile').click());
$('statusFile').addEventListener('change', function () {
  statusFile = this.files[0] || null;
  $('statusFileName').textContent = statusFile ? '📎 ' + statusFile.name : '';
  this.value = '';
});
$('postStatusBtn').addEventListener('click', async () => {
  try {
    if (statusFile) {
      const fd = new FormData();
      fd.append('file', statusFile);
      fd.append('text', $('statusText').value);
      await api('/api/status', { method: 'POST', body: fd });
    } else {
      await api('/api/status', {
        method: 'POST',
        body: JSON.stringify({ text: $('statusText').value }),
      });
    }
    $('statusModal').classList.remove('show');
    toast('Status posted ✨');
    if (state.tab === 'status') renderSideList();
  } catch (e) { toast(e.message); }
});

function viewStatus(st) {
  const media = $('statusViewMedia');
  media.innerHTML = '';
  if (st.media_url) {
    media.innerHTML = st.media_type === 'video'
      ? `<video class="status-media" src="${esc(st.media_url)}" controls autoplay></video>`
      : `<img class="status-media" src="${esc(st.media_url)}" alt="Status">`;
  }
  $('svAvatarTxt').textContent = initials(st.user_name);
  const sa = $('svAvatar');
  sa.querySelector('img')?.remove();
  if (st.avatar) {
    const img = document.createElement('img');
    img.src = st.avatar;
    sa.prepend(img);
  }
  $('svName').textContent = st.user_name;
  $('svTime').textContent = fmtDay(st.created_at) + ' · ' + fmtTime(st.created_at);
  $('svText').textContent = st.text || '';
  $('statusViewModal').classList.add('show');
}

/* ---------------- calls (delegates to webrtc.js) ---------------- */
$('audioCallBtn').addEventListener('click', () => {
  if (state.active?.type === 'direct') NewqRTC.startCall(state.active.peer, 'audio');
});
$('videoCallBtn').addEventListener('click', () => {
  if (state.active?.type === 'direct') NewqRTC.startCall(state.active.peer, 'video');
});

/* ---------------- theme & install ---------------- */
function setupTheme() {
  const btn = $('themeBtn');
  const apply = () => {
    const t = document.documentElement.getAttribute('data-theme');
    btn.textContent = t === 'light' ? '☀️' : '🌙';
    document.querySelector('meta[name="theme-color"]')
      .setAttribute('content', t === 'light' ? '#eef2fb' : '#0b0f1a');
  };
  btn.addEventListener('click', () => {
    const cur = document.documentElement.getAttribute('data-theme');
    const next = cur === 'light' ? 'dark' : 'light';
    document.documentElement.setAttribute('data-theme', next);
    localStorage.setItem('newq-theme', next);
    apply();
  });
  apply();
}

function setupInstall() {
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    state.deferredInstall = e;
    $('installBtn').classList.add('show');
  });
  $('installBtn').addEventListener('click', async () => {
    if (state.deferredInstall) {
      state.deferredInstall.prompt();
      const { outcome } = await state.deferredInstall.userChoice;
      if (outcome === 'accepted') $('installBtn').classList.remove('show');
      state.deferredInstall = null;
    } else {
      // iOS Safari has no install prompt API.
      toast('On iPhone: tap Share → “Add to Home Screen”', 4200);
    }
  });
  window.addEventListener('appinstalled', () => {
    $('installBtn').classList.remove('show');
    toast('NEWQ installed 🎉');
  });
  // Show the hint button on iOS where beforeinstallprompt never fires.
  const isIOS = /iphone|ipad|ipod/i.test(navigator.userAgent);
  const standalone = window.matchMedia('(display-mode: standalone)').matches
    || navigator.standalone;
  if (isIOS && !standalone) $('installBtn').classList.add('show');
}

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && state.active) markSeen();
});

boot();
