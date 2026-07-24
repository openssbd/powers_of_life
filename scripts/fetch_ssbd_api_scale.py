#!/usr/bin/env python3
"""Look up X/Y/Z/T scale metadata for each dataset in scale.csv from the SSBD
metadata REST APIs (v1, v2, v3 -- see https://ssbd.riken.jp/{v1,v2,v3}/api/v1/swagger-ui/)
and write the parsed numeric value + unit for each axis to ssbd_api_scale.csv.

v1's /Dataset/ exposes a combined "xyz_scale_text" ("XY: 0.24 micrometer/pixel,
Z: 0.252 micrometer/slice") plus "t_scale_text". v2 and v3's /ImageDataset/
expose separate x_scale_text/y_scale_text/z_scale_text/t_scale_text. All are
free-text, so values are extracted with a permissive regex rather than a
strict format.

Datasets are looked up by (Project Name, Dataset) from
bff-ssbd-database-omezarr04.csv, trying v1 then v2 then v3 in turn (older
projects tend to live in v1, newer ones in v2/v3) and keeping the first hit
that actually has parseable scale text.

Usage:
    python3 fetch_ssbd_api_scale.py [--scale-csv scale.csv] [--out ssbd_api_scale.csv]
"""

import argparse
import csv
import json
import re
import sys
import time
import unicodedata
import urllib.error
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path

BASE_DIR = Path(__file__).parent
BFF_CSV = BASE_DIR / "bff-ssbd-database-omezarr04.csv"

LENGTH_UNITS = {
    "nanometer": ("micrometer", 0.001),
    "nm": ("micrometer", 0.001),
    "micrometer": ("micrometer", 1.0),
    "micron": ("micrometer", 1.0),
    "um": ("micrometer", 1.0),
    "millimeter": ("micrometer", 1000.0),
    "mm": ("micrometer", 1000.0),
    "meter": ("micrometer", 1_000_000.0),
}

TIME_UNITS = {
    "ms": ("second", 0.001),
    "millisecond": ("second", 0.001),
    "s": ("second", 1.0),
    "sec": ("second", 1.0),
    "second": ("second", 1.0),
    "min": ("second", 60.0),
    "minute": ("second", 60.0),
    "mins": ("second", 60.0),
    "minutes": ("second", 60.0),
    "minutess": ("second", 60.0),  # observed typo in the source data
    "hour": ("second", 3600.0),
    "hr": ("second", 3600.0),
}

NUM_RE = r"([-+]?\d*\.?\d+)"


def normalize_text(s):
    if not s:
        return ""
    return unicodedata.normalize("NFKC", s).strip()


def parse_length(text):
    """Return (value_in_original_unit, unit_word, value_in_micrometer) or None."""
    text = normalize_text(text)
    if not text or text.upper() == "NA":
        return None
    if "^{-1}" in text or "^-1" in text:
        return None  # reciprocal-space unit (e.g. diffraction data), not a real-space scale
    m = re.search(NUM_RE + r"\s*(nanometer|micrometer|millimeter|micron|nm|um|mm)\b", text, re.IGNORECASE)
    if not m:
        return None
    value = float(m.group(1))
    unit_raw = m.group(2).lower()
    _, factor = LENGTH_UNITS[unit_raw]
    return value, unit_raw, value * factor


def parse_time(text):
    text = normalize_text(text)
    if not text or text.upper() == "NA":
        return None
    m = re.search(NUM_RE + r"\s*(milliseconds?|ms|seconds?|secs?|s|minutess?|minutes?|mins?|hours?|hrs?)\b", text, re.IGNORECASE)
    if not m:
        return None
    value = float(m.group(1))
    unit_key = m.group(2).lower()
    if unit_key not in TIME_UNITS:
        unit_key = unit_key.rstrip("s")
    if unit_key not in TIME_UNITS:
        return None
    _, factor = TIME_UNITS[unit_key]
    return value, unit_key, value * factor


def parse_xyz_scale_text(text):
    """v1's combined 'XY: 0.24 micrometer/pixel, Z: 0.252 micrometer/slice'."""
    text = normalize_text(text)
    xy_match = re.search(r"XY:\s*([^,]*)", text, re.IGNORECASE)
    z_match = re.search(r"Z:\s*(.*)", text, re.IGNORECASE)
    xy = parse_length(xy_match.group(1)) if xy_match else None
    z = parse_length(z_match.group(1)) if z_match else None
    return xy, z


def http_get_json(url, timeout=20):
    req = urllib.request.Request(url, headers={"User-Agent": "ssbd-scale-lookup/1.0"})
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return json.loads(resp.read().decode("utf-8"))


def query_v1(project_name, dataset_name):
    url = (
        "https://ssbd.riken.jp/v1/api/v1/Dataset/"
        f"?project__name={urllib.parse.quote(project_name)}&name={urllib.parse.quote(dataset_name)}"
    )
    data = http_get_json(url)
    results = data.get("results", [])
    if not results:
        return None
    # Prefer the "Image data" row over a "Quantitative data" sibling with the same name.
    results.sort(key=lambda r: 0 if r.get("kind") == "Image data" else 1)
    r = results[0]
    xy, z = parse_xyz_scale_text(r.get("xyz_scale_text") or "")
    t = parse_time(r.get("t_scale_text") or "")
    return {
        "source": "v1",
        "x": xy, "y": xy, "z": z, "t": t,
        "raw_x": r.get("xyz_scale_text") or "", "raw_y": r.get("xyz_scale_text") or "",
        "raw_z": r.get("xyz_scale_text") or "", "raw_t": r.get("t_scale_text") or "",
    }


