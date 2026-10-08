const SLIDER_MAX = 1000;

const track = document.getElementById("track");
const fillEl = document.getElementById("fill");
const thumbEl = document.getElementById("thumb");
const stepUpBtn = document.getElementById("stepUp");
const stepDownBtn = document.getElementById("stepDown");
const targetWidthLabel = document.getElementById("targetWidthLabel");
const viewport = document.getElementById("viewport");
const metaEl = document.getElementById("meta");
const scaleBar = document.getElementById("scaleBar");
const scaleBarLabel = document.getElementById("scaleBarLabel");
const currentPosEl = document.getElementById("currentPos");
const totalCountEl = document.getElementById("totalCount");
const loadingOverlay = document.getElementById("loadingOverlay");
const scaleTicksEl = document.getElementById("scaleTicks");

// Datasets whose widths differ by less than this (natural log) share one
// zoom stop and are told apart only by the step buttons.
const TIE = 0.02;
// Between two neighboring stops, the crossfade happens over the middle part
// of the zoom; near either stop only that stop's image is visible.
const FADE_START = 0.2;
const FADE_END = 0.8;
// Fraction of the remaining distance to the target covered each frame, so
// jumps glide instead of snapping.
const EASE = 0.12;

let data = [];
let logMin = 0;
let logMax = 1;
let targetLog = 0;  // natural log of the field-of-view width (µm) we're heading to
let shownLog = 0;   // natural log of the width currently drawn
let stops = [];      // [{ log, members: [data indices] }], ascending
let pinnedIndex = -1; // dataset picked by the step buttons among tied widths
let currentIndex = -1;
let animating = false;
const imageEls = new Map(); // data index -> element, created lazily

function humanizeLength(um) {
  if (um < 1000) return `${um.toFixed(1)} µm`;
  if (um < 1_000_000) return `${(um / 1000).toFixed(2)} mm`;
  return `${(um / 1_000_000).toFixed(3)} m`;
}

function trimNum(n) {
  return parseFloat(n.toPrecision(6)).toString();
}

function formatTick(um) {
  if (um < 1000) return `${trimNum(um)} µm`;
  if (um < 1_000_000) return `${trimNum(um / 1000)} mm`;
  return `${trimNum(um / 1_000_000)} m`;
}

function logToValue(l) {
  return ((l - logMin) / (logMax - logMin)) * SLIDER_MAX;
}

function valueToLog(v) {
  return logMin + (v / SLIDER_MAX) * (logMax - logMin);
}

// One tick per power of ten, bottom = smallest, top = largest.
function renderScaleTicks() {
  scaleTicksEl.innerHTML = "";
  const minLen = data[0].crop_length_um;
  const maxLen = data[data.length - 1].crop_length_um;
  const startExp = Math.floor(Math.log10(minLen));
  const endExp = Math.ceil(Math.log10(maxLen));
  for (let exp = startExp; exp <= endExp; exp++) {
    const value = Math.pow(10, exp);
    if (value < minLen || value > maxLen) continue;
    const tick = document.createElement("div");
    tick.className = "scale-tick";
    tick.style.bottom = `${(logToValue(Math.log(value)) / SLIDER_MAX) * 100}%`;
    const label = document.createElement("span");
    label.textContent = formatTick(value);
    tick.appendChild(label);
    scaleTicksEl.appendChild(tick);
  }
}

function escapeHtml(s) {
  const div = document.createElement("div");
  div.textContent = s ?? "";
  return div.innerHTML;
}

function buildStops() {
  stops = [];
  data.forEach((item, i) => {
    const last = stops[stops.length - 1];
    if (last && item.log - last.log < TIE) last.members.push(i);
    else stops.push({ log: item.log, members: [i] });
  });
}

// Index of the last stop at or below this log-width.
function stopBelow(l) {
  let lo = 0, hi = stops.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (stops[mid].log <= l) lo = mid; else hi = mid - 1;
  }
  return lo;
}

function stopOf(index) {
  return stopBelow(data[index].log + TIE / 2);
}

// The dataset shown for a stop: the one the step buttons picked, if it
// belongs to this stop, otherwise the first.
function representative(stop) {
  return stop.members.includes(pinnedIndex) ? pinnedIndex : stop.members[0];
}

