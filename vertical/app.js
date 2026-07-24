const SLIDER_MAX = 1000;

const track = document.getElementById("vsliderTrack");
const fillEl = document.getElementById("vsliderFill");
const thumbEl = document.getElementById("vsliderThumb");
const scaleTicksEl = document.getElementById("scaleTicks");
const stage = document.getElementById("stage");
const targetReadout = document.getElementById("targetReadout");
const loadingOverlay = document.getElementById("loadingOverlay");

let data = [];
let logMin = 0;
let logMax = 1;
let boundaries = []; // slider-space values at the log-midpoint between consecutive items
let sliderValue = SLIDER_MAX / 2;
let currentIndex = -1;
let currentSlideEl = null;

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

// Slider value (0..SLIDER_MAX, bottom=min, top=max) maps log-linearly onto
// the true physical crop-length range, so the track reflects real scale --
// equal slider distance is equal multiplicative distance in µm.
function lengthToValue(len) {
  return ((Math.log(len) - logMin) / (logMax - logMin)) * SLIDER_MAX;
}

// A handful of datasets happen to share the exact same physical length (e.g.
// several 512x512 images at the same pixel size) -- their log-midpoint is the
// point itself, a zero-width zone that no slider position could ever land
// on. Enforce a minimum gap so every item keeps a real, reachable sliver of
// the track; this only ever nudges exact/near ties, real gaps are far wider.
const MIN_GAP = 2;

// One divider per gap between consecutive items, placed at the log-midpoint
// (geometric mean) of their two physical lengths. Crossing a divider is what
// switches the displayed image to the one above or below it.
function computeBoundaries() {
  boundaries = [];
  for (let i = 0; i < data.length - 1; i++) {
    const midLength = Math.sqrt(data[i].crop_length_um * data[i + 1].crop_length_um);
    boundaries.push(lengthToValue(midLength));
  }
  for (let i = 1; i < boundaries.length; i++) {
    if (boundaries[i] < boundaries[i - 1] + MIN_GAP) {
      boundaries[i] = boundaries[i - 1] + MIN_GAP;
    }
  }
}

// Index of the item whose zone (between the two dividers around it) contains
// this slider value -- i.e. how many dividers sit at or below it.
function indexForValue(value) {
  let lo = 0, hi = boundaries.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (boundaries[mid] <= value) lo = mid + 1; else hi = mid;
  }
  return lo;
}

function escapeHtml(s) {
  const div = document.createElement("div");
  div.textContent = s ?? "";
  return div.innerHTML;
}

function renderScaleTicks() {
  scaleTicksEl.innerHTML = "";
  const minLen = data[0].crop_length_um;
  const maxLen = data[data.length - 1].crop_length_um;
  const startExp = Math.floor(Math.log10(minLen));
  const endExp = Math.ceil(Math.log10(maxLen));
  for (let exp = startExp; exp <= endExp; exp++) {
    const value = Math.pow(10, exp);
    if (value < minLen || value > maxLen) continue;
    const percent = ((Math.log(value) - logMin) / (logMax - logMin)) * 100;
    const tick = document.createElement("div");
    tick.className = "scale-tick";
    tick.style.bottom = `${percent}%`;
    const label = document.createElement("span");
    label.textContent = formatTick(value);
    tick.appendChild(label);
    scaleTicksEl.appendChild(tick);
  }
}

function updateSliderVisual(value) {
  const percent = (value / SLIDER_MAX) * 100;
  fillEl.style.height = `${percent}%`;
  thumbEl.style.bottom = `${percent}%`;
}

function buildSlide(item) {
  const slide = document.createElement("div");
  slide.className = "slide";

  const imageCol = document.createElement("div");
  imageCol.className = "image-col";

  const img = document.createElement("img");
  img.alt = item.dataset;
  img.src = `../thumbnails/${item.thumb}`;
  imageCol.appendChild(img);

  const badge = document.createElement("div");
  badge.className = "length-badge";
  badge.textContent = humanizeLength(item.crop_length_um);
  imageCol.appendChild(badge);

  const metaCol = document.createElement("div");
  metaCol.className = "meta-col";
  const contact = [item.contact_name, item.organization].filter(Boolean).join(" · ");
  metaCol.innerHTML = `
    <div class="dataset-name">${escapeHtml(item.dataset)}</div>
    <div class="ssbd-id">${escapeHtml(item.ssbd_id)} · ${item.size_x}×${item.size_y}px</div>
    ${item.title ? `<div class="title">${escapeHtml(item.title)}</div>` : ""}
    ${contact ? `<div class="contact">${escapeHtml(contact)}</div>` : ""}
    ${item.license ? `<div class="license">${escapeHtml(item.license)}</div>` : ""}
  `;

  slide.appendChild(imageCol);
  slide.appendChild(metaCol);
  return slide;
}

