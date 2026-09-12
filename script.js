// script.js — POD Studio frontend (no API keys here, ever).
// Talks only to our own Netlify Function: /.netlify/functions/generate

const promptEl = document.getElementById("prompt");
const widthEl = document.getElementById("width");
const heightEl = document.getElementById("height");
const refEl = document.getElementById("reference");
const refWrap = document.getElementById("refPreviewWrap");
const refPreview = document.getElementById("refPreview");
const clearRefBtn = document.getElementById("clearRef");
const charCount = document.getElementById("charCount");

const btn = document.getElementById("generateBtn");
const btnText = btn.querySelector(".btn-text");
const spinner = btn.querySelector(".spinner");
const statusEl = document.getElementById("status");

const placeholder = document.getElementById("placeholder");
const resultImg = document.getElementById("resultImg");
const downloadBtn = document.getElementById("downloadBtn");
const openFullBtn = document.getElementById("openFull");
const metaEl = document.getElementById("meta");

const ENDPOINT = "/.netlify/functions/generate";
let referenceDataUrl = null;
let statusTimer = null;

// ---------- Batch mode state ----------
const MAX_BATCH = 20;
let batchPrompts = [];
let batchResults = [];
let batchIndex = 0;
let batchCancelled = false;

const modeSingleBtn = document.getElementById("modeSingleBtn");
const modeBatchBtn = document.getElementById("modeBatchBtn");
const singleMode = document.getElementById("singleMode");
const batchMode = document.getElementById("batchMode");
const singleOutput = document.getElementById("singleOutput");
const batchOutput = document.getElementById("batchOutput");
const csvFileEl = document.getElementById("csvFile");
const batchTextEl = document.getElementById("batchText");
const promptListWrap = document.getElementById("promptListWrap");
const promptListEl = document.getElementById("promptList");
const promptCountEl = document.getElementById("promptCount");
const batchBtn = document.getElementById("batchBtn");
const batchBtnText = batchBtn.querySelector(".btn-text");
const batchSpinner = batchBtn.querySelector(".spinner");
const batchStopBtn = document.getElementById("batchStopBtn");
const batchProgressWrap = document.getElementById("batchProgressWrap");
const batchProgress = document.getElementById("batchProgress");
const batchProgressLabel = document.getElementById("batchProgressLabel");
const batchStatusEl = document.getElementById("batchStatus");
const downloadAllBtn = document.getElementById("downloadAllBtn");
const downloadZipBtn = document.getElementById("downloadZipBtn");
const slideTrack = document.getElementById("slideTrack");
const slideViewport = document.getElementById("slideViewport");
const slidePrev = document.getElementById("slidePrev");
const slideNext = document.getElementById("slideNext");
const slideCounter = document.getElementById("slideCounter");
const slideDots = document.getElementById("slideDots");
const slideCaption = document.getElementById("slideCaption");
const slideDownload = document.getElementById("slideDownload");

function setMode(mode) {
  const single = mode === "single";
  singleMode.classList.toggle("hidden", !single);
  batchMode.classList.toggle("hidden", single);
  singleOutput.classList.toggle("hidden", !single);
  batchOutput.classList.toggle("hidden", single);
  modeSingleBtn.classList.toggle("active", single);
  modeBatchBtn.classList.toggle("active", !single);
  modeSingleBtn.setAttribute("aria-selected", String(single));
  modeBatchBtn.setAttribute("aria-selected", String(!single));
  if (!single) {
    // Carry current single size over as the batch default (one way, on entry).
    const bw = document.getElementById("batchWidth");
    const bh = document.getElementById("batchHeight");
    if (bw && !bw.dataset.touched) bw.value = widthEl.value;
    if (bh && !bh.dataset.touched) bh.value = heightEl.value;
  }
}

modeSingleBtn.addEventListener("click", () => setMode("single"));
modeBatchBtn.addEventListener("click", () => setMode("batch"));

