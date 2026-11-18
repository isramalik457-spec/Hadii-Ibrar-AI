
const CACHE_NAME = "hadii-ai-quant-v1";

self.addEventListener("install", (event) => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  const url = new URL(request.url);

  // Never cache live Gold market data
  if (url.pathname.startsWith("/api/")) {
    return;
  }

  // Do not intercept other requests
  if (request.method !== "GET") {
    return;
  }
});
