"""Build the data files used by the web app.

Downloads historical boundary snapshots (aourednik/historical-basemaps) and
AWS Terrain Tiles, then writes, in a shared Lambert azimuthal equal-area
projection centred on Europe (lon0=20, lat0=48, units = km):

  data/boundaries.json   one entry per snapshot year, polygons clipped and simplified
  data/terrain.png       16-bit elevation in R/G, land mask in B

Usage:  python tools/build_data.py --raw <cache dir>
"""
import argparse
import io
import json
import math
import os
import urllib.request

import numpy as np
from PIL import Image, ImageDraw
from shapely import make_valid, transform
from shapely.geometry import MultiPolygon, Polygon, box, shape
from shapely.ops import polylabel, unary_union

BASEMAPS = "https://raw.githubusercontent.com/aourednik/historical-basemaps/master/geojson/"
TILES = "https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png"

SNAPSHOTS = ["bc500", "bc400", "bc323", "bc300", "bc200", "bc100", "bc1",
             "100", "200", "300", "400", "500", "600", "700", "800", "900",
             "1000", "1100", "1200", "1279", "1300", "1400", "1492", "1500",
             "1530", "1600", "1650", "1700", "1715", "1783", "1800", "1815",
             "1878", "1880", "1900", "1914", "1920", "1930", "1938", "1945",
             "1960", "1994", "2000", "2010"]

R = 6371.0
LON0_DEG, LAT0_DEG = 20.0, 48.0
LON0, LAT0 = math.radians(LON0_DEG), math.radians(LAT0_DEG)
# Iceland/Morocco to Persia/Caspian, North Cape to Mecca/Aswan
EXTENT = (-2900.0, -2800.0, 3200.0, 2700.0)  # xmin, ymin, xmax, ymax (km)
KM_PER_PX = 5.0
SIMPLIFY_KM = 2.5
MIN_PART_KM2 = 40.0
TILE_Z = 5


def laea(lon, lat):
    lon, lat = np.radians(lon), np.radians(lat)
    dl = lon - LON0
    k = np.sqrt(2.0 / (1.0 + math.sin(LAT0) * np.sin(lat)
                       + math.cos(LAT0) * np.cos(lat) * np.cos(dl)))
    x = R * k * np.cos(lat) * np.sin(dl)
    y = R * k * (math.cos(LAT0) * np.sin(lat) - math.sin(LAT0) * np.cos(lat) * np.cos(dl))
    return x, y


def laea_inv(x, y):
    rho = np.hypot(x, y)
    c = 2.0 * np.arcsin(np.clip(rho / (2.0 * R), -1, 1))
    rho = np.where(rho == 0, 1e-9, rho)
    lat = np.arcsin(np.cos(c) * math.sin(LAT0) + y * np.sin(c) * math.cos(LAT0) / rho)
    lon = LON0 + np.arctan2(x * np.sin(c),
                            rho * math.cos(LAT0) * np.cos(c) - y * math.sin(LAT0) * np.sin(c))
    return np.degrees(lon), np.degrees(lat)


def fetch(url, path):
    if not os.path.exists(path):
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with urllib.request.urlopen(url, timeout=60) as r:
            data = r.read()
        with open(path, "wb") as f:
            f.write(data)
    with open(path, "rb") as f:
        return f.read()


def year_of(tag):
    return -int(tag[2:]) if tag.startswith("bc") else int(tag)


def polygons_of(geom):
    if isinstance(geom, Polygon):
        return [geom]
    if isinstance(geom, MultiPolygon):
        return list(geom.geoms)
    if hasattr(geom, "geoms"):
        return [p for g in geom.geoms for p in polygons_of(g)]
    return []


def ring_ints(coords):
    flat = []
    for x, y in list(coords)[:-1]:
        flat += [int(round(x)), int(round(y))]
    return flat


