"""Build data/war_layers.json: approximate territorial phases of the two world wars.

No openly licensed year-by-year wartime border data exists, so each phase is composed
here from the country outlines of a base snapshot (data/boundaries.json), optionally cut
by a hand-drawn region (lon/lat polygon) east or west of a front line. Front lines are
simplified and approximate; they show the broad picture, not exact positions.

Sides: "central"/"axis" = occupied or annexed by the Central Powers / Axis,
"entente"/"allied" = held by the Entente / Allies, "soviet" = annexed by the USSR 1939-40.
Territory a side already owned before the war is not shaded.

Usage:  python tools/build_war_layers.py
"""
import json
import os

import numpy as np
from shapely import make_valid
from shapely.geometry import MultiPolygon, Polygon
from shapely.ops import unary_union

from build_data import laea, polygons_of, ring_ints

HERE = os.path.dirname(__file__)
DATA = os.path.join(HERE, "..", "data")

# ---------------------------------------------------------------- front lines (lon, lat)

# Western Front, winter 1914-15 to early 1918: Nieuport - Ypres - Arras - Noyon - Reims - Verdun - St-Mihiel - Vosges
WEST_1914 = [(2.62, 51.5), (2.75, 51.13), (2.85, 50.95), (2.88, 50.85), (2.88, 50.69), (2.78, 50.29), (2.65, 50.0),
             (2.85, 49.75), (3.0, 49.58), (3.32, 49.38), (4.03, 49.25), (4.6, 49.2), (5.38, 49.16), (5.54, 48.9),
             (6.06, 48.9), (6.5, 48.6), (7.0, 48.2), (7.1, 47.5), (12, 47.5), (12, 52), (2.62, 52)]
# after the German spring offensives, July 1918: bulges to Montdidier and Chateau-Thierry
WEST_1918 = [(2.62, 51.5), (2.72, 51.1), (2.6, 50.75), (2.85, 50.5), (2.75, 50.25), (2.4, 49.85), (2.57, 49.65),
             (2.95, 49.4), (3.1, 49.15), (3.4, 49.05), (3.9, 49.1), (4.03, 49.25), (4.6, 49.2), (5.38, 49.16),
             (5.54, 48.9), (6.06, 48.9), (6.5, 48.6), (7.0, 48.2), (7.1, 47.5), (12, 47.5), (12, 52), (2.62, 52)]
# at the Armistice, 11 November 1918: roughly Ghent - Mons - Sedan - Metz
WEST_ARMISTICE = [(3.6, 51.5), (3.7, 51.05), (3.95, 50.45), (4.5, 50.0), (4.94, 49.7), (5.6, 49.5), (6.0, 49.2),
                  (12, 49.2), (12, 52), (3.6, 52)]
# Eastern Front, end of 1915 (after the Great Retreat): Riga - Dvinsk - Baranovichi - Pinsk - Ternopil - Chernivtsi
EAST_1915 = [(18, 58), (23.6, 57.3), (24.1, 56.85), (26.5, 55.9), (26.6, 54.9), (26.0, 53.13), (26.1, 52.1),
             (25.6, 51.2), (25.6, 49.55), (25.9, 48.3), (26.4, 48.0), (18, 48.0)]
# Romania after the 1916 campaign: Wallachia and Dobruja occupied, front on the Siret
ROMANIA_1917 = [(20, 48.5), (25.3, 47.6), (26.5, 46.6), (26.9, 46.0), (27.2, 45.7), (28.05, 45.43), (29.7, 45.2),
                (30, 43), (20, 43)]
