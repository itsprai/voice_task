// TaskVoice v2 Service Worker

self.addEventListener('install',  () => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));

self.addEventListener('push', event => {
  const data = event.data?.json() ?? {};
  event.waitUntil(self.registration.showNotification(data.title ?? '⏰ Task due soon', {
    body:     data.body ?? 'You have a task due soon',
    icon:     '/icon-192.png',
    badge:    '/icon-192.png',
    vibrate:  [200, 100, 200],
    tag:      data.taskId ?? 'taskvoice-reminder',
    renotify: true,
    data:     { url: data.url ?? '/' },
    actions:  [
      { action: 'view',    title: 'View Task' },
      { action: 'dismiss', title: 'Dismiss'   }
    ]
  }));
});

self.addEventListener('notificationclick', event => {
  event.notification.close();
  if (event.action === 'dismiss') return;
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
      for (const client of list) {
        if (client.url.includes(self.location.origin) && 'focus' in client) return client.focus();
      }
      return self.clients.openWindow(event.notification.data?.url ?? '/');
    })
  );
});
