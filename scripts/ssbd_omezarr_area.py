#!/usr/bin/env python3
"""List SSBD OME-Zarr datasets sorted by physical image area (largest first).

Reads bff-ssbd-database-omezarr04.csv from the openssbd/ssbd-bff repo. For each
row, fetches the OME-Zarr ".zattrs" at the "File Path" URL to get the per-pixel
physical size (from the multiscales "scale" transform for resolution level 0),
multiplies it by the pixel dimensions in the "Dimensions" column to get the
physical width/height, and reports datasets sorted by area = width * height.

Usage:
    python3 ssbd_omezarr_area.py                     # full run, print top results
    python3 ssbd_omezarr_area.py --limit 50           # quick test on first 50 rows
    python3 ssbd_omezarr_area.py --out results.csv     # write full sorted table to CSV
    python3 ssbd_omezarr_area.py --top 20              # only show the 20 largest
"""

import argparse
import concurrent.futures
import csv
import io
import json
import sys
import urllib.request

CSV_URL = (
    "https://raw.githubusercontent.com/openssbd/ssbd-bff/main/csv/"
    "bff-ssbd-database-omezarr04.csv"
)


def fetch_text(url, timeout=30):
    req = urllib.request.Request(url, headers={"User-Agent": "ssbd-omezarr-area/1.0"})
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return resp.read().decode("utf-8")


def load_rows(source):
    if source.startswith("http://") or source.startswith("https://"):
        text = fetch_text(source)
    else:
        with open(source, encoding="utf-8") as f:
            text = f.read()
    return list(csv.DictReader(io.StringIO(text)))


def parse_dimensions(dim_str):
    return [int(p.strip()) for p in dim_str.split("x")]


def get_pixel_size(file_path, timeout=30):
    """Return (scale_x, scale_y, unit) for resolution level '0' of the dataset."""
    zattrs_url = file_path.rstrip("/") + "/.zattrs"
    attrs = json.loads(fetch_text(zattrs_url, timeout=timeout))
    multiscales = attrs["multiscales"][0]
    axes = multiscales["axes"]
    dataset0 = next(d for d in multiscales["datasets"] if d["path"] == "0")
    scale = dataset0["coordinateTransformations"][0]["scale"]
    axis_names = [a["name"] for a in axes]
    x_idx = axis_names.index("x")
    y_idx = axis_names.index("y")
    unit = axes[x_idx].get("unit", "")
    return scale[x_idx], scale[y_idx], unit


def process_row(row):
    file_path = row["File Path"]
    # Dimensions column is ordered x, y, z, c, t.
    size_x, size_y = parse_dimensions(row["Dimensions"])[:2]
    try:
        pixel_x, pixel_y, unit = get_pixel_size(file_path)
    except Exception as e:
        return {"file_path": file_path, "dataset": row.get("Dataset"), "error": str(e)}

    width = pixel_x * size_x
    height = pixel_y * size_y
    return {
        "ssbd_id": row.get("SSBD:database ID"),
        "dataset": row.get("Dataset"),
        "size_x": size_x,
        "size_y": size_y,
        "pixel_size_x": pixel_x,
        "pixel_size_y": pixel_y,
        "unit": unit,
        "width": width,
        "height": height,
        "area": width * height,
        "file_path": file_path,
    }


def main():
    parser = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    parser.add_argument("--csv", default=CSV_URL, help="CSV path or URL (default: GitHub raw CSV)")
    parser.add_argument("--workers", type=int, default=16, help="parallel fetch workers")
    parser.add_argument("--limit", type=int, default=None, help="only process the first N rows")
    parser.add_argument("--top", type=int, default=None, help="only print the N largest results")
    parser.add_argument("--out", default=None, help="write the full sorted table to this CSV path")
    args = parser.parse_args()

    rows = load_rows(args.csv)
    if args.limit:
        rows = rows[: args.limit]

    results, errors = [], []
    with concurrent.futures.ThreadPoolExecutor(max_workers=args.workers) as ex:
        for i, res in enumerate(ex.map(process_row, rows), 1):
            (errors if "error" in res else results).append(res)
            if i % 200 == 0 or i == len(rows):
                print(f"...processed {i}/{len(rows)}", file=sys.stderr)

    results.sort(key=lambda r: r["area"], reverse=True)
    shown = results[: args.top] if args.top else results

    header = [
        "ssbd_id", "dataset", "size_x", "size_y",
        "pixel_size_x", "pixel_size_y", "unit",
        "width", "height", "area", "file_path",
    ]
    if args.out:
        with open(args.out, "w", newline="", encoding="utf-8") as f:
            writer = csv.DictWriter(f, fieldnames=header)
            writer.writeheader()
            for r in results:
                writer.writerow({k: r[k] for k in header})
        print(f"Wrote {len(results)} rows to {args.out}")
    else:
        for r in shown:
            print(
                f"{r['area']:.2f} {r['unit']}^2  "
                f"({r['width']:.2f} x {r['height']:.2f} {r['unit']}, "
                f"{r['size_x']} x {r['size_y']} px)  "
                f"{r['ssbd_id']}  {r['dataset']}  {r['file_path']}"
            )

    if errors:
        print(f"\n{len(errors)} row(s) failed to fetch metadata:", file=sys.stderr)
        for e in errors[:20]:
            print(f"  {e['file_path']}: {e['error']}", file=sys.stderr)


if __name__ == "__main__":
    main()
