// background.js — Whisper Speech Input
// All fetch() calls to localhost happen here; content scripts can't reach
// localhost directly in Firefox due to CORS/security restrictions.

browser.runtime.onMessage.addListener((msg, sender) => {

  // ── Health check (used by popup) ──────────────────────────────────────────
  if (msg.type === "check-server") {
    return fetch("http://localhost:8080/health", { method: "GET" })
      .then((r) => ({ ok: r.ok, status: r.status }))
      .catch(() => ({ ok: false, status: 0 }));
  }

  // ── Transcription request from content script ─────────────────────────────
  if (msg.type === "transcribe") {
    return (async () => {
      try {
        // Reconstruct the Blob from the base64 string sent by the content script
        const byteChars = atob(msg.base64);
        const bytes = new Uint8Array(byteChars.length);
        for (let i = 0; i < byteChars.length; i++) {
          bytes[i] = byteChars.charCodeAt(i);
        }
        const blob = new Blob([bytes], { type: msg.mimeType });

        const formData = new FormData();
        formData.append("file", blob, "recording.wav");
        formData.append("response_format", "json");

        const res = await fetch("http://localhost:8080/inference", {
          method: "POST",
          body: formData,
        });

        if (!res.ok) {
          const errText = await res.text();
          return { ok: false, error: `Server ${res.status}: ${errText}` };
        }

        const data = await res.json();
        return { ok: true, text: data.text || "" };

      } catch (err) {
        return { ok: false, error: err.message };
      }
    })();
  }

});