function smoothstep(t) {
  t = Math.min(1, Math.max(0, t));
  return t * t * (3 - 2 * t);
}

function imageEl(i) {
  let el = imageEls.get(i);
  if (!el) {
    el = document.createElement("div");
    el.className = "zoom-image";
    const img = document.createElement("img");
    img.alt = data[i].dataset;
    img.src = `../thumbnails/${data[i].thumb}`;
    el.appendChild(img);
    viewport.insertBefore(el, scaleBar);
    imageEls.set(i, el);
  }
  return el;
}

function renderMeta(item) {
  const contact = [item.contact_name, item.organization].filter(Boolean).join(" · ");
  metaEl.innerHTML = `
    <div class="width">${escapeHtml(humanizeLength(item.crop_length_um))} wide</div>
    <div class="dataset-name">${escapeHtml(item.dataset)}</div>
    <div class="ssbd-id">${escapeHtml(item.ssbd_id)} · ${item.size_x}×${item.size_y}px</div>
    ${item.title ? `<div class="title">${escapeHtml(item.title)}</div>` : ""}
    ${contact ? `<div class="contact">${escapeHtml(contact)}</div>` : ""}
    ${item.license ? `<div class="license">${escapeHtml(item.license)}</div>` : ""}
  `;
  metaEl.scrollTop = 0;
  metaEl.classList.remove("fade-in");
  void metaEl.offsetWidth;
  metaEl.classList.add("fade-in");
}

// A scale bar of a round length (1, 2 or 5 × 10^n) no wider than ~30% of the
// frame, so the viewer can read the absolute size at any zoom.
function renderScaleBar(viewWidthUm) {
  const maxBar = viewWidthUm * 0.3;
  const base = Math.pow(10, Math.floor(Math.log10(maxBar)));
  const nice = [5, 2, 1].map((m) => m * base).find((v) => v <= maxBar);
  scaleBar.style.width = `${(nice / viewWidthUm) * 100}%`;
  scaleBarLabel.textContent = formatTick(nice);
}

function placeImage(i, opacity, isCurrent) {
  const scale = Math.exp(data[i].log - shownLog); // physical width / field of view
  const el = imageEl(i);
  el.style.transform = `translate(-50%, -50%) scale(${scale})`;
  el.style.setProperty("--inv-scale", 1 / scale);
  el.style.opacity = opacity;
  // The smaller image sits on top, nested at the center of the larger one.
  el.style.zIndex = String(data.length - i);
  el.classList.toggle("current", isCurrent);
}

function render() {
  const viewWidthUm = Math.exp(shownLog);
  const g = stopBelow(shownLog);
  const lower = representative(stops[g]);
  let index = lower;
  const visible = new Set([lower]);

  if (g < stops.length - 1 && shownLog > stops[g].log) {
    const upper = representative(stops[g + 1]);
    const t = (shownLog - stops[g].log) / (stops[g + 1].log - stops[g].log);
    const w = smoothstep((t - FADE_START) / (FADE_END - FADE_START));
    if (t >= 0.5) index = upper;
    placeImage(lower, 1 - w, index === lower);
    placeImage(upper, w, index === upper);
    visible.add(upper);
  } else {
    placeImage(lower, 1, true);
  }

  for (const [i, el] of imageEls) {
    if (!visible.has(i)) {
      el.remove();
      imageEls.delete(i);
    }
  }

  targetWidthLabel.textContent = humanizeLength(viewWidthUm);
  renderScaleBar(viewWidthUm);
  if (index !== currentIndex) {
    currentIndex = index;
    currentPosEl.textContent = index + 1;
    renderMeta(data[index]);
  }
}

function tick() {
  const diff = targetLog - shownLog;
  if (Math.abs(diff) < 1e-4) {
    shownLog = targetLog;
    animating = false;
  } else {
    shownLog += diff * EASE;
  }
  render();
  if (animating) requestAnimationFrame(tick);
}