// direction "up"   -> scale increases: current bursts out toward the viewer and
//                     vanishes past the screen; next arrives from the depths.
// direction "down" -> scale decreases: current sinks away into the depth of the
//                     screen; next arrives from close up, near the viewer.
function showItem(item, direction) {
  // Clean up any stray slides left over from a very fast drag.
  [...stage.children].forEach((el) => {
    if (el !== currentSlideEl) el.remove();
  });

  const slide = buildSlide(item);

  if (!currentSlideEl) {
    slide.classList.add("pos-center");
    stage.appendChild(slide);
    currentSlideEl = slide;
    return;
  }

  const enterClass = direction === "up" ? "pos-far" : "pos-near";
  const exitClass = direction === "up" ? "pos-near" : "pos-far";

  slide.classList.add(enterClass);
  stage.appendChild(slide);
  void slide.offsetHeight; // force reflow so the enter position applies before transitioning

  const outgoing = currentSlideEl;
  requestAnimationFrame(() => {
    slide.classList.remove(enterClass);
    slide.classList.add("pos-center");
    outgoing.classList.remove("pos-center");
    outgoing.classList.add(exitClass);
  });
  outgoing.addEventListener("transitionend", () => outgoing.remove(), { once: true });

  currentSlideEl = slide;
}

function setValue(value) {
  sliderValue = Math.min(SLIDER_MAX, Math.max(0, value));
  updateSliderVisual(sliderValue);

  const index = indexForValue(sliderValue);
  const next = data[index];
  targetReadout.textContent = humanizeLength(next.crop_length_um);

  if (index !== currentIndex) {
    const direction = currentIndex === -1 || index > currentIndex ? "up" : "down";
    showItem(next, direction);
    currentIndex = index;
  }
}

function clientYToValue(clientY) {
  const rect = track.getBoundingClientRect();
  let frac = (rect.bottom - clientY) / rect.height; // 0 at bottom (min), 1 at top (max)
  frac = Math.min(1, Math.max(0, frac));
  return frac * SLIDER_MAX;
}

let dragging = false;

function handlePointer(e) {
  setValue(clientYToValue(e.clientY));
}

track.addEventListener("pointerdown", (e) => {
  dragging = true;
  track.setPointerCapture(e.pointerId);
  handlePointer(e);
});
track.addEventListener("pointermove", (e) => {
  if (dragging) handlePointer(e);
});
track.addEventListener("pointerup", () => {
  dragging = false;
});
track.addEventListener("pointercancel", () => {
  dragging = false;
});

// Keyboard support: focus the track and use arrow keys to step exactly one
// item at a time (jumps to the middle of that item's zone), which reliably
// reaches every item even where dragging can't land precisely on a sliver.
function stepIndex(delta) {
  const newIndex = Math.min(data.length - 1, Math.max(0, currentIndex + delta));
  const lo = newIndex === 0 ? 0 : boundaries[newIndex - 1];
  const hi = newIndex === data.length - 1 ? SLIDER_MAX : boundaries[newIndex];
  setValue((lo + hi) / 2);
}

track.tabIndex = 0;
track.addEventListener("keydown", (e) => {
  if (e.key === "ArrowUp") { stepIndex(1); e.preventDefault(); }
  if (e.key === "ArrowDown") { stepIndex(-1); e.preventDefault(); }
});

async function init() {
  const res = await fetch("../data.json");
  data = await res.json();
  data.sort((a, b) => a.crop_length_um - b.crop_length_um);

  logMin = Math.log(data[0].crop_length_um);
  logMax = Math.log(data[data.length - 1].crop_length_um);
  computeBoundaries();
  renderScaleTicks();

  loadingOverlay.classList.add("hidden");
  setValue(sliderValue);
}

init();
