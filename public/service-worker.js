/* HoboStreamer — Service Worker for Push Notifications */

self.addEventListener('push', (event) => {
    if (!event.data) return;
    try {
        const data = event.data.json();
        const options = {
            body: data.body || '',
            icon: data.icon || '/assets/img/logo-192.png',
            badge: '/assets/img/logo-72.png',
            tag: data.tag || 'hobo-notification',
            data: { url: data.url || '/' },
            requireInteraction: false,
        };
        event.waitUntil(
            self.registration.showNotification(data.title || 'HoboStreamer', options)
        );
    } catch (e) {
        // Fallback for non-JSON payloads
        event.waitUntil(
            self.registration.showNotification('HoboStreamer', { body: event.data.text() })
        );
    }
});

self.addEventListener('notificationclick', (event) => {
    event.notification.close();
    const url = event.notification.data?.url || '/';
    event.waitUntil(
        clients.matchAll({ type: 'window', includeUncontrolled: true }).then((windowClients) => {
            // Focus existing tab if open
            for (const client of windowClients) {
                if (client.url.includes('hobostreamer.com') && 'focus' in client) {
                    client.focus();
                    if (url !== '/') client.navigate(url);
                    return;
                }
            }
            // Otherwise open new tab
            return clients.openWindow(url);
        })
    );
});