function updateSliderVisual() {
  const percent = (logToValue(targetLog) / SLIDER_MAX) * 100;
  fillEl.style.height = `${percent}%`;
  thumbEl.style.bottom = `${percent}%`;
  track.setAttribute("aria-valuetext", humanizeLength(Math.exp(targetLog)));
}

function setTargetLog(l) {
  targetLog = Math.min(logMax, Math.max(logMin, l));
  updateSliderVisual();
  if (!animating) {
    animating = true;
    requestAnimationFrame(tick);
  }
}

// --- vertical slider: drag anywhere on the track, top = largest ---

function clientYToLog(clientY) {
  const rect = track.getBoundingClientRect();
  const frac = Math.min(1, Math.max(0, (rect.bottom - clientY) / rect.height));
  return valueToLog(frac * SLIDER_MAX);
}

let dragging = false;
track.addEventListener("pointerdown", (e) => {
  dragging = true;
  pinnedIndex = -1;
  track.setPointerCapture(e.pointerId);
  setTargetLog(clientYToLog(e.clientY));
});
track.addEventListener("pointermove", (e) => {
  if (dragging) setTargetLog(clientYToLog(e.clientY));
});
track.addEventListener("pointerup", () => { dragging = false; });
track.addEventListener("pointercancel", () => { dragging = false; });

// --- step buttons: one dataset at a time ---

// Within a group of tied widths this swaps the image in place, otherwise it
// glides to the next width.
function stepIndex(delta) {
  // Count from the last stepped-to dataset, so rapid steps add up even
  // before the zoom has caught up with them.
  const from = pinnedIndex !== -1 ? pinnedIndex
    : currentIndex !== -1 ? currentIndex
    : representative(stops[stopBelow(targetLog)]);
  const i = Math.min(data.length - 1, Math.max(0, from + delta));
  pinnedIndex = i;
  setTargetLog(stops[stopOf(i)].log);
}

stepUpBtn.addEventListener("click", () => stepIndex(1));
stepDownBtn.addEventListener("click", () => stepIndex(-1));

track.addEventListener("keydown", (e) => {
  if (e.key === "ArrowUp" || e.key === "ArrowRight") { stepIndex(1); e.preventDefault(); }
  if (e.key === "ArrowDown" || e.key === "ArrowLeft") { stepIndex(-1); e.preventDefault(); }
});

// --- pinch on the image: spreading fingers zooms in (smaller field of view) ---

const pointers = new Map();
let pinchStart = null; // { dist, log }

function pinchDistance() {
  const [a, b] = [...pointers.values()];
  return Math.hypot(a.x - b.x, a.y - b.y);
}

viewport.addEventListener("pointerdown", (e) => {
  viewport.setPointerCapture(e.pointerId);
  pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
  if (pointers.size === 2) {
    pinnedIndex = -1;
    pinchStart = { dist: pinchDistance(), log: targetLog };
  }
});
viewport.addEventListener("pointermove", (e) => {
  if (!pointers.has(e.pointerId)) return;
  pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
  if (pinchStart && pointers.size === 2) {
    const dist = pinchDistance();
    if (dist > 0) setTargetLog(pinchStart.log - Math.log(dist / pinchStart.dist));
  }
});
function endPointer(e) {
  pointers.delete(e.pointerId);
  if (pointers.size < 2) pinchStart = null;
}
viewport.addEventListener("pointerup", endPointer);
viewport.addEventListener("pointercancel", endPointer);

// Trackpad pinch / mouse wheel, for trying this view on a computer.
viewport.addEventListener("wheel", (e) => {
  e.preventDefault();
  pinnedIndex = -1;
  setTargetLog(targetLog + e.deltaY * 0.005);
}, { passive: false });

async function init() {
  const res = await fetch("../data.json");
  data = await res.json();
  data.sort((a, b) => a.crop_length_um - b.crop_length_um);
  for (const item of data) item.log = Math.log(item.crop_length_um);

  buildStops();
  logMin = data[0].log;
  logMax = data[data.length - 1].log;
  totalCountEl.textContent = data.length;
  renderScaleTicks();

  loadingOverlay.classList.add("hidden");
  const startLog = valueToLog(SLIDER_MAX / 2);
  shownLog = startLog;
  setTargetLog(startLog);
}

init();
