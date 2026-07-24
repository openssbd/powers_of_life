const PANEL_COUNT = 12; // 6 columns x 2 rows
const SLIDER_MAX = 1000;

const slider = document.getElementById("widthSlider");
const targetWidthLabel = document.getElementById("targetWidthLabel");
const minLabel = document.getElementById("minLabel");
const maxLabel = document.getElementById("maxLabel");
const grid = document.getElementById("grid");
const shownCountEl = document.getElementById("shownCount");
const totalCountEl = document.getElementById("totalCount");
const loadingOverlay = document.getElementById("loadingOverlay");
const scaleTicksEl = document.getElementById("scaleTicks");

let data = [];
let logMin = 0;
let logMax = 1;

function humanizeLength(um) {
  if (um < 1000) return `${um.toFixed(1)} µm`;
  if (um < 1_000_000) return `${(um / 1000).toFixed(2)} mm`;
  return `${(um / 1_000_000).toFixed(3)} m`;
}

// Slider position (0..SLIDER_MAX) maps log-linearly onto the crop-length range,
// so equal slider steps are equal *multiplicative* steps in physical length.
function sliderToLength(v) {
  const t = v / SLIDER_MAX;
  return Math.exp(logMin + t * (logMax - logMin));
}

// data is sorted ascending by crop_length_um; binary-search the insertion
// point, then expand outward picking whichever neighbor is closer in log-space.
function nearestByLength(target, n) {
  let lo = 0, hi = data.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (data[mid].crop_length_um < target) lo = mid + 1; else hi = mid;
  }
  const logTarget = Math.log(target);
  let left = lo - 1, right = lo;
  const result = [];
  while (result.length < n && (left >= 0 || right < data.length)) {
    const distLeft = left >= 0 ? Math.abs(Math.log(data[left].crop_length_um) - logTarget) : Infinity;
    const distRight = right < data.length ? Math.abs(Math.log(data[right].crop_length_um) - logTarget) : Infinity;
    if (distLeft <= distRight) {
      result.push(data[left]);
      left--;
    } else {
      result.push(data[right]);
      right++;
    }
  }
  result.sort((a, b) => a.crop_length_um - b.crop_length_um);
  return result;
}

function trimNum(n) {
  return parseFloat(n.toPrecision(6)).toString();
}

function formatTick(um) {
  if (um < 1000) return `${trimNum(um)} µm`;
  if (um < 1_000_000) return `${trimNum(um / 1000)} mm`;
  return `${trimNum(um / 1_000_000)} m`;
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
    const percent = ((Math.log(value) - logMin) / (logMax - logMin)) * 100;
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

function renderPanels(items) {
  grid.innerHTML = "";
  shownCountEl.textContent = items.length;
  for (const item of items) {
    const panel = document.createElement("div");
    panel.className = "panel";

    const thumbWrap = document.createElement("div");
    thumbWrap.className = "thumb-wrap";

    const img = document.createElement("img");
    img.loading = "lazy";
    img.alt = item.dataset;
    img.src = `thumbnails/${item.thumb}`;
    img.onload = () => img.classList.add("loaded");
    thumbWrap.appendChild(img);

    const lengthBadge = document.createElement("div");
    lengthBadge.className = "length-badge";
    lengthBadge.textContent = humanizeLength(item.crop_length_um);
    thumbWrap.appendChild(lengthBadge);

    const meta = document.createElement("div");
    meta.className = "meta";
    const contact = [item.contact_name, item.organization].filter(Boolean).join(" · ");
    meta.innerHTML = `
      <div class="dataset-name line-clamp-1">${escapeHtml(item.dataset)}</div>
      <div class="ssbd-id line-clamp-1">${escapeHtml(item.ssbd_id)} · ${item.size_x}×${item.size_y}px</div>
      ${item.title ? `<div class="title">${escapeHtml(item.title)}</div>` : ""}
      ${contact ? `<div class="contact line-clamp-1">${escapeHtml(contact)}</div>` : ""}
      ${item.license ? `<div class="license line-clamp-1">${escapeHtml(item.license)}</div>` : ""}
    `;

    panel.appendChild(thumbWrap);
    panel.appendChild(meta);
    grid.appendChild(panel);
  }
}

function update() {
  const target = sliderToLength(Number(slider.value));
  targetWidthLabel.textContent = humanizeLength(target);
  const items = nearestByLength(target, PANEL_COUNT);
  renderPanels(items);
}

let debounceTimer = null;
slider.addEventListener("input", () => {
  const target = sliderToLength(Number(slider.value));
  targetWidthLabel.textContent = humanizeLength(target);
  clearTimeout(debounceTimer);
  debounceTimer = setTimeout(update, 120);
});

async function init() {
  const res = await fetch("data.json");
  data = await res.json();
  data.sort((a, b) => a.crop_length_um - b.crop_length_um);

  logMin = Math.log(data[0].crop_length_um);
  logMax = Math.log(data[data.length - 1].crop_length_um);
  minLabel.textContent = humanizeLength(data[0].crop_length_um);
  maxLabel.textContent = humanizeLength(data[data.length - 1].crop_length_um);
  totalCountEl.textContent = data.length;
  renderScaleTicks();

  loadingOverlay.classList.add("hidden");
  update();
}

init();