def query_v2_v3(version, project_name, dataset_name):
    url = (
        f"https://ssbd.riken.jp/{version}/api/v1/ImageDataset/"
        f"?project__project_id={urllib.parse.quote(project_name)}&dataset_id={urllib.parse.quote(dataset_name)}"
    )
    data = http_get_json(url)
    results = data.get("results", [])
    if not results:
        return None
    r = results[0]
    return {
        "source": version,
        "x": parse_length(r.get("x_scale_text") or ""),
        "y": parse_length(r.get("y_scale_text") or ""),
        "z": parse_length(r.get("z_scale_text") or ""),
        "t": parse_time(r.get("t_scale_text") or ""),
        "raw_x": r.get("x_scale_text") or "", "raw_y": r.get("y_scale_text") or "",
        "raw_z": r.get("z_scale_text") or "", "raw_t": r.get("t_scale_text") or "",
    }


def lookup(project_name, dataset_name):
    for fn in (
        lambda: query_v1(project_name, dataset_name),
        lambda: query_v2_v3("v2", project_name, dataset_name),
        lambda: query_v2_v3("v3", project_name, dataset_name),
    ):
        try:
            result = fn()
        except (urllib.error.URLError, TimeoutError, json.JSONDecodeError) as e:
            print(f"  [warn] {project_name}/{dataset_name}: {e}", file=sys.stderr)
            result = None
        if result and (result["x"] or result["y"] or result["z"] or result["t"]):
            return result
    return None


def load_project_lookup():
    lookup_map = {}
    with open(BFF_CSV, newline="", encoding="utf-8") as f:
        for r in csv.DictReader(f):
            lookup_map[(r["SSBD:database ID"], r["Dataset"])] = r["Project Name"]
    return lookup_map


def process_row(row, project_lookup):
    ssbd_id, dataset = row["ssbd_id"], row["dataset"]
    project_name = project_lookup.get((ssbd_id, dataset))
    out = {
        "ssbd_id": ssbd_id,
        "dataset": dataset,
        "project_name": project_name or "",
        "source": "",
        "x_value": "", "x_unit": "", "x_um": "",
        "y_value": "", "y_unit": "", "y_um": "",
        "z_value": "", "z_unit": "", "z_um": "",
        "t_value": "", "t_unit": "", "t_sec": "",
        "raw_x_text": "", "raw_y_text": "", "raw_z_text": "", "raw_t_text": "",
    }
    if not project_name:
        out["source"] = "no_project_match"
        return out

    result = lookup(project_name, dataset)
    if not result:
        out["source"] = "not_found"
        return out

    out["source"] = result["source"]
    for axis in ("x", "y", "z"):
        parsed = result[axis]
        if parsed:
            value, unit, um = parsed
            out[f"{axis}_value"], out[f"{axis}_unit"], out[f"{axis}_um"] = value, unit, um
        out[f"raw_{axis}_text"] = result[f"raw_{axis}"]
    if result["t"]:
        value, unit, sec = result["t"]
        out["t_value"], out["t_unit"], out["t_sec"] = value, unit, sec
    out["raw_t_text"] = result["raw_t"]
    return out


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--scale-csv", default=str(BASE_DIR / "scale.csv"))
    parser.add_argument("--out", default=str(BASE_DIR / "ssbd_api_scale.csv"))
    parser.add_argument("--workers", type=int, default=8)
    args = parser.parse_args()

    with open(args.scale_csv, newline="", encoding="utf-8") as f:
        rows = list(csv.DictReader(f))

    project_lookup = load_project_lookup()

    results = [None] * len(rows)
    with ThreadPoolExecutor(max_workers=args.workers) as ex:
        futures = {ex.submit(process_row, row, project_lookup): i for i, row in enumerate(rows)}
        done = 0
        for fut in as_completed(futures):
            i = futures[fut]
            results[i] = fut.result()
            done += 1
            if done % 20 == 0 or done == len(rows):
                print(f"...{done}/{len(rows)}", file=sys.stderr)

    header = [
        "ssbd_id", "dataset", "project_name", "source",
        "x_value", "x_unit", "x_um",
        "y_value", "y_unit", "y_um",
        "z_value", "z_unit", "z_um",
        "t_value", "t_unit", "t_sec",
        "raw_x_text", "raw_y_text", "raw_z_text", "raw_t_text",
    ]
    with open(args.out, "w", newline="", encoding="utf-8") as f:
        writer = csv.DictWriter(f, fieldnames=header)
        writer.writeheader()
        for r in results:
            writer.writerow(r)

    from collections import Counter
    counts = Counter(r["source"] for r in results)
    print(f"Wrote {len(results)} rows to {args.out}", file=sys.stderr)
    print("Source breakdown:", dict(counts), file=sys.stderr)


if __name__ == "__main__":
    main()
