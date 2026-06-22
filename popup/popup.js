// popup.js — Whisper Speech Input

const urlInput = document.getElementById("server-url");
const saveBtn = document.getElementById("btn-save");
const statusDot = document.getElementById("status-dot");
const statusText = document.getElementById("status-text");

// ── Load saved URL ───────────────────────────────────────────────────────────
browser.storage.local.get("serverUrl").then(({ serverUrl }) => {
  if (serverUrl) urlInput.value = serverUrl;
  checkServer(urlInput.value);
});

// ── Save URL ─────────────────────────────────────────────────────────────────
saveBtn.addEventListener("click", () => {
  const url = urlInput.value.trim().replace(/\/$/, "");
  browser.storage.local.set({ serverUrl: url }).then(() => {
    showFlash("Saved ✓");
    checkServer(url);
  });
});

urlInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") saveBtn.click();
});

// ── Check server health ──────────────────────────────────────────────────────
async function checkServer(base) {
  statusDot.className = "dot dot--checking";
  statusText.textContent = "Checking…";
  statusText.className = "status-value";

  try {
    const res = await fetch(`${base}/health`, {
      method: "GET",
      signal: AbortSignal.timeout(3000),
    });

    if (res.ok) {
      statusDot.className = "dot dot--ok";
      statusText.textContent = "Online";
      statusText.className = "status-value ok";
    } else {
      throw new Error(`HTTP ${res.status}`);
    }
  } catch (err) {
    statusDot.className = "dot dot--error";
    statusText.textContent = "Offline";
    statusText.className = "status-value error";
  }
}

// ── Flash message ─────────────────────────────────────────────────────────────
function showFlash(msg) {
  let el = document.querySelector(".flash");
  if (!el) {
    el = document.createElement("div");
    el.className = "flash";
    document.body.appendChild(el);
  }
  el.textContent = msg;
  el.classList.add("visible");
  setTimeout(() => el.classList.remove("visible"), 1800);
}