// ---------- Style presets (appended to the prompt, both modes) ----------
const STYLE_SUFFIXES = {
  none: "",
  minimalist: ", minimalist style, clean simple shapes, flat colors, lots of negative space",
  vintage: ", vintage distressed look, muted aged colors, retro texture",
  retro: ", retro 70s style, bold curves, warm saturated colors",
  typography: ", typography-driven design, bold decorative lettering as the hero",
  watercolor: ", soft watercolor painting style, gentle color washes, artistic texture",
  abstract: ", abstract geometric composition, modern art shapes",
  graphic: ", bold vector graphic style, crisp lines, high contrast",
  whimsical: ", whimsical playful cartoon style, cute and fun",
};

function styleSuffix(value) {
  return STYLE_SUFFIXES[value] || "";
}

promptEl.addEventListener("input", () => {
  charCount.textContent = String(promptEl.value.length);
});

document.querySelectorAll(".presets button").forEach((b) => {
  b.addEventListener("click", () => {
    widthEl.value = b.dataset.w;
    heightEl.value = b.dataset.h;
  });
});

refEl.addEventListener("change", () => {
  const file = refEl.files && refEl.files[0];
  if (!file) return;
  if (file.size > 4 * 1024 * 1024) {
    setStatus("Reference image must be under 4MB.", "error");
    refEl.value = "";
    return;
  }
  const reader = new FileReader();
  reader.onload = () => {
    referenceDataUrl = reader.result; // data URL, sent to backend (never an API key)
    refPreview.src = referenceDataUrl;
    refWrap.classList.remove("hidden");
    setStatus("Reference image attached.", "success");
  };
  reader.readAsDataURL(file);
});

clearRefBtn.addEventListener("click", () => {
  referenceDataUrl = null;
  refEl.value = "";
  refWrap.classList.add("hidden");
});

openFullBtn.addEventListener("click", () => {
  if (resultImg.src) window.open(resultImg.src, "_blank", "noopener");
});

btn.addEventListener("click", async () => {
  const promptRaw = promptEl.value.trim();
  if (!promptRaw) {
    setStatus("Please enter a text prompt first.", "error");
    promptEl.focus();
    return;
  }

  const width = clampInt(widthEl.value, 256, 2048, 1024);
  const height = clampInt(heightEl.value, 256, 2048, 1024);
  widthEl.value = width;
  heightEl.value = height;
  const prompt = promptRaw + styleSuffix(document.getElementById("style").value);

  setLoading(true);
  hideResult();
  animateStatus([
    "Warming up FLUX.1-schnell…",
    "Generating base image (1–4 diffusion steps)…",
    "Sending output to RMBG-1.4 for background removal…",
    "Compositing transparent PNG…",
  ]);

  try {
    const res = await fetch(ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt, width, height, referenceImage: referenceDataUrl }),
    });

    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `Server error (${res.status})`);
    if (!data.image) throw new Error("Server returned no image.");

    stopStatusAnim();
    resultImg.src = data.image;
    resultImg.classList.remove("hidden");
    placeholder.classList.add("hidden");

    downloadBtn.href = data.image;
    downloadBtn.download = `pod-design-${width}x${height}.png`;
    downloadBtn.classList.remove("hidden");
    openFullBtn.classList.remove("hidden");

    metaEl.textContent = `Size: ${data.width || width}×${data.height || height}px · PNG with alpha${data.warning ? " · " + data.warning : ""}`;
    setStatus(data.warning || "Design ready — transparent PNG generated.", data.warning ? "error" : "success");
  } catch (err) {
    stopStatusAnim();
    setStatus(`Failed: ${err.message}`, "error");
  } finally {
    setLoading(false);
  }
});

function clampInt(v, min, max, fallback) {
  let n = parseInt(v, 10);
  if (Number.isNaN(n)) return fallback;
  n = Math.round(n / 16) * 16; // snap to 16 (FLUX requirement)
  return Math.min(max, Math.max(min, n));
}

