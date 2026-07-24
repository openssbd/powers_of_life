#!/usr/bin/env python3
"""Recompute crop_length_um in scale.csv using the SSBD-API-sourced pixel
sizes from ssbd_api_scale.csv (fetch_ssbd_api_scale.py), falling back to the
existing (.zattrs-derived) crop_length_um for datasets the API has no scale
metadata for. Adds a scale_source column recording which one was used.

Usage:
    python3 merge_api_scale.py [--scale-csv scale.csv] [--api-csv ssbd_api_scale.csv]
"""

import argparse
import csv
from pathlib import Path

BASE_DIR = Path(__file__).parent


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--scale-csv", default=str(BASE_DIR / "scale.csv"))
    parser.add_argument("--api-csv", default=str(BASE_DIR / "ssbd_api_scale.csv"))
    args = parser.parse_args()

    with open(args.scale_csv, newline="", encoding="utf-8") as f:
        rows = list(csv.DictReader(f))
        fieldnames = list(rows[0].keys())

    with open(args.api_csv, newline="", encoding="utf-8") as f:
        api_rows = {(r["ssbd_id"], r["dataset"]): r for r in csv.DictReader(f)}

    used_api = used_fallback = 0
    for row in rows:
        api = api_rows.get((row["ssbd_id"], row["dataset"]))
        size_x, size_y = float(row["size_x"]), float(row["size_y"])
        if api and api["x_um"] and api["y_um"]:
            x_um, y_um = float(api["x_um"]), float(api["y_um"])
            row["crop_length_um"] = min(size_x * x_um, size_y * y_um)
            row["scale_source"] = f"api-{api['source']}"
            used_api += 1
        else:
            row["scale_source"] = "zattrs"
            used_fallback += 1

    if "scale_source" not in fieldnames:
        fieldnames.append("scale_source")

    with open(args.scale_csv, "w", newline="", encoding="utf-8") as f:
        writer = csv.DictWriter(f, fieldnames=fieldnames)
        writer.writeheader()
        for row in rows:
            writer.writerow({k: row[k] for k in fieldnames})

    print(f"Updated {len(rows)} rows: {used_api} from SSBD API, {used_fallback} kept .zattrs-derived value")


if __name__ == "__main__":
    main()