# Italy after Caporetto: Venetia east of the Piave
VENETIA_1917 = [(12.25, 45.5), (12.25, 45.85), (11.9, 46.0), (11.7, 46.6), (14, 46.8), (14, 45.4)]
# German-held east after Brest-Litovsk, 1918: Narva - Pskov - Polotsk - Orsha - Kharkiv - Rostov, Ukraine and Crimea
EAST_1918 = [(18, 60.5), (28.2, 59.4), (28.3, 57.8), (28.8, 55.5), (30.4, 54.5), (31.5, 52.5), (34.5, 52.3),
             (36.5, 51.3), (38.3, 50.0), (39.7, 48.5), (39.9, 47.0), (37, 44), (32, 44), (30, 45.2), (18, 45.2)]

# Molotov-Ribbentrop line in Poland, 1939 (Pisa - Narew - Bug - San); west of it went to Germany
POLAND_WEST_1939 = [(14, 56), (22.6, 55), (22.6, 54.3), (22.3, 53.2), (23.0, 52.6), (23.6, 52.1), (24.0, 51.3),
                    (23.7, 50.6), (23.0, 50.0), (22.6, 49.5), (22.6, 48.8), (14, 48.8)]
# occupied France, 1940-42: north and Atlantic coast, west of the demarcation line
FRANCE_OCCUPIED_1940 = [(-6, 52), (-6, 42.5), (-1.78, 43.36), (-1.3, 43.6), (-0.5, 44.0), (-0.2, 44.9), (0.3, 45.9),
                        (0.7, 46.4), (1.3, 47.0), (2.2, 47.2), (3.0, 46.9), (3.5, 46.6), (4.4, 46.7), (5.2, 46.4),
                        (5.95, 46.25), (8, 46.5), (8, 52)]
# Bessarabia and northern Bukovina, annexed by the USSR in June 1940
BESSARABIA = [(25.3, 48.4), (26.6, 48.6), (27.8, 48.5), (29.2, 47.9), (30.2, 46.6), (29.9, 45.2), (28.2, 45.4),
              (28.1, 46.5), (27.3, 47.5), (26.6, 47.9), (25.8, 47.75)]
# Eastern Front, December 1941: Leningrad - Kalinin - west of Moscow - Tula - Kharkiv - Taganrog, Crimea
EAST_1941 = [(18, 61), (30.0, 60.1), (31.5, 58.3), (33, 56.8), (35.5, 56.0), (36.5, 55.4), (37.6, 54.2),
             (36.6, 52.5), (36.2, 51.7), (37.3, 50.2), (38.3, 48.0), (38.8, 47.2), (37.0, 45.5), (33.5, 44.4),
             (28, 44), (18, 44)]
# Eastern Front, November 1942 (greatest Axis extent): Leningrad - Rzhev - Orel - Voronezh - Don - Stalingrad - Caucasus
EAST_1942 = [(18, 61), (30.0, 60.1), (31.5, 58.3), (32.5, 57.0), (34.3, 56.25), (35.2, 55.4), (35.0, 54.0),
             (36.2, 52.6), (37.5, 52.0), (38.5, 51.7), (39.5, 50.5), (42.0, 49.5), (44.5, 48.7), (45.2, 46.5),
             (44.6, 43.3), (41.0, 43.6), (38.0, 44.6), (36.5, 45.2), (28, 44), (18, 44)]
# Eastern Front, end of 1943: Novgorod - Nevel - Vitebsk - west of Gomel and Kyiv - Dnieper bend; Crimea cut off but held
EAST_1943 = [(18, 61), (30.0, 60.1), (31.5, 58.3), (30.5, 56.4), (30.3, 55.2), (30.3, 53.9), (29.5, 52.3),
             (29.7, 51.4), (29.5, 50.3), (31.0, 49.5), (33.0, 48.5), (34.0, 47.5), (33.5, 46.6), (36.6, 45.4),
             (33.5, 44.2), (28, 44), (18, 44)]
# Poland and the Baltic, September 1944: front on the Vistula, Narew and East Prussian border
POLAND_WEST_1944 = [(14, 60), (24.5, 59.6), (25.0, 57.8), (24.4, 56.9), (22.8, 55.2), (22.0, 54.3), (21.6, 53.1),
                    (21.1, 52.3), (21.5, 51.2), (21.7, 50.2), (21.6, 49.2), (14, 48.5)]
