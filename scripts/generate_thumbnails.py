#!/usr/bin/env python3
"""Pre-generate square, center-cropped thumbnails for every dataset in
ssbd_omezarr_area_sorted02.csv, and record the physical side length of each
crop (in micrometers) alongside the dataset name in scale.csv.

For each dataset:
  1. Fetch the lowest-resolution level of the remote OME-Zarr array.
  2. Composite active channels into RGB using omero channel colors, with a
     per-channel percentile contrast stretch.
  3. Center-crop to a square using the shorter of the (downsampled) height/
     width in pixels.
  4. Resize to a fixed thumbnail size and save as PNG under thumbnails/.
  5. Record dataset, ssbd_id, and the crop's physical side length (computed
     from the *full-resolution* pixel size and pixel count, so it is exact
     regardless of pyramid rounding) in scale.csv.

Usage:
    python3 generate_thumbnails.py                  # full run
    python3 generate_thumbnails.py --limit 50        # quick test
    python3 generate_thumbnails.py --workers 24
"""

import argparse
import csv
import sys
import threading
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path

import numpy as np
import zarr
import fsspec
from PIL import Image

BASE_DIR = Path(__file__).parent
DEFAULT_CSV = BASE_DIR / "ssbd_omezarr_area_sorted02.csv"
DEFAULT_META_CSV = BASE_DIR / "bff-ssbd-database-omezarr04.csv"
THUMB_DIR = BASE_DIR / "thumbnails"
THUMB_SIZE = 256

print_lock = threading.Lock()


def load_metadata(meta_csv_path):
    """Map File Path -> title/license/contact metadata from the original bff CSV."""
    meta = {}
    with open(meta_csv_path, newline="", encoding="utf-8") as f:
        for r in csv.DictReader(f):
            meta[r["File Path"]] = {
                "title": r.get("Title", ""),
                "license": r.get("Dataset License", ""),
                "contact_name": r.get("Contact", ""),
                "organization": r.get("Organization", ""),
            }
    return meta


def hex_to_rgb(h):
    h = (h or "FFFFFF").strip()
    if len(h) == 6:
        try:
            return tuple(int(h[i : i + 2], 16) for i in (0, 2, 4))
        except ValueError:
            pass
    return (255, 255, 255)


MIN_LEVEL_DIM = 96  # avoid picking a pyramid level so coarse the square crop is a blur


def pick_level(g, axes, level_paths):
    """Pick the coarsest level whose shorter spatial side is still >= MIN_LEVEL_DIM,
    so extremely thin/elongated images don't get cropped down to a near-blank blur.
    Falls back to the finest level if even that isn't big enough."""
    y_i, x_i = axes.index("y"), axes.index("x")
    for path in reversed(level_paths):  # coarsest first
        shape = g[path].shape
        if min(shape[y_i], shape[x_i]) >= MIN_LEVEL_DIM:
            return path
    return level_paths[0]  # finest level as last resort


def render_lowres_rgb(file_path):
    """Fetch a pyramid level and composite active channels to RGB in [0, 1]
    float32, shape (h, w, 3)."""
    store = fsspec.get_mapper(file_path)
    g = zarr.open(store, mode="r")
    attrs = g.attrs.asdict()
    multiscales = attrs["multiscales"][0]
    axes = [a["name"] for a in multiscales["axes"]]
    level_paths = [d["path"] for d in multiscales["datasets"]]
    level_path = pick_level(g, axes, level_paths)
    arr = g[level_path]
    shape = arr.shape

    def idx_of(name):
        return axes.index(name) if name in axes else None

    t_i, c_i, z_i, y_i, x_i = (idx_of(n) for n in ("t", "c", "z", "y", "x"))

    def dim_size(i):
        return shape[i] if i is not None else 1

    omero = attrs.get("omero", {})
    rdefs = omero.get("rdefs", {})
    channels_meta = omero.get("channels", [])

    t_idx = rdefs.get("defaultT", 0) if t_i is not None else 0
    t_idx = min(t_idx, dim_size(t_i) - 1) if t_i is not None else 0

    if z_i is not None:
        z_idx = rdefs.get("defaultZ")
        if z_idx is None or z_idx >= shape[z_i]:
            z_idx = shape[z_i] // 2
    else:
        z_idx = 0

    n_channels = dim_size(c_i)
    active = [(ci, ch) for ci, ch in enumerate(channels_meta) if ci < n_channels and ch.get("active", True)]
    if not active:
        active = [(ci, {}) for ci in range(min(n_channels, 3))]

    def build_index(c_val):
        sel = [0] * len(shape)
        if t_i is not None:
            sel[t_i] = t_idx
        if c_i is not None:
            sel[c_i] = c_val
        if z_i is not None:
            sel[z_i] = z_idx
        sel[y_i] = slice(None)
        sel[x_i] = slice(None)
        return tuple(sel)

    h, w = dim_size(y_i), dim_size(x_i)
    rgb = np.zeros((h, w, 3), dtype=np.float32)

    for ci, ch in active:
        plane = np.asarray(arr[build_index(ci)], dtype=np.float32)
        lo, hi = np.percentile(plane, [1, 99.5])
        if hi <= lo:
            hi = lo + 1
        norm = np.clip((plane - lo) / (hi - lo), 0, 1)
        color = hex_to_rgb(ch.get("color"))
        for k in range(3):
            rgb[:, :, k] += norm * (color[k] / 255.0)

    return np.clip(rgb, 0, 1)