function setLoading(on) {
  btn.disabled = on;
  spinner.classList.toggle("hidden", !on);
  btnText.textContent = on ? "Generating…" : "✦ Generate Design";
}

function setStatus(msg, kind) {
  statusEl.textContent = msg;
  statusEl.className = "status" + (kind ? " " + kind : "");
}

function animateStatus(steps) {
  let i = 0;
  setStatus(steps[0], "");
  statusTimer = setInterval(() => {
    i = (i + 1) % steps.length;
    setStatus(steps[i] + (i === steps.length - 1 ? " (this can take ~30s)" : ""), "");
  }, 6000);
}

function stopStatusAnim() {
  if (statusTimer) clearInterval(statusTimer);
  statusTimer = null;
}

function hideResult() {
  resultImg.classList.add("hidden");
  resultImg.removeAttribute("src");
  downloadBtn.classList.add("hidden");
  openFullBtn.classList.add("hidden");
  placeholder.classList.remove("hidden");
  metaEl.textContent = "";
}

// ---------- Batch: parse, queue, generate, carousel ----------

// Accepts prompts separated by blank lines (also tolerates one-per-line
// and surrounding CSV quotes). Blank-line split wins when present.
function parsePrompts(text) {
  const normalized = String(text || "").replace(/\r\n?/g, "\n");
  let chunks = normalized.split(/\n\s*\n+/).map((s) => s.trim()).filter(Boolean);
  if (chunks.length <= 1) {
    const lines = normalized.split("\n").map((s) => s.trim()).filter(Boolean);
    if (lines.length > 1) chunks = lines;
  }
  return chunks
    .map((s) => s.replace(/^"+|"+$/g, "").trim())
    .filter(Boolean)
    .slice(0, MAX_BATCH);
}

function renderBatchList() {
  promptCountEl.textContent = String(batchPrompts.length);
  promptListWrap.classList.toggle("hidden", batchPrompts.length === 0);
  promptListEl.innerHTML = "";
  batchPrompts.forEach((p, i) => {
    const li = document.createElement("li");
    const span = document.createElement("span");
    span.textContent = p.length > 120 ? p.slice(0, 120) + "…" : p;
    span.title = p;
    const rm = document.createElement("button");
    rm.type = "button";
    rm.className = "ghost-btn mini";
    rm.textContent = "✕";
    rm.setAttribute("aria-label", `Remove prompt ${i + 1}`);
    rm.addEventListener("click", () => {
      batchPrompts.splice(i, 1);
      syncBatchText();
      renderBatchList();
    });
    li.append(span, rm);
    promptListEl.appendChild(li);
  });
}

function syncBatchText() {
  batchTextEl.value = batchPrompts.join("\n\n");
}

function setBatchStatus(msg, kind) {
  batchStatusEl.textContent = msg;
  batchStatusEl.className = "status" + (kind ? " " + kind : "");
}

function setBatchLoading(on, label) {
  batchBtn.disabled = on;
  batchSpinner.classList.toggle("hidden", !on);
  batchBtnText.textContent = label || (on ? "Generating batch…" : "⚡ Generate Batch");
  batchStopBtn.classList.toggle("hidden", !on);
}

document.querySelectorAll(".batch-presets button").forEach((b) => {
  b.addEventListener("click", () => {
    const bw = document.getElementById("batchWidth");
    const bh = document.getElementById("batchHeight");
    bw.value = b.dataset.w;
    bh.value = b.dataset.h;
    bw.dataset.touched = "1";
    bh.dataset.touched = "1";
  });
});
["batchWidth", "batchHeight"].forEach((id) => {
  document.getElementById(id).addEventListener("input", (e) => {
    e.target.dataset.touched = "1";
  });
});

csvFileEl.addEventListener("change", () => {
  const file = csvFileEl.files && csvFileEl.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    batchPrompts = parsePrompts(reader.result);
    syncBatchText();
    renderBatchList();
    setBatchStatus(
      batchPrompts.length ? `${batchPrompts.length} prompt(s) loaded from file.` : "No prompts found — use blank lines between prompts.",
      batchPrompts.length ? "success" : "error"
    );
  };
  reader.readAsText(file);
});

