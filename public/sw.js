// Shows the studio's alerts and opens the right page when one is tapped.
self.addEventListener('push', e => {
  const d = e.data ? e.data.json() : {};
  e.waitUntil(self.registration.showNotification(d.title || 'Red Cherry IT Studio', { body: d.body || '', icon: '/assets/app-icon-192.png', badge: '/assets/app-icon-192.png', data: { url: d.url || '/' } }));
});
self.addEventListener('notificationclick', e => {
  e.notification.close();
  const url = new URL(e.notification.data?.url || '/', self.location.origin).href;
  e.waitUntil(clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
    const open = list.find(c => c.url.startsWith(self.location.origin));
    return open ? open.navigate(url).then(c => (c || open).focus()) : clients.openWindow(url);
  }));
});