def feature(name, props, parts):
    # label the largest part, preferring parts not cut by the map frame (e.g. Denmark, not Greenland)
    biggest = max(parts, key=lambda q: q.area)
    inner = [q for q in parts if not q.intersects(box(*EXTENT).exterior)]
    if inner and max(q.area for q in inner) >= 0.25 * biggest.area:
        biggest = max(inner, key=lambda q: q.area)
    lp = polylabel(biggest, tolerance=5.0)
    clean = lambda v: (v or "").replace("�", "–").strip()
    return {
        "n": name,
        "s": clean(props.get("SUBJECTO")) or name,
        "o": clean(props.get("PARTOF")),
        "b": props.get("BORDERPRECISION") or 0,
        "a": int(sum(q.area for q in parts)),
        "l": [int(lp.x), int(lp.y)],
        "p": [[ring_ints(q.exterior.coords)] + [ring_ints(h.coords) for h in q.interiors]
              for q in parts],
    }


def build_boundaries(raw):
    lonlat_clip = box(-50, 8, 95, 85)
    rect = box(*EXTENT)
    project = lambda c: np.column_stack(laea(c[:, 0], c[:, 1]))
    out = []
    edges = {}  # colour key -> set of neighbouring keys, over all years
    area_of = {}
    last_good = {}  # name -> parts, to repair degenerate source geometries
    for tag in SNAPSHOTS:
        gj = json.loads(fetch(BASEMAPS + f"world_{tag}.geojson", os.path.join(raw, f"world_{tag}.geojson")))
        groups = {}  # a polity can span several source records
        for f in gj["features"]:
            p = f.get("properties") or {}
            name = (p.get("NAME") or "").replace("�", "–").strip()
            if name and f.get("geometry"):
                groups.setdefault(name, (p, []))[1].append(f["geometry"])
        feats, shapes = [], []
        for name, (p, geoms) in groups.items():
            try:
                g = make_valid(unary_union([make_valid(shape(x)) for x in geoms]))
                if g.area < 1e-4 and name in last_good:  # e.g. Switzerland 1994-2010 is a sliver
                    print(f"  repair {tag} {name}: degenerate source geometry, reusing previous outline")
                    parts = last_good[name]
                    feats.append(feature(name, p, parts))
                    shapes.append(MultiPolygon(parts))
                    continue
                g = g.intersection(lonlat_clip)
                if g.is_empty:
                    continue
                g = make_valid(transform(g, project)).intersection(rect)
                g = g.simplify(SIMPLIFY_KM, preserve_topology=True)
            except Exception as e:  # malformed source geometry
                print(f"  skip {tag} {name}: {e}")
                continue
            parts = [q for q in polygons_of(g) if q.area >= MIN_PART_KM2]
            if not parts:
                continue
            last_good[name] = parts
            feats.append(feature(name, p, parts))
            shapes.append(MultiPolygon(parts))
        for i, (fi, gi) in enumerate(zip(feats, shapes)):
            area_of[fi["s"]] = area_of.get(fi["s"], 0) + fi["a"]
            for fj, gj_ in zip(feats[i + 1:], shapes[i + 1:]):
                if fi["s"] != fj["s"] and gi.distance(gj_) < 5.0:
                    edges.setdefault(fi["s"], set()).add(fj["s"])
                    edges.setdefault(fj["s"], set()).add(fi["s"])
        feats.sort(key=lambda f: -f["a"])
        out.append({"year": year_of(tag), "tag": tag, "features": feats})
        print(f"{tag:>6}: {len(feats)} polities")
    return out, assign_colours(edges, area_of)


def assign_colours(edges, area_of, n=10):
    """Greedy colouring: a ruler keeps one colour through time, neighbours differ."""
    colour, used = {}, [0] * n
    for key in sorted(area_of, key=lambda k: -area_of[k]):
        clash = [0] * n
        for nb in edges.get(key, ()):
            if nb in colour:
                clash[colour[nb]] += 1
        colour[key] = min(range(n), key=lambda c: (clash[c], used[c]))
        used[colour[key]] += 1
    conflicts = sum(colour[a] == colour[b] for a in edges for b in edges[a]) // 2
    print(f"colours: {len(colour)} keys, {conflicts} neighbour clashes")
    return colour