def center_crop_square(rgb):
    h, w = rgb.shape[:2]
    side = min(h, w)
    y0 = (h - side) // 2
    x0 = (w - side) // 2
    return rgb[y0 : y0 + side, x0 : x0 + side, :]


def process_row(idx, row):
    out_name = f"{idx:05d}.png"
    out_path = THUMB_DIR / out_name

    size_x = int(float(row["size_x"]))
    size_y = int(float(row["size_y"]))
    pixel_size_x = float(row["pixel_size_x"])
    crop_length_um = min(size_x, size_y) * pixel_size_x

    if not out_path.exists():
        rgb = render_lowres_rgb(row["file_path"])
        cropped = center_crop_square(rgb)
        img8 = (cropped * 255).astype(np.uint8)
        im = Image.fromarray(img8, mode="RGB")
        im = im.resize((THUMB_SIZE, THUMB_SIZE), Image.LANCZOS)
        im.save(out_path)

    return {
        "ssbd_id": row["ssbd_id"],
        "dataset": row["dataset"],
        "title": row.get("title", ""),
        "license": row.get("license", ""),
        "contact_name": row.get("contact_name", ""),
        "organization": row.get("organization", ""),
        "crop_length_um": crop_length_um,
        "size_x": size_x,
        "size_y": size_y,
        "thumbnail": out_name,
        "file_path": row["file_path"],
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--csv", default=str(DEFAULT_CSV))
    parser.add_argument("--meta-csv", default=str(DEFAULT_META_CSV))
    parser.add_argument("--out", default=str(BASE_DIR / "scale.csv"))
    parser.add_argument("--workers", type=int, default=24)
    parser.add_argument("--limit", type=int, default=None)
    args = parser.parse_args()

    THUMB_DIR.mkdir(exist_ok=True)

    with open(args.csv, newline="", encoding="utf-8") as f:
        all_rows = list(csv.DictReader(f))

    meta_lookup = load_metadata(args.meta_csv)

    # One thumbnail per SSBD:database ID (project) is enough -- keep only the
    # first row seen for each ssbd_id rather than one per sub-image/timepoint.
    seen = set()
    rows = []
    for r in all_rows:
        if r["ssbd_id"] in seen:
            continue
        seen.add(r["ssbd_id"])
        m = meta_lookup.get(r["file_path"], {})
        r["title"] = m.get("title", "")
        r["license"] = m.get("license", "")
        r["contact_name"] = m.get("contact_name", "")
        r["organization"] = m.get("organization", "")
        rows.append(r)
    print(f"{len(all_rows)} rows -> {len(rows)} unique ssbd_id", file=sys.stderr)

    if args.limit:
        rows = rows[: args.limit]

    total = len(rows)
    results = [None] * total
    errors = []
    done = 0

    with ThreadPoolExecutor(max_workers=args.workers) as ex:
        futures = {ex.submit(process_row, i, row): i for i, row in enumerate(rows)}
        for fut in as_completed(futures):
            i = futures[fut]
            try:
                results[i] = fut.result()
            except Exception as e:
                errors.append((i, rows[i].get("dataset"), str(e)))
            done += 1
            if done % 50 == 0 or done == total:
                with print_lock:
                    print(f"...{done}/{total} (errors so far: {len(errors)})", file=sys.stderr)

    ok_results = [r for r in results if r is not None]
    with open(args.out, "w", newline="", encoding="utf-8") as f:
        writer = csv.DictWriter(
            f,
            fieldnames=[
                "ssbd_id", "dataset", "title", "license", "contact_name", "organization",
                "crop_length_um", "size_x", "size_y", "thumbnail", "file_path",
            ],
        )
        writer.writeheader()
        for r in ok_results:
            writer.writerow(r)

    print(f"Wrote {len(ok_results)} rows to {args.out}", file=sys.stderr)
    if errors:
        print(f"{len(errors)} row(s) failed:", file=sys.stderr)
        for i, name, msg in errors[:30]:
            print(f"  [{i}] {name}: {msg}", file=sys.stderr)


if __name__ == "__main__":
    main()
