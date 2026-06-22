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

  // ─── Send to whisper.cpp via background script (avoids CORS on localhost) ───
  async function transcribeAndInsert(blob, inputEl, btn) {
    try {
      // Decode WebM/Opus → PCM float32 → WAV in the content script,
      // because AudioContext is not available in background scripts.
      const wavBase64 = await blobToWavBase64(blob);

      const response = await browser.runtime.sendMessage({
        type: "transcribe",
        base64: wavBase64,
        mimeType: "audio/wav",
      });

      if (!response.ok) {
        throw new Error(response.error || `Server error`);
      }

      const transcript = (response.text || "").trim();

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

  // ─── WebM Blob → WAV base64 ──────────────────────────────────────────────────
  // Decodes the recorded WebM/Opus blob using AudioContext (available in content
  // scripts), then re-encodes as a 16-bit mono 16 kHz WAV — the format
  // whisper.cpp expects.
  async function blobToWavBase64(blob) {
    const arrayBuffer = await blob.arrayBuffer();

    // Decode compressed audio to raw PCM
    const audioCtx = new AudioContext({ sampleRate: 16000 });
    let audioBuffer;
    try {
      audioBuffer = await audioCtx.decodeAudioData(arrayBuffer);
    } finally {
      audioCtx.close();
    }

    // Mix down to mono at 16 kHz (whisper works best with this)
    const numChannels = audioBuffer.numberOfChannels;
    const length = audioBuffer.length;
    const pcm = new Float32Array(length);

    for (let ch = 0; ch < numChannels; ch++) {
      const channelData = audioBuffer.getChannelData(ch);
      for (let i = 0; i < length; i++) {
        pcm[i] += channelData[i] / numChannels;
      }
    }

    // Encode as 16-bit PCM WAV
    const wavBuffer = encodeWav(pcm, 16000);

    // Convert ArrayBuffer → base64
    const bytes = new Uint8Array(wavBuffer);
    let binary = "";
    for (let i = 0; i < bytes.length; i++) {
      binary += String.fromCharCode(bytes[i]);
    }
    return btoa(binary);
  }

  // ─── PCM float32 → WAV ArrayBuffer ──────────────────────────────────────────
  function encodeWav(samples, sampleRate) {
    const bitsPerSample = 16;
    const numChannels = 1;
    const byteRate = (sampleRate * numChannels * bitsPerSample) / 8;
    const blockAlign = (numChannels * bitsPerSample) / 8;
    const dataSize = samples.length * blockAlign;
    const buffer = new ArrayBuffer(44 + dataSize);
    const view = new DataView(buffer);

    function writeStr(offset, str) {
      for (let i = 0; i < str.length; i++)
        view.setUint8(offset + i, str.charCodeAt(i));
    }

    writeStr(0, "RIFF");
    view.setUint32(4, 36 + dataSize, true);
    writeStr(8, "WAVE");
    writeStr(12, "fmt ");
    view.setUint32(16, 16, true);          // PCM chunk size
    view.setUint16(20, 1, true);           // PCM format
    view.setUint16(22, numChannels, true);
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, byteRate, true);
    view.setUint16(32, blockAlign, true);
    view.setUint16(34, bitsPerSample, true);
    writeStr(36, "data");
    view.setUint32(40, dataSize, true);

    // Convert float32 [-1, 1] → int16
    let offset = 44;
    for (let i = 0; i < samples.length; i++) {
      const s = Math.max(-1, Math.min(1, samples[i]));
      view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7fff, true);
      offset += 2;
    }

    return buffer;
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
