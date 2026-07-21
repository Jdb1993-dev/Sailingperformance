// Minimale service worker, alleen nodig zodat de app installeerbaar is als PWA.
// Geen caching: de app heeft altijd live GPS/wind data nodig.
self.addEventListener("install", (e) => self.skipWaiting());
self.addEventListener("activate", (e) => self.clients.claim());
self.addEventListener("fetch", () => {});