# Egypt west of El Alamein, autumn 1942
EGYPT_WEST_ALAMEIN = [(24, 33), (28.9, 31.2), (28.9, 29), (24, 29)]

lon_lat_box = lambda w, s, e, n: [(w, s), (e, s), (e, n), (w, n)]
# Denmark without Iceland, which shared its crown in 1938 but was occupied by the Allies in 1940
DENMARK_PROPER = lon_lat_box(7, 54, 16, 58.5)

# ---------------------------------------------------------------- phases

PHASES = {
    "ww1": [
        ("1914-12-31", "ww1_1914", [
            ("central", 1914, ["Belgium", "France", "Luxembourg"], WEST_1914),
        ]),
        ("1915-12-31", "ww1_1915", [
            ("central", 1914, ["Belgium", "France", "Luxembourg"], WEST_1914),
            ("central", 1914, ["Russian Empire"], EAST_1915),
            ("central", 1914, ["Serbia", "Montenegro"], None),
        ]),
        ("1917-01-15", "ww1_1916", [
            ("central", 1914, ["Belgium", "France", "Luxembourg"], WEST_1914),
            ("central", 1914, ["Russian Empire"], EAST_1915),
            ("central", 1914, ["Serbia", "Montenegro"], None),
            ("central", 1914, ["Romania"], ROMANIA_1917),
            ("entente", 1914, ["Ottoman Empire"], lon_lat_box(45, 29, 49, 31.6)),
        ]),
        ("1917-12-31", "ww1_1917", [
            ("central", 1914, ["Belgium", "France", "Luxembourg"], WEST_1914),
            ("central", 1914, ["Russian Empire"], EAST_1915),
            ("central", 1914, ["Serbia", "Montenegro"], None),
            ("central", 1914, ["Romania"], ROMANIA_1917),
            ("central", 1914, ["Kingdom of Italy"], VENETIA_1917),
            ("entente", 1914, ["Ottoman Empire"], lon_lat_box(42, 29, 49, 34.2)),
            ("entente", 1914, ["Ottoman Empire"], lon_lat_box(33.5, 29, 36, 31.9)),
        ]),
        ("1918-07-15", "ww1_1918", [
            ("central", 1914, ["Belgium", "France", "Luxembourg"], WEST_1918),
            ("central", 1914, ["Russian Empire"], EAST_1918),
            ("central", 1914, ["Serbia", "Montenegro"], None),
            ("central", 1914, ["Romania"], ROMANIA_1917),
            ("central", 1914, ["Kingdom of Italy"], VENETIA_1917),
            ("entente", 1914, ["Ottoman Empire"], lon_lat_box(42, 29, 49, 34.6)),
            ("entente", 1914, ["Ottoman Empire"], lon_lat_box(33.5, 29, 36, 32.1)),
        ]),
        ("1918-11-11", "ww1_armistice", [
            ("central", 1914, ["Belgium", "France", "Luxembourg"], WEST_ARMISTICE),
            ("central", 1914, ["Russian Empire"], EAST_1918),
            ("central", 1914, ["Romania"], ROMANIA_1917),
            ("entente", 1914, ["Ottoman Empire"], lon_lat_box(33.5, 29, 49, 36.6)),
        ]),
    ],
    "ww2": [
        ("1939-04-15", "ww2_1939a", [
            ("axis", 1930, ["Austria"], None),
            ("axis", 1938, ["Czechoslovakia", "Albania"], None),
        ]),
        ("1939-10-06", "ww2_1939b", [
            ("axis", 1930, ["Austria"], None),
            ("axis", 1938, ["Czechoslovakia", "Albania"], None),
            ("axis", 1938, ["Poland"], POLAND_WEST_1939),
            ("soviet", 1938, ["Poland"], None),  # the rest of Poland; the axis part is subtracted below
        ]),
        ("1940-07-15", "ww2_1940", [
            ("axis", 1930, ["Austria"], None),
            ("axis", 1938, ["Czechoslovakia", "Albania", "Norway", "Netherlands", "Belgium", "Luxembourg"], None),
            ("axis", 1938, ["Denmark"], DENMARK_PROPER),
            ("axis", 1938, ["Poland"], POLAND_WEST_1939),
            ("axis", 1938, ["France"], FRANCE_OCCUPIED_1940),
            ("soviet", 1938, ["Poland", "Estonia", "Latvia", "Lithuania"], None),
            ("soviet", 1938, ["Romania"], BESSARABIA),
        ]),
        ("1941-12-05", "ww2_1941", [
            ("axis", 1930, ["Austria"], None),
            ("axis", 1938, ["Czechoslovakia", "Albania", "Norway", "Netherlands", "Belgium", "Luxembourg",
                            "Poland", "Estonia", "Latvia", "Lithuania", "Yugoslavia", "Greece"], None),
            ("axis", 1938, ["Denmark"], DENMARK_PROPER),
            ("axis", 1938, ["France"], FRANCE_OCCUPIED_1940),
            ("axis", 1938, ["USSR"], EAST_1941),
        ]),
        ("1942-11-15", "ww2_1942", [
            ("axis", 1930, ["Austria"], None),
            ("axis", 1938, ["Czechoslovakia", "Albania", "Norway", "Netherlands", "Belgium", "Luxembourg",
                            "Poland", "Estonia", "Latvia", "Lithuania", "Yugoslavia", "Greece", "France"], None),
            ("axis", 1938, ["Denmark"], DENMARK_PROPER),
            ("axis", 1938, ["USSR"], EAST_1942),
            ("axis", 1938, ["Egypt"], EGYPT_WEST_ALAMEIN),
            ("allied", 1938, ["Morocco (France)", "Algeria (France)"], None),
        ]),
        ("1943-12-31", "ww2_1943", [
            ("axis", 1930, ["Austria"], None),
            ("axis", 1938, ["Czechoslovakia", "Albania", "Norway", "Netherlands", "Belgium", "Luxembourg",
                            "Poland", "Estonia", "Latvia", "Lithuania", "Yugoslavia", "Greece", "France"], None),
            ("axis", 1938, ["Denmark"], DENMARK_PROPER),
            ("axis", 1938, ["USSR"], EAST_1943),
            ("axis", 1938, ["Italy"], lon_lat_box(6, 41.4, 19, 48)),
            ("allied", 1938, ["Italy"], lon_lat_box(6, 35, 19, 41.4)),
        ]),
        ("1944-09-15", "ww2_1944", [
            ("axis", 1930, ["Austria"], None),
            ("axis", 1938, ["Czechoslovakia", "Norway", "Yugoslavia", "Albania", "Hungary"], None),
            ("axis", 1938, ["Denmark"], DENMARK_PROPER),
            ("axis", 1938, ["Netherlands"], lon_lat_box(3, 51.3, 8, 54)),
            ("axis", 1938, ["Poland", "Estonia", "Latvia", "Lithuania"], POLAND_WEST_1944),
            ("axis", 1938, ["Greece"], lon_lat_box(19, 39.5, 27, 42)),
            ("axis", 1938, ["Italy"], lon_lat_box(6, 43.9, 19, 48)),
            ("axis", 1938, ["France"], lon_lat_box(6.3, 47.4, 9, 49.6)),
            ("allied", 1938, ["Italy"], lon_lat_box(6, 35, 19, 43.9)),
        ]),
        ("1945-04-15", "ww2_1945", [
            ("axis", 1930, ["Austria"], lon_lat_box(9, 46, 15.8, 49)),
            ("axis", 1938, ["Czechoslovakia"], lon_lat_box(12, 48.5, 18.5, 51.2)),
            ("axis", 1938, ["Norway"], None),
            ("axis", 1938, ["Denmark"], DENMARK_PROPER),
            ("axis", 1938, ["Netherlands"], lon_lat_box(4.5, 51.9, 7.5, 54)),
            ("axis", 1938, ["Latvia"], lon_lat_box(20, 56, 23.5, 58)),
            ("axis", 1938, ["Italy"], lon_lat_box(6, 44.6, 14, 48)),
            ("axis", 1938, ["Yugoslavia"], lon_lat_box(13, 44.6, 17, 47)),
        ]),
    ],
}