batchTextEl.addEventListener("input", () => {
  batchPrompts = parsePrompts(batchTextEl.value);
  renderBatchList();
});

batchStopBtn.addEventListener("click", () => {
  batchCancelled = true;
  setBatchStatus("Stopping after current design…", "");
});

batchBtn.addEventListener("click", async () => {
  if (!batchPrompts.length) {
    setBatchStatus("Load a CSV/TXT file or paste prompts first.", "error");
    return;
  }
  const width = clampInt(document.getElementById("batchWidth").value, 256, 2048, 1024);
  const height = clampInt(document.getElementById("batchHeight").value, 256, 2048, 1024);
  document.getElementById("batchWidth").value = width;
  document.getElementById("batchHeight").value = height;
  const batchStyleSuffix = styleSuffix(document.getElementById("batchStyle").value);

  batchCancelled = false;
  batchResults = [];
  batchIndex = 0;
  setBatchLoading(true);
  batchProgressWrap.classList.remove("hidden");
  downloadAllBtn.classList.add("hidden");
  downloadZipBtn.classList.add("hidden");
  renderCarousel();

  let done = 0;
  let failed = 0;
  for (let i = 0; i < batchPrompts.length; i++) {
    if (batchCancelled) break;
    const prompt = batchPrompts[i] + batchStyleSuffix;
    setBatchStatus(`Design ${i + 1}/${batchPrompts.length}: generating…`, "");
    batchProgressLabel.textContent = `${i}/${batchPrompts.length}`;
    try {
      const res = await fetch(ENDPOINT, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt, width, height, referenceImage: referenceDataUrl }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || `Server error (${res.status})`);
      if (!data.image) throw new Error("Server returned no image.");
      batchResults.push({ prompt, image: data.image, error: null });
      done++;
    } catch (err) {
      batchResults.push({ prompt, image: null, error: err.message });
      failed++;
    }
    batchIndex = batchResults.length - 1;
    renderCarousel();
    batchProgress.style.width = `${Math.round(((i + 1) / batchPrompts.length) * 100)}%`;
    batchProgressLabel.textContent = `${i + 1} / ${batchPrompts.length}`;
  }

  setBatchLoading(false);
  const okCount = batchResults.filter((r) => r.image).length;
  downloadAllBtn.classList.toggle("hidden", okCount === 0);
  downloadZipBtn.classList.toggle("hidden", okCount === 0);
  setBatchStatus(
    batchCancelled
      ? `Stopped. ${done} ok, ${failed} failed.`
      : `Batch done: ${done} ok, ${failed} failed. Swipe through results below.`,
    failed && done ? "" : failed ? "error" : "success"
  );
});

downloadAllBtn.addEventListener("click", () => {
  const ok = batchResults.filter((r) => r.image);
  if (!ok.length) return;
  setBatchStatus(`Downloading ${ok.length} PNG(s)…`, "");
  ok.forEach((r, i) => {
    setTimeout(() => {
      const a = document.createElement("a");
      a.href = r.image;
      a.download = `pod-batch-${String(i + 1).padStart(2, "0")}.png`;
      document.body.appendChild(a);
      a.click();
      a.remove();
    }, i * 700);
  });
});

