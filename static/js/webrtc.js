/* ============================================================
   NEWQ WebRTC — voice & video calls with timer and reconnect
   ============================================================ */
'use strict';

const NewqRTC = (() => {
  const RTC_CONFIG = {
    iceServers: [
      { urls: 'stun:stun.l.google.com:19302' },
      { urls: 'stun:stun1.l.google.com:19302' },
      // For calls across strict NATs / mobile networks, add your TURN
      // server here, e.g.:
      // { urls: 'turn:turn.example.com:3478', username: 'user', credential: 'pass' }
    ],
  };

  let socket = null;
  let pc = null;
  let localStream = null;
  let call = null;        // { id, peer, kind, direction, offer? }
  let timerInterval = null;
  let startedAt = 0;
  let reconnectTimer = null;
  let makingOffer = false;
  const pendingIce = [];

  const ui = {
    overlay: () => document.getElementById('callOverlay'),
    name: () => document.getElementById('callName'),
    state: () => document.getElementById('callState'),
    timer: () => document.getElementById('callTimer'),
    avatarTxt: () => document.getElementById('callAvatarTxt'),
    avatar: () => document.getElementById('callAvatar'),
    videoWrap: () => document.getElementById('videoWrap'),
    localVideo: () => document.getElementById('localVideo'),
    remoteVideo: () => document.getElementById('remoteVideo'),
    remoteAudio: () => document.getElementById('remoteAudio'),
    incoming: () => document.getElementById('incomingActions'),
    active: () => document.getElementById('activeActions'),
    muteBtn: () => document.getElementById('muteBtn'),
    camBtn: () => document.getElementById('camBtn'),
  };

  function setState(text, bad) {
    ui.state().textContent = text;
    ui.state().className = 'call-state' + (bad ? ' bad' : '');
  }

  function showOverlay(peer, kind) {
    ui.name().textContent = peer.display_name;
    ui.avatarTxt().textContent = peer.display_name
      .trim().split(/\s+/).map(w => w[0]).slice(0, 2).join('').toUpperCase();
    const av = ui.avatar();
    av.querySelector('img')?.remove();
    if (peer.avatar) {
      const img = document.createElement('img');
      img.src = peer.avatar;
      av.prepend(img);
    }
    ui.videoWrap().classList.toggle('show', kind === 'video');
    ui.avatar().style.display = kind === 'video' ? 'none' : '';
    ui.camBtn().style.display = kind === 'video' ? '' : 'none';
    ui.timer().style.display = 'none';
    ui.overlay().classList.add('show');
  }

  async function getMedia(kind) {
    const constraints = kind === 'video'
      ? { audio: { echoCancellation: true, noiseSuppression: true },
          video: { width: { ideal: 1280 }, height: { ideal: 720 }, facingMode: 'user' } }
      : { audio: { echoCancellation: true, noiseSuppression: true } };
    return navigator.mediaDevices.getUserMedia(constraints);
  }

  function buildPeerConnection() {
    pc = new RTCPeerConnection(RTC_CONFIG);

    pc.onicecandidate = (e) => {
      if (e.candidate && call) {
        socket.emit('ice_candidate', {
          to: call.peer.id, candidate: e.candidate, call_id: call.id,
        });
      }
    };

    pc.ontrack = (e) => {
      const stream = e.streams[0];
      if (call.kind === 'video') ui.remoteVideo().srcObject = stream;
      else ui.remoteAudio().srcObject = stream;
    };

    pc.onconnectionstatechange = () => {
      if (!pc) return;
      if (pc.connectionState === 'connected') {
        setState('Connected');
        if (!startedAt) startTimer();
        clearTimeout(reconnectTimer);
      } else if (pc.connectionState === 'disconnected') {
        setState('Connection lost — reconnecting…', true);
        scheduleReconnect();
      } else if (pc.connectionState === 'failed') {
        setState('Reconnecting…', true);
        attemptReconnect();
      }
    };
  }

  function scheduleReconnect() {
    clearTimeout(reconnectTimer);
    reconnectTimer = setTimeout(() => {
      if (pc && pc.connectionState !== 'connected') attemptReconnect();
    }, 3000);
  }

  /* ICE restart: only the original caller creates the restart offer to
     avoid glare; the callee waits for the renegotiate offer. */
  async function attemptReconnect() {
    if (!pc || !call) return;
    if (call.direction !== 'out') return;
    try {
      makingOffer = true;
      const offer = await pc.createOffer({ iceRestart: true });
      await pc.setLocalDescription(offer);
      socket.emit('renegotiate', {
        to: call.peer.id, description: pc.localDescription, call_id: call.id,
      });
    } catch (err) {
      console.warn('Reconnect failed', err);
    } finally {
      makingOffer = false;
    }
  }

  function startTimer() {
    startedAt = Date.now();
    ui.timer().style.display = '';
    timerInterval = setInterval(() => {
      const s = Math.floor((Date.now() - startedAt) / 1000);
      const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
      ui.timer().textContent = (h ? String(h).padStart(2, '0') + ':' : '') +
        String(m).padStart(2, '0') + ':' + String(sec).padStart(2, '0');
    }, 500);
  }

  function durationSec() {
    return startedAt ? Math.floor((Date.now() - startedAt) / 1000) : 0;
  }

  function cleanup() {
    clearInterval(timerInterval);
    clearTimeout(reconnectTimer);
    timerInterval = null;
    startedAt = 0;
    pendingIce.length = 0;
    if (localStream) {
      localStream.getTracks().forEach(t => t.stop());
      localStream = null;
    }
    if (pc) { pc.close(); pc = null; }
    ui.localVideo().srcObject = null;
    ui.remoteVideo().srcObject = null;
    ui.remoteAudio().srcObject = null;
    ui.overlay().classList.remove('show');
    ui.incoming().style.display = 'none';
    ui.active().style.display = 'none';
    ui.muteBtn().classList.remove('muted-state');
    ui.camBtn().classList.remove('muted-state');
    call = null;
  }

  /* ---------------- outgoing ---------------- */
  async function startCall(peer, kind) {
    if (call) { toast('You are already in a call'); return; }
    if (!navigator.mediaDevices?.getUserMedia) {
      toast('Calls need HTTPS (or localhost) to access mic/camera');
      return;
    }
    try {
      localStream = await getMedia(kind);
    } catch (e) {
      toast(kind === 'video' ? 'Camera/mic permission denied' : 'Microphone permission denied');
      return;
    }
    call = { id: crypto.randomUUID(), peer, kind, direction: 'out' };
    showOverlay(peer, kind);
    setState('Calling…');
    ui.active().style.display = 'flex';
    if (kind === 'video') ui.localVideo().srcObject = localStream;

    buildPeerConnection();
    localStream.getTracks().forEach(t => pc.addTrack(t, localStream));
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    socket.emit('call_user', {
      to: peer.id, kind, offer: pc.localDescription, call_id: call.id,
    });
  }

  /* ---------------- incoming ---------------- */
  function onIncomingCall(data) {
    if (call) return; // busy — ignore; caller will time out / see no answer
    call = {
      id: data.call_id, peer: data.from, kind: data.kind,
      direction: 'in', offer: data.offer,
    };
    showOverlay(data.from, data.kind);
    setState(data.kind === 'video' ? 'Incoming video call…' : 'Incoming voice call…');
    ui.incoming().style.display = 'flex';
    ui.active().style.display = 'none';
    if (navigator.vibrate) navigator.vibrate([300, 150, 300]);
  }

  async function answerCall() {
    if (!call || call.direction !== 'in') return;
    try {
      localStream = await getMedia(call.kind);
    } catch (e) {
      toast('Permission denied — cannot answer');
      declineCall();
      return;
    }
    ui.incoming().style.display = 'none';
    ui.active().style.display = 'flex';
    setState('Connecting…');
    if (call.kind === 'video') ui.localVideo().srcObject = localStream;

    buildPeerConnection();
    localStream.getTracks().forEach(t => pc.addTrack(t, localStream));
    await pc.setRemoteDescription(new RTCSessionDescription(call.offer));
    while (pendingIce.length) await pc.addIceCandidate(pendingIce.shift()).catch(() => {});
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    socket.emit('call_answer', {
      to: call.peer.id, answer: pc.localDescription, call_id: call.id,
    });
  }

  function declineCall() {
    if (!call) return;
    socket.emit('call_decline', { to: call.peer.id, kind: call.kind, call_id: call.id });
    cleanup();
  }

  function hangUp() {
    if (!call) return;
    const meIsCaller = call.direction === 'out';
    socket.emit('call_end', {
      to: call.peer.id,
      call_id: call.id,
      duration: durationSec(),
      kind: call.kind,
      log: meIsCaller,          // only the caller writes the log entry
      caller_id: meIsCaller ? undefined : call.peer.id,
      callee_id: meIsCaller ? call.peer.id : undefined,
    });
    cleanup();
  }

  /* ---------------- socket wiring ---------------- */
  function bindSocket(s) {
    socket = s;

    s.on('incoming_call', onIncomingCall);

    s.on('call_answered', async (data) => {
      if (!call || data.call_id !== call.id || !pc) return;
      setState('Connecting…');
      await pc.setRemoteDescription(new RTCSessionDescription(data.answer));
      while (pendingIce.length) await pc.addIceCandidate(pendingIce.shift()).catch(() => {});
    });

    s.on('ice_candidate', async (data) => {
      if (!call || data.call_id !== call.id || !data.candidate) return;
      const candidate = new RTCIceCandidate(data.candidate);
      if (pc && pc.remoteDescription) {
        await pc.addIceCandidate(candidate).catch(() => {});
      } else {
        pendingIce.push(candidate);
      }
    });

    s.on('call_declined', (data) => {
      if (!call || data.call_id !== call.id) return;
      setState('Call declined', true);
      setTimeout(cleanup, 1400);
    });

    s.on('call_ended', (data) => {
      if (!call || data.call_id !== call.id) return;
      setState('Call ended');
      setTimeout(cleanup, 900);
    });

    s.on('call_failed', (data) => {
      setState(data.reason || 'Call failed', true);
      setTimeout(cleanup, 1800);
    });

    s.on('renegotiate', async (data) => {
      if (!call || data.call_id !== call.id || !pc) return;
      const desc = data.description;
      try {
        if (desc.type === 'offer') {
          if (makingOffer) return; // glare guard
          await pc.setRemoteDescription(new RTCSessionDescription(desc));
          const answer = await pc.createAnswer();
          await pc.setLocalDescription(answer);
          socket.emit('renegotiate', {
            to: call.peer.id, description: pc.localDescription, call_id: call.id,
          });
        } else if (desc.type === 'answer') {
          await pc.setRemoteDescription(new RTCSessionDescription(desc));
        }
      } catch (err) {
        console.warn('Renegotiation error', err);
      }
    });
  }

  /* ---------------- controls ---------------- */
  document.addEventListener('DOMContentLoaded', () => {
    ui.muteBtn().addEventListener('click', function () {
      if (!localStream) return;
      const track = localStream.getAudioTracks()[0];
      if (!track) return;
      track.enabled = !track.enabled;
      this.classList.toggle('muted-state', !track.enabled);
      this.title = track.enabled ? 'Mute microphone' : 'Unmute microphone';
    });
    ui.camBtn().addEventListener('click', function () {
      if (!localStream) return;
      const track = localStream.getVideoTracks()[0];
      if (!track) return;
      track.enabled = !track.enabled;
      this.classList.toggle('muted-state', !track.enabled);
      this.title = track.enabled ? 'Turn camera off' : 'Turn camera on';
    });
    document.getElementById('answerBtn').addEventListener('click', answerCall);
    document.getElementById('declineBtn').addEventListener('click', declineCall);
    document.getElementById('hangupBtn').addEventListener('click', hangUp);
  });

  window.addEventListener('beforeunload', () => { if (call) hangUp(); });

  return { startCall, bindSocket };
})();
