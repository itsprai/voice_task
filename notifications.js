// Notifications — same as v1 but uses Auth JWT headers for Supabase calls

const Notifications = {
  _swReg:  null,
  _timers: {},

  async init(tasks = []) {
    await this._registerSW();
    if ('Notification' in window && Notification.permission === 'granted') {
      await this._subscribePush();
    }
    this.scheduleAll(tasks);
  },

  async requestPermission() {
    if (!('Notification' in window)) return 'unsupported';
    if (Notification.permission !== 'default') return Notification.permission;
    const result = await Notification.requestPermission();
    if (result === 'granted') await this._subscribePush();
    return result;
  },

  async _registerSW() {
    if (!('serviceWorker' in navigator)) return;
    try { this._swReg = await navigator.serviceWorker.register('sw.js'); }
    catch (err) { console.warn('[Notifications] SW registration failed:', err); }
  },

  async _subscribePush() {
    if (!this._swReg || !CONFIG.VAPID_PUBLIC_KEY || CONFIG.VAPID_PUBLIC_KEY === 'your_vapid_public_key_here') return;
    try {
      const existing = await this._swReg.pushManager.getSubscription();
      if (existing) {
        const existingKey = existing.options?.applicationServerKey;
        const newKey = this._urlBase64ToUint8Array(CONFIG.VAPID_PUBLIC_KEY);
        const keysMatch = existingKey && newKey.length === existingKey.byteLength &&
          newKey.every((b, i) => b === new Uint8Array(existingKey)[i]);
        if (!keysMatch) await existing.unsubscribe();
      }
      const sub = await this._swReg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: this._urlBase64ToUint8Array(CONFIG.VAPID_PUBLIC_KEY)
      });
      await this._saveSubscription(sub.toJSON());
    } catch (err) {
      console.warn('[Notifications] Push subscription failed:', err);
    }
  },

  async _saveSubscription(sub) {
    if (!Sync.configured || !Auth.profile) return;
    try {
      await fetch(`${CONFIG.SUPABASE_URL}/rest/v1/push_subscriptions`, {
        method:  'POST',
        headers: {
          'Content-Type':  'application/json',
          'apikey':        CONFIG.SUPABASE_ANON_KEY,
          'Authorization': `Bearer ${Auth.token}`,
          'Prefer':        'resolution=merge-duplicates,return=minimal'
        },
        body: JSON.stringify({
          endpoint: sub.endpoint,
          p256dh:   sub.keys.p256dh,
          auth:     sub.keys.auth,
          user_id:  Auth.profile.id
        })
      });
    } catch (err) {
      console.warn('[Notifications] Could not save subscription:', err);
    }
  },

  scheduleLocal(task) {
    if (!task.dueDate || !task.time || task.status === 'completed') return;
    const dueMs  = new Date(`${task.dueDate}T${task.time}`).getTime();
    const fireAt = dueMs - 5 * 60 * 1000;
    const delay  = fireAt - Date.now();
    if (delay <= 0 || delay > 24 * 60 * 60 * 1000) return;
    this.cancelLocal(task.id);
    this._timers[task.id] = setTimeout(async () => {
      const drift = Date.now() - fireAt;
      if (drift > 3 * 60 * 1000) return;
      if (Notification.permission !== 'granted') return;
      if (await this.isSubscribed()) return;
      new Notification('⏰ Task due soon', {
        body: `${task.description}`,
        icon: '/webapp-v2/icon-192.png'
      });
    }, delay);
  },

  cancelLocal(taskId) {
    clearTimeout(this._timers[taskId]);
    delete this._timers[taskId];
  },

  scheduleAll(tasks = []) { tasks.forEach(t => this.scheduleLocal(t)); },

  async unsubscribe() {
    try {
      const sub = await this._swReg?.pushManager?.getSubscription();
      if (!sub) return;
      if (Sync.configured && Auth.profile) {
        await fetch(`${CONFIG.SUPABASE_URL}/rest/v1/push_subscriptions?endpoint=eq.${encodeURIComponent(sub.endpoint)}`, {
          method:  'DELETE',
          headers: { 'apikey': CONFIG.SUPABASE_ANON_KEY, 'Authorization': `Bearer ${Auth.token}` }
        });
      }
      await sub.unsubscribe();
    } catch (err) {
      console.warn('[Notifications] Unsubscribe failed:', err);
    }
  },

  async isSubscribed() {
    if (!this._swReg) return false;
    return !!(await this._swReg.pushManager?.getSubscription());
  },

  _urlBase64ToUint8Array(base64) {
    const pad = '='.repeat((4 - base64.length % 4) % 4);
    const b64 = (base64 + pad).replace(/-/g, '+').replace(/_/g, '/');
    return Uint8Array.from(atob(b64), c => c.charCodeAt(0));
  }
};
