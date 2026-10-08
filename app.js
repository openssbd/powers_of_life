const SLIDER_MAX = 1000;

const slider = document.getElementById("widthSlider");
const targetWidthLabel = document.getElementById("targetWidthLabel");
const minLabel = document.getElementById("minLabel");
const maxLabel = document.getElementById("maxLabel");
const stage = document.getElementById("stage");
const currentPosEl = document.getElementById("currentPos");
const totalCountEl = document.getElementById("totalCount");
const loadingOverlay = document.getElementById("loadingOverlay");
const scaleTicksEl = document.getElementById("scaleTicks");

let data = [];
let logMin = 0;
let logMax = 1;
let boundaries = []; // slider-space values at the log-midpoint between consecutive items
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

// Slider value (0..SLIDER_MAX, left=min, right=max) maps log-linearly onto the
// physical crop-length range, so equal slider distance is equal
// multiplicative distance in µm.
function lengthToValue(len) {
  return ((Math.log(len) - logMin) / (logMax - logMin)) * SLIDER_MAX;
}

// Some datasets share the exact same physical length; their log-midpoint is a
// zero-width zone no slider position could land on. Enforce a minimum gap so
// every item keeps a reachable sliver of the track.
const MIN_GAP = 2;

// One divider per gap between consecutive items, at the log-midpoint
// (geometric mean) of their two physical lengths. Crossing a divider switches
// the displayed image to its neighbor.
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

// Index of the item whose zone contains this slider value -- i.e. how many
// dividers sit at or below it.
function indexForValue(value) {
  let lo = 0, hi = boundaries.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (boundaries[mid] <= value) lo = mid + 1; else hi = mid;
  }
  return lo;
}

// Draw one tick per power of ten spanned by the data range, positioned by the
// same log mapping as the slider, so the track reads like a log-scale ruler.
function renderScaleTicks() {
  scaleTicksEl.innerHTML = "";
  const minLen = data[0].crop_length_um;
  const maxLen = data[data.length - 1].crop_length_um;
  const startExp = Math.floor(Math.log10(minLen));
  const endExp = Math.ceil(Math.log10(maxLen));
  for (let exp = startExp; exp <= endExp; exp++) {
    const value = Math.pow(10, exp);
    if (value < minLen || value > maxLen) continue;
    const percent = (lengthToValue(value) / SLIDER_MAX) * 100;
    const tick = document.createElement("div");
    tick.className = "scale-tick";
    tick.style.left = `${percent}%`;
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

function buildSlide(item) {
  const slide = document.createElement("div");
  slide.className = "slide";

  const imageCol = document.createElement("div");
  imageCol.className = "image-col";

  const img = document.createElement("img");
  img.alt = item.dataset;
  img.src = `thumbnails/${item.thumb}`;
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

// direction "right" -> scale increases: current drifts off to the left and
//                      fades; next emerges from the right.
// direction "left"  -> scale decreases: current drifts off to the right; next
//                      emerges from the left.
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

  const enterClass = direction === "right" ? "pos-right" : "pos-left";
  const exitClass = direction === "right" ? "pos-left" : "pos-right";

  slide.classList.add(enterClass);
  stage.appendChild(slide);
  void slide.offsetWidth; // force reflow so the enter position applies before transitioning

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
  value = Math.min(SLIDER_MAX, Math.max(0, value));
  slider.value = value;

  const index = indexForValue(value);
  const next = data[index];
  targetWidthLabel.textContent = humanizeLength(next.crop_length_um);
  currentPosEl.textContent = index + 1;

  if (index !== currentIndex) {
    const direction = currentIndex === -1 || index > currentIndex ? "right" : "left";
    showItem(next, direction);
    currentIndex = index;
  }
}

slider.addEventListener("input", () => setValue(Number(slider.value)));

// Arrow keys step exactly one item at a time (jumping to the middle of that
// item's zone), which reliably reaches every item even where dragging can't
// land precisely on a narrow sliver.
function stepIndex(delta) {
  const newIndex = Math.min(data.length - 1, Math.max(0, currentIndex + delta));
  const lo = newIndex === 0 ? 0 : boundaries[newIndex - 1];
  const hi = newIndex === data.length - 1 ? SLIDER_MAX : boundaries[newIndex];
  setValue((lo + hi) / 2);
}

document.addEventListener("keydown", (e) => {
  if (!data.length) return;
  if (e.key === "ArrowRight" || e.key === "ArrowUp") { stepIndex(1); e.preventDefault(); }
  if (e.key === "ArrowLeft" || e.key === "ArrowDown") { stepIndex(-1); e.preventDefault(); }
});

async function init() {
  const res = await fetch("data.json");
  data = await res.json();
  data.sort((a, b) => a.crop_length_um - b.crop_length_um);

  logMin = Math.log(data[0].crop_length_um);
  logMax = Math.log(data[data.length - 1].crop_length_um);
  computeBoundaries();
  minLabel.textContent = humanizeLength(data[0].crop_length_um);
  maxLabel.textContent = humanizeLength(data[data.length - 1].crop_length_um);
  totalCountEl.textContent = data.length;
  renderScaleTicks();

  loadingOverlay.classList.add("hidden");
  setValue(SLIDER_MAX / 2);
}

init();
