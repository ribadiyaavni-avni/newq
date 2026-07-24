/* ============================================================
   NEWQ realtime — plain-Flask polling client.
   Exposes a Socket.IO-compatible { on, emit } object so the rest
   of the app (chat + WebRTC signaling) works without a socket
   library or any server-side extension.
   ============================================================ */
'use strict';

const NewqRT = (() => {
  const handlers = {};
  const seenMessageIds = new Set();
  let cursor = null;          // last message id we've processed
  let baseInterval = 2000;    // normal poll cadence (ms)
  const FAST_INTERVAL = 700;  // during call setup / active calls
  let fastUntil = 0;
  let timer = null;
  let polling = false;
  let failures = 0;

  function on(event, cb) {
    (handlers[event] = handlers[event] || []).push(cb);
  }

  function dispatch(event, data) {
    (handlers[event] || []).forEach((cb) => {
      try { cb(data); } catch (err) { console.error(`[NEWQ] handler ${event}`, err); }
    });
  }

  function goFast(ms) {
    fastUntil = Date.now() + (ms || 60000);
    schedule(FAST_INTERVAL);
  }

  const CALL_EVENTS = new Set(['call_user', 'call_answer', 'call_decline',
    'ice_candidate', 'call_end', 'renegotiate']);
  const CALL_INCOMING = new Set(['incoming_call', 'call_answered',
    'ice_candidate', 'renegotiate']);
  const CALL_OVER = new Set(['call_ended', 'call_declined', 'call_failed']);

  async function post(url, body) {
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body || {}),
      });
      if (res.status === 401) { location.href = '/login'; return null; }
      return await res.json();
    } catch (err) {
      return null;
    }
  }

  /* Socket.IO-style emit, mapped onto REST endpoints. */
  async function emit(event, data) {
    data = data || {};
    switch (event) {
      case 'send_message': {
        const res = await post('/api/messages/send', data);
        if (res && res.ok) {
          seenMessageIds.add(res.message.id);
          if (res.message.id > (cursor || 0)) cursor = res.message.id;
          dispatch('new_message', res.message);   // instant local echo
        } else if (res && res.error) {
          dispatch('error_toast', { message: res.error });
        }
        break;
      }
      case 'typing':
        post('/api/typing', data);
        break;
      case 'mark_seen':
        post('/api/seen', data);
        break;
      case 'delete_message': {
        const res = await post('/api/messages/delete', data);
        if (res && res.ok) dispatch('message_deleted', { id: data.id });
        break;
      }
      default:
        if (CALL_EVENTS.has(event)) {
          goFast();                                // snappy signaling
          post('/api/signal', Object.assign({ event }, data));
          if (event === 'call_end' || event === 'call_decline') fastUntil = 0;
        } else {
          console.warn('[NEWQ] unknown emit', event);
        }
    }
  }

  async function poll() {
    if (polling) return;
    polling = true;
    try {
      const url = cursor === null
        ? '/api/poll?init=1'
        : `/api/poll?since=${cursor}`;
      const res = await fetch(url);
      if (res.status === 401) { location.href = '/login'; return; }
      const data = await res.json();
      failures = 0;

      if (cursor === null) {
        cursor = data.cursor || 0;
        if (data.interval) baseInterval = data.interval;
        dispatch('connect', {});
      } else {
        cursor = Math.max(cursor, data.cursor || 0);
      }

      for (const p of data.presence || []) dispatch('presence', p);

      for (const m of data.messages || []) {
        if (seenMessageIds.has(m.id)) continue;   // already echoed locally
        seenMessageIds.add(m.id);
        dispatch('new_message', m);
      }
      if (seenMessageIds.size > 2000) {           // keep the dedupe set small
        const keep = [...seenMessageIds].slice(-500);
        seenMessageIds.clear();
        keep.forEach((id) => seenMessageIds.add(id));
      }

      for (const ev of data.events || []) {
        if (CALL_INCOMING.has(ev.event)) goFast();
        if (CALL_OVER.has(ev.event)) fastUntil = 0;
        dispatch(ev.event, ev.data);
      }
    } catch (err) {
      failures += 1;
      if (failures === 3) dispatch('offline', {});
    } finally {
      polling = false;
      schedule();
    }
  }

  function schedule(delay) {
    clearTimeout(timer);
    let next = delay;
    if (next == null) {
      if (Date.now() < fastUntil) next = FAST_INTERVAL;
      else if (failures > 0) next = Math.min(15000, baseInterval * (failures + 1));
      else if (document.visibilityState === 'hidden') next = baseInterval * 3;
      else next = baseInterval;
    }
    timer = setTimeout(poll, next);
  }

  function connect() {
    poll();
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') { clearTimeout(timer); poll(); }
    });
    window.addEventListener('online', () => { failures = 0; clearTimeout(timer); poll(); });
    return { on, emit };
  }

  return { connect };
})();
