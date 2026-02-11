self.addEventListener('push', function(event) {
  let data = {};
  try { data = event.data.json(); } catch (e) { data = { title: 'BluePin', body: '새 알림이 있습니다', url: '/' }; }
  const title = data.title || 'BluePin';
  const options = {
    body: data.body || '새 알림이 있습니다',
    icon: '/logo.png',
    badge: '/logo.png',
    data: { url: data.url || '/' }
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', function(event) {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || '/';
  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(function(clientList) {
      for (const client of clientList) {
        if (client.url.includes(url) && 'focus' in client) return client.focus();
      }
      if (clients.openWindow) return clients.openWindow(url);
    })
  );
});
