// background.js — Whisper Speech Input

browser.runtime.onMessage.addListener((msg, sender) => {
  if (msg.type === "check-server") {
    return fetch("http://localhost:8080/health", { method: "GET" })
      .then((r) => ({ ok: r.ok, status: r.status }))
      .catch(() => ({ ok: false, status: 0 }));
  }
});