def build_terrain(raw, land_year):
    xmin, ymin, xmax, ymax = EXTENT
    w = int((xmax - xmin) / KM_PER_PX)
    h = int((ymax - ymin) / KM_PER_PX)
    xs = xmin + (np.arange(w) + 0.5) * KM_PER_PX
    ys = ymax - (np.arange(h) + 0.5) * KM_PER_PX
    gx, gy = np.meshgrid(xs, ys)
    lon, lat = laea_inv(gx, gy)

    n = 2 ** TILE_Z
    px = (lon + 180.0) / 360.0 * n * 256
    py = (1.0 - np.arcsinh(np.tan(np.radians(lat))) / math.pi) / 2.0 * n * 256
    tx0, tx1 = int(px.min() // 256), int(px.max() // 256)
    ty0, ty1 = int(py.min() // 256), int(py.max() // 256)
    mosaic = np.zeros(((ty1 - ty0 + 1) * 256, (tx1 - tx0 + 1) * 256), dtype=np.float32)
    for ty in range(ty0, ty1 + 1):
        for tx in range(tx0, tx1 + 1):
            data = fetch(TILES.format(z=TILE_Z, x=tx, y=ty),
                         os.path.join(raw, "tiles", f"{TILE_Z}_{tx}_{ty}.png"))
            a = np.asarray(Image.open(io.BytesIO(data)).convert("RGB"), dtype=np.float32)
            e = a[..., 0] * 256 + a[..., 1] + a[..., 2] / 256 - 32768
            mosaic[(ty - ty0) * 256:(ty - ty0 + 1) * 256, (tx - tx0) * 256:(tx - tx0 + 1) * 256] = e
    print(f"terrain: {(tx1 - tx0 + 1) * (ty1 - ty0 + 1)} tiles")

    # bilinear sample of the mercator mosaic at each projected pixel
    mx, my = px - tx0 * 256 - 0.5, py - ty0 * 256 - 0.5
    x0 = np.clip(np.floor(mx).astype(int), 0, mosaic.shape[1] - 2)
    y0 = np.clip(np.floor(my).astype(int), 0, mosaic.shape[0] - 2)
    fx, fy = np.clip(mx - x0, 0, 1), np.clip(my - y0, 0, 1)
    elev = (mosaic[y0, x0] * (1 - fx) * (1 - fy) + mosaic[y0, x0 + 1] * fx * (1 - fy)
            + mosaic[y0 + 1, x0] * (1 - fx) * fy + mosaic[y0 + 1, x0 + 1] * fx * fy)

    # land mask from modern boundaries, so coastlines match the vector data
    # (each feature on its own layer, so one feature's hole cannot erase a neighbour)
    to_px = lambda r: [((r[i] - xmin) / KM_PER_PX, (ymax - r[i + 1]) / KM_PER_PX) for i in range(0, len(r), 2)]
    land = np.zeros((h, w), dtype=bool)
    for f in land_year["features"]:
        mask = Image.new("L", (w, h), 0)
        draw = ImageDraw.Draw(mask)
        for poly in f["p"]:
            draw.polygon(to_px(poly[0]), fill=255)
            for hole in poly[1:]:
                draw.polygon(to_px(hole), fill=0)
        land |= np.asarray(mask) > 0

    v = np.clip(np.round(elev + 6000), 0, 65535).astype(np.uint32)
    rgb = np.stack([(v >> 8) & 255, v & 255, np.where(land, 255, 0)], axis=-1).astype(np.uint8)
    return Image.fromarray(rgb, "RGB"), (w, h), float(elev[land].max())


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--raw", required=True, help="cache directory for downloads")
    ap.add_argument("--out", default=os.path.join(os.path.dirname(__file__), "..", "data"))
    args = ap.parse_args()
    os.makedirs(args.out, exist_ok=True)

    snapshots, colours = build_boundaries(args.raw)
    img, (w, h), max_elev = build_terrain(args.raw, snapshots[-1])
    img.save(os.path.join(args.out, "terrain.png"), optimize=True)

    meta = {"extent": EXTENT, "kmPerPx": KM_PER_PX, "terrainSize": [w, h],
            "elevationOffset": 6000, "maxElevation": round(max_elev),
            "projection": {"type": "laea", "lon0": LON0_DEG, "lat0": LAT0_DEG, "R": R}}
    with open(os.path.join(args.out, "boundaries.json"), "w", encoding="utf-8") as f:
        json.dump({"meta": meta, "colours": colours, "snapshots": snapshots},
                  f, ensure_ascii=False, separators=(",", ":"))
    print(json.dumps(meta))


if __name__ == "__main__":
    main()
