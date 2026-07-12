// Minimal service worker for Web Push price alerts. Registered from
// index.html only when a user turns on alerts (not on every visit).
self.addEventListener("push", (event) => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch (_e) {}
  event.waitUntil(
    self.registration.showNotification(data.title || "PaperTrade", {
      body: data.body || "",
      icon: data.icon || undefined,
      badge: data.icon || undefined,
      data: { url: data.url || "/" },
    })
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || "/";
  event.waitUntil(clients.openWindow(url));
});
