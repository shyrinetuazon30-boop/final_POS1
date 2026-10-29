importScripts(
  "https://www.gstatic.com/firebasejs/13.1.0/firebase-app-compat.js"
);

importScripts(
  "https://www.gstatic.com/firebasejs/13.1.0/firebase-messaging-compat.js"
);

firebase.initializeApp({
  apiKey: "AIzaSyBazX3JOri4eDJGRWP1QwiDLEoTYLoOjkI",
  authDomain: "yohan-store-pos.firebaseapp.com",
  projectId: "yohan-store-pos",
  storageBucket: "yohan-store-pos.firebasestorage.app",
  messagingSenderId: "796259422174",
  appId: "1:796259422174:web:b03bb35c13a793e64a574f"
});

const messaging = firebase.messaging();

// Background messages (app closed or in another tab).
//
// Message format used by the store server (Stage 4) - DATA ONLY, no "notification" block:
//   data: { type, title, body, productId, tag, url }
//
// Why: if a message had a "notification" block, Firebase would show it automatically AND
// this handler would also run, so you would see the alert twice. So we only draw the
// notification ourselves when Firebase did not already do it.
messaging.onBackgroundMessage((payload) => {
  if (payload.notification) return;   // Firebase already showed it

  const info = payload.data || {};
  const title = info.title || "Yohan Store POS";
  const options = {
    body: info.body || "You have a new store notification.",
    icon: "./icon-192.png",
    // Same tag = the newer alert replaces the older one (no pile of repeats per product).
    tag: info.tag || (info.productId ? "low-stock-" + info.productId : undefined),
    data: { url: info.url || "./" }
  };

  self.registration.showNotification(title, options);
});

// Tapping a notification opens (or focuses) the POS.
self.addEventListener("notificationclick", (event) => {
  event.notification.close();

  const target = new URL(
    (event.notification.data && event.notification.data.url) || "./",
    self.registration.scope
  ).href;

  event.waitUntil(
    clients.matchAll({ type: "window", includeUncontrolled: true }).then((windows) => {
      for (const client of windows) {
        if (client.url.startsWith(self.registration.scope) && "focus" in client) {
          return client.focus();
        }
      }
      return clients.openWindow(target);
    })
  );
});