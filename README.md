# Powers of Life

A microscope's-eye journey through scale. Slide across the physical size
(µm, log scale) of real bioimaging datasets shared via the
[SSBD:database](https://ssbd.riken.jp/), from single molecules to whole
tissues.

Two views, sharing the same data:

- **[Horizontal view](index.html)** — a horizontal scale slider; moving it
  slides the current image/metadata off to one side while the next one
  emerges from the other.
- **[Vertical 3D view](vertical/)** — a vertical scale bar; moving it slides
  the current image/metadata away in depth (bursting toward the viewer or
  sinking into the screen) while the next one arrives.

## Data

- `data.json` — one entry per dataset: SSBD ID, dataset name, title, license,
  contact, physical crop length (µm), pixel dimensions, and thumbnail filename.
- `thumbnails/` — a square, center-cropped PNG thumbnail per dataset, rendered
  from the lowest usable resolution level of each dataset's OME-Zarr array
  (composited from active channels using their omero color/window metadata).

The physical scale used to rank datasets comes from the SSBD metadata REST
APIs ([v1](https://ssbd.riken.jp/v1/api/v1/swagger-ui/),
[v2](https://ssbd.riken.jp/v2/api/v1/swagger-ui/),
[v3](https://ssbd.riken.jp/v3/api/v1/swagger-ui/)) — specifically each
dataset's X/Y scale (µm/pixel). Datasets the API has no scale metadata for are
excluded rather than falling back to a less-authoritative estimate.

Each dataset's license (as recorded in the SSBD:database) is shown on its
card; check it before reusing an image.

## Regenerating the data

`scripts/` holds the pipeline used to build `data.json` and `thumbnails/` from
the [openssbd/ssbd-bff](https://github.com/openssbd/ssbd-bff) CSV listing:

1. `ssbd_omezarr_area.py` — lists OME-Zarr datasets from a bff CSV export by
   physical image area (fetches each dataset's `.zattrs` for pixel size).
2. `generate_thumbnails.py` — renders and center-crops one square thumbnail
   per SSBD project from its OME-Zarr array.
3. `fetch_ssbd_api_scale.py` — looks up each dataset's X/Y/Z/T scale from the
   SSBD v1/v2/v3 REST APIs.
4. `merge_api_scale.py` — recomputes the physical crop length using the
   API-sourced pixel size.

These require `zarr`, `fsspec`, `numpy`, and `Pillow`, and network access to
`dmss3gw.riken.jp` and `ssbd.riken.jp`.

## Running locally

This is a static site — any static file server works, e.g.:

```
python3 -m http.server 8000
```

then open `http://localhost:8000/`.
