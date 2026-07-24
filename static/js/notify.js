/* ============================================================
   NEWQ notifications — local browser notifications.
   No server-side push library needed: the app shows a system
   notification when a message arrives while the tab is hidden.
   ============================================================ */
'use strict';

const NewqNotify = (() => {
  let status = 'unsupported';

  async function init() {
    if (!('Notification' in window)) { status = 'unsupported'; return; }
    let perm = Notification.permission;
    if (perm === 'default') {
      // Ask shortly after load so the prompt has context.
      await new Promise((r) => setTimeout(r, 2500));
      try { perm = await Notification.requestPermission(); } catch (e) {}
    }
    status = perm === 'granted' ? 'on' : 'denied';
  }

  async function show(title, body) {
    if (status !== 'on' || document.visibilityState === 'visible') return;
    const opts = {
      body,
      icon: '/static/icons/icon-192.png',
      badge: '/static/icons/badge-72.png',
      tag: 'newq-message',
      renotify: true,
      vibrate: [200, 100, 200],
      data: { url: '/' },
    };
    try {
      // Prefer the service worker so notifications work in installed PWAs.
      const reg = await navigator.serviceWorker?.getRegistration();
      if (reg) return reg.showNotification(title, opts);
      new Notification(title, opts);
    } catch (e) { /* notifications are best-effort */ }
  }

  function statusText() {
    switch (status) {
      case 'on':
        return '🔔 Message notifications are on while NEWQ is open in the background.';
      case 'denied':
        return '🔕 Notifications are blocked — enable them in your browser settings to get message alerts.';
      default:
        return 'This browser does not support notifications.';
    }
  }

  return { init, show, statusText };
})();