# English titles; translations live in data/i18n/<lang>.json under "phases"
TITLES = {
    "ww1_1914": "End of 1914: the Western Front digs in",
    "ww1_1915": "End of 1915: Russian Poland and Serbia occupied",
    "ww1_1916": "Early 1917: Romania overrun",
    "ww1_1917": "End of 1917: Caporetto; Baghdad and Jerusalem fall",
    "ww1_1918": "July 1918: Brest-Litovsk and the spring offensives",
    "ww1_armistice": "Armistice, November 1918",
    "ww2_1939a": "Spring 1939: Austria, Czechoslovakia, Albania",
    "ww2_1939b": "October 1939: Poland partitioned",
    "ww2_1940": "Summer 1940: Western Europe falls",
    "ww2_1941": "December 1941: at the gates of Moscow",
    "ww2_1942": "November 1942: greatest Axis extent",
    "ww2_1943": "End of 1943: Soviet advance, Italy divided",
    "ww2_1944": "September 1944: liberation of France",
    "ww2_1945": "April 1945: final weeks in Europe",
}


def main():
    snaps = {s["year"]: s for s in json.load(open(os.path.join(DATA, "boundaries.json"), encoding="utf-8"))["snapshots"]}

    def country_shape(year, name):
        feats = [f for f in snaps[year]["features"] if f["n"] == name]
        assert feats, f"{name} not in {year} snapshot"
        polys = [make_valid(Polygon(_pts(poly[0]), [_pts(h) for h in poly[1:]])) for f in feats for poly in f["p"]]
        return make_valid(unary_union(polys))

    def region(lonlat):
        x, y = laea(np.array([p[0] for p in lonlat]), np.array([p[1] for p in lonlat]))
        return make_valid(Polygon(zip(x, y)))

    out = {"titles": TITLES, "wars": {}}
    for war, phases in PHASES.items():
        out["wars"][war] = []
        for date, key, items in phases:
            by_side = {}
            for side, base, names, within in items:
                g = unary_union([country_shape(base, n) for n in names])
                if within:
                    g = g.intersection(region(within))
                by_side.setdefault(side, []).append(g)
            sides = {s: unary_union(gs) for s, gs in by_side.items()}
            if "soviet" in sides and "axis" in sides:
                sides["soviet"] = sides["soviet"].difference(sides["axis"])
            layers = []
            for side, g in sides.items():
                g = g.simplify(1.5, preserve_topology=True)
                parts = [p for p in polygons_of(g) if p.area >= 60]
                layers.append({"side": side, "a": int(sum(p.area for p in parts)),
                               "p": [[ring_ints(p.exterior.coords)] + [ring_ints(h.coords) for h in p.interiors]
                                     for p in parts]})
            out["wars"][war].append({"date": date, "key": key, "layers": layers})
            print(f"{date} {key}: " + ", ".join(f"{l['side']} {l['a']:,} km²" for l in layers))
    with open(os.path.join(DATA, "war_layers.json"), "w", encoding="utf-8") as f:
        json.dump(out, f, ensure_ascii=False, separators=(",", ":"))


def _pts(ring):
    return [(ring[i], ring[i + 1]) for i in range(0, len(ring), 2)]


if __name__ == "__main__":
    main()