// ---------- Carousel (arrows + dots + swipe, batch only) ----------
function renderCarousel() {
  slideTrack.innerHTML = "";
  slideDots.innerHTML = "";
  if (!batchResults.length) {
    slideTrack.innerHTML = `<div class="placeholder"><span class="ph-icon">🎞️</span><p>Batch results will slide here</p><small>Swipe or use arrows</small></div>`;
    slideCounter.textContent = "0 / 0";
    slideCaption.textContent = "";
    slideDownload.classList.add("hidden");
    return;
  }
  batchResults.forEach((r, i) => {
    const slide = document.createElement("div");
    slide.className = "slide";
    if (r.image) {
      const img = document.createElement("img");
      img.src = r.image;
      img.alt = `Batch design ${i + 1}: ${r.prompt.slice(0, 80)}`;
      img.draggable = false;
      slide.appendChild(img);
    } else {
      const err = document.createElement("div");
      err.className = "slide-error";
      err.textContent = `Failed: ${r.error || "unknown error"}`;
      slide.appendChild(err);
    }
    slideTrack.appendChild(slide);

    const dot = document.createElement("button");
    dot.type = "button";
    dot.className = "dot" + (i === batchIndex ? " active" : "");
    dot.setAttribute("aria-label", `Go to design ${i + 1}`);
    dot.addEventListener("click", () => showSlide(i));
    slideDots.appendChild(dot);
  });
  showSlide(Math.min(batchIndex, batchResults.length - 1));
}

function showSlide(i) {
  if (!batchResults.length) return;
  batchIndex = (i + batchResults.length) % batchResults.length;
  slideTrack.style.transform = `translateX(-${batchIndex * 100}%)`;
  slideCounter.textContent = `${batchIndex + 1} / ${batchResults.length}`;
  [...slideDots.children].forEach((d, di) => d.classList.toggle("active", di === batchIndex));
  const r = batchResults[batchIndex];
  slideCaption.textContent = r ? `#${batchIndex + 1}: ${r.prompt}` : "";
  if (r && r.image) {
    slideDownload.href = r.image;
    slideDownload.download = `pod-batch-${String(batchIndex + 1).padStart(2, "0")}.png`;
    slideDownload.classList.remove("hidden");
  } else {
    slideDownload.classList.add("hidden");
  }
}

slidePrev.addEventListener("click", () => showSlide(batchIndex - 1));
slideNext.addEventListener("click", () => showSlide(batchIndex + 1));
document.addEventListener("keydown", (e) => {
  if (batchMode.classList.contains("hidden")) return;
  if (e.key === "ArrowLeft") showSlide(batchIndex - 1);
  if (e.key === "ArrowRight") showSlide(batchIndex + 1);
});

// Touch swipe + mouse drag
let dragStartX = null;
slideViewport.addEventListener("touchstart", (e) => {
  dragStartX = e.touches[0].clientX;
}, { passive: true });
slideViewport.addEventListener("touchend", (e) => {
  if (dragStartX === null) return;
  const dx = e.changedTouches[0].clientX - dragStartX;
  if (Math.abs(dx) > 40) showSlide(batchIndex + (dx < 0 ? 1 : -1));
  dragStartX = null;
}, { passive: true });
slideViewport.addEventListener("mousedown", (e) => { dragStartX = e.clientX; });
slideViewport.addEventListener("mouseup", (e) => {
  if (dragStartX === null) return;
  const dx = e.clientX - dragStartX;
  if (Math.abs(dx) > 40) showSlide(batchIndex + (dx < 0 ? 1 : -1));
  dragStartX = null;
});

downloadZipBtn.addEventListener("click", async () => {
  const ok = batchResults.filter((r) => r.image);
  if (!ok.length) return;
  if (typeof JSZip === "undefined") {
    setBatchStatus("ZIP library not loaded (offline?). Use Download All instead.", "error");
    return;
  }
  setBatchStatus(`Zipping ${ok.length} PNG(s)…`, "");
  try {
    const zip = new JSZip();
    ok.forEach((r, i) => {
      const base64 = r.image.split(",")[1];
      zip.file(`pod-batch-${String(i + 1).padStart(2, "0")}.png`, base64, { base64: true });
    });
    const blob = await zip.generateAsync({ type: "blob" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "pod-batch-designs.zip";
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
    setBatchStatus(`Zipped ${ok.length} PNG(s).`, "success");
  } catch (err) {
    setBatchStatus(`ZIP failed: ${err.message}. Use Download All instead.`, "error");
  }
});
