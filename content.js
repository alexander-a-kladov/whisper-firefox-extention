// content.js — Whisper Speech Input
// Injects a mic button next to every text input/textarea on the page

(function () {
  "use strict";

  const SERVER_URL = "http://localhost:8080";
  const SUPPORTED_INPUTS = 'input[type="text"], input[type="search"], input[type="email"], input[type="url"], input:not([type]), textarea, [contenteditable="true"]';

  let mediaRecorder = null;
  let audioChunks = [];
  let activeButton = null;
  let activeInput = null;
  let stream = null;

  // ─── Styles are in content.css ─────────────────────────────────────────────

  // ─── Create mic button ──────────────────────────────────────────────────────
  function createMicButton(inputEl) {
    const btn = document.createElement("button");
    btn.className = "wsp-mic-btn";
    btn.type = "button";
    btn.title = "Click to record (Whisper)";
    btn.setAttribute("aria-label", "Start voice input");
    btn.innerHTML = iconMic();
    btn.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      toggleRecording(btn, inputEl);
    });
    return btn;
  }

  function iconMic() {
    return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <rect x="9" y="2" width="6" height="12" rx="3"/>
      <path d="M19 10a7 7 0 0 1-14 0"/>
      <line x1="12" y1="19" x2="12" y2="22"/>
      <line x1="8" y1="22" x2="16" y2="22"/>
    </svg>`;
  }

  function iconStop() {
    return `<svg viewBox="0 0 24 24" fill="currentColor">
      <rect x="6" y="6" width="12" height="12" rx="2"/>
    </svg>`;
  }

  function iconSpin() {
    return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" class="wsp-spin">
      <path d="M21 12a9 9 0 1 1-6.219-8.56"/>
    </svg>`;
  }

  // ─── Wrap input to allow button overlay ─────────────────────────────────────
  function wrapInput(inputEl) {
    if (inputEl.dataset.wspWrapped) return;
    inputEl.dataset.wspWrapped = "1";

    const btn = createMicButton(inputEl);

    // For textareas and large inputs: insert button after
    // For inline inputs: use a wrapper
    if (inputEl.tagName === "TEXTAREA" || inputEl.isContentEditable) {
      btn.classList.add("wsp-block-btn");
      inputEl.insertAdjacentElement("afterend", btn);
    } else {
      const wrapper = document.createElement("span");
      wrapper.className = "wsp-wrapper";
      inputEl.parentNode.insertBefore(wrapper, inputEl);
      wrapper.appendChild(inputEl);
      wrapper.appendChild(btn);
    }
  }

  // ─── Recording logic ────────────────────────────────────────────────────────
  async function toggleRecording(btn, inputEl) {
    if (mediaRecorder && mediaRecorder.state === "recording") {
      stopRecording();
      return;
    }

    // Stop any existing session first
    if (mediaRecorder) stopRecording();

    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (err) {
      showToast("Microphone access denied.", "error");
      return;
    }

    audioChunks = [];
    activeButton = btn;
    activeInput = inputEl;

    const mimeType = MediaRecorder.isTypeSupported("audio/webm;codecs=opus")
      ? "audio/webm;codecs=opus"
      : "audio/webm";

    mediaRecorder = new MediaRecorder(stream, { mimeType });

    mediaRecorder.ondataavailable = (e) => {
      if (e.data.size > 0) audioChunks.push(e.data);
    };

    mediaRecorder.onstop = async () => {
      setButtonState(btn, "loading");
      stream.getTracks().forEach((t) => t.stop());
      stream = null;

      const blob = new Blob(audioChunks, { type: mimeType });
      await transcribeAndInsert(blob, inputEl, btn);
    };

    mediaRecorder.start(250); // collect in 250ms chunks
    setButtonState(btn, "recording");
    showToast("Recording… click mic to stop.", "info");
  }

  function stopRecording() {
    if (mediaRecorder && mediaRecorder.state === "recording") {
      mediaRecorder.stop();
    }
  }

  function setButtonState(btn, state) {
    btn.dataset.wspState = state;
    btn.title =
      state === "recording"
        ? "Recording — click to stop"
        : state === "loading"
        ? "Transcribing…"
        : "Click to record (Whisper)";
    btn.setAttribute("aria-label", btn.title);

    if (state === "recording") btn.innerHTML = iconStop();
    else if (state === "loading") btn.innerHTML = iconSpin();
    else btn.innerHTML = iconMic();
  }

  // ─── Send to whisper.cpp server ─────────────────────────────────────────────
  async function transcribeAndInsert(blob, inputEl, btn) {
    try {
      const formData = new FormData();
      // whisper.cpp server expects field named "file"
      formData.append("file", blob, "recording.webm");
      formData.append("response_format", "json");

      const res = await fetch(`${SERVER_URL}/inference`, {
        method: "POST",
        body: formData,
      });

      if (!res.ok) {
        const text = await res.text();
        throw new Error(`Server ${res.status}: ${text}`);
      }

      const data = await res.json();
      const transcript = (data.text || "").trim();

      if (!transcript) {
        showToast("Nothing heard — try again.", "warning");
      } else {
        insertText(inputEl, transcript);
        showToast("✓ Transcribed", "success");
      }
    } catch (err) {
      console.error("[Whisper ext]", err);
      showToast(`Transcription failed: ${err.message}`, "error");
    } finally {
      setButtonState(btn, "idle");
      activeButton = null;
      activeInput = null;
    }
  }

  // ─── Insert text into various input types ───────────────────────────────────
  function insertText(el, text) {
    if (el.isContentEditable) {
      el.focus();
      const sel = window.getSelection();
      if (sel.rangeCount) {
        const range = sel.getRangeAt(0);
        range.deleteContents();
        range.insertNode(document.createTextNode(text));
        range.collapse(false);
      } else {
        el.textContent += text;
      }
      el.dispatchEvent(new Event("input", { bubbles: true }));
      return;
    }

    el.focus();
    const start = el.selectionStart ?? el.value.length;
    const end = el.selectionEnd ?? el.value.length;
    const before = el.value.slice(0, start);
    const after = el.value.slice(end);
    const spacer = before.length > 0 && !before.endsWith(" ") ? " " : "";
    el.value = before + spacer + text + after;
    const newPos = start + spacer.length + text.length;
    el.setSelectionRange(newPos, newPos);

    // Trigger framework change events
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  }

  // ─── Toast notifications ─────────────────────────────────────────────────────
  function showToast(msg, type = "info") {
    const existing = document.getElementById("wsp-toast");
    if (existing) existing.remove();

    const toast = document.createElement("div");
    toast.id = "wsp-toast";
    toast.className = `wsp-toast wsp-toast--${type}`;
    toast.textContent = msg;
    document.body.appendChild(toast);

    // Force reflow to trigger transition
    toast.getBoundingClientRect();
    toast.classList.add("wsp-toast--visible");

    setTimeout(() => {
      toast.classList.remove("wsp-toast--visible");
      setTimeout(() => toast.remove(), 300);
    }, 3000);
  }

  // ─── Observe DOM for new inputs ─────────────────────────────────────────────
  function attachToInputs() {
    document.querySelectorAll(SUPPORTED_INPUTS).forEach((el) => {
      // Skip hidden, tiny, or already wrapped
      if (el.dataset.wspWrapped) return;
      if (el.offsetParent === null) return; // hidden
      if (el.offsetWidth < 40) return;
      wrapInput(el);
    });
  }

  const observer = new MutationObserver(() => attachToInputs());
  observer.observe(document.body, { childList: true, subtree: true });
  attachToInputs();

  // ─── Stop recording if user presses Escape ──────────────────────────────────
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && mediaRecorder && mediaRecorder.state === "recording") {
      stopRecording();
    }
  });

  // ─── Message from popup (e.g. settings update) ──────────────────────────────
  browser.runtime.onMessage.addListener((msg) => {
    if (msg.type === "ping") return Promise.resolve({ alive: true });
  });
})();
