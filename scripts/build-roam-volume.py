#!/usr/bin/env python3
"""
Work out where a visitor is allowed to fly, straight from the scan.

Hand control needs two things the tour didn't: a boundary (browsing stays in the courtyard
for now) and collision (pushing down or sideways must not put the camera inside a wall or
under the pavement). Both come from the same occupancy grid the tour planner uses, so the
rule is measured rather than guessed.

Flood-fills the open air CONNECTED TO THE TOUR'S STOPS, within a height band a person would
plausibly fly through, then emits that region as a coarse occupancy grid the kiosk can test
positions against every frame.

Usage: build-roam-volume.py <cropped.ply> <tour.json> <out.json>
"""
import json
import sys
from collections import deque

import numpy as np

# Finer than the tour planner's 0.7: at that size a cell is about 2 m across, and a courtyard
# only a few metres wide collapses to one or two free cells — the camera ends up in a
# single-cell cage with solid on every side and no gesture can move it. Solidity is a DENSITY
# so the threshold tracks the cell volume rather than being retuned by hand.
VOX = float(__import__("os").environ.get("ROAM_VOX", 0.3))
SOLID_PER_UNIT3 = 8.7  # ≈ the old "3 points in a 0.7³ cell", expressed per cubic unit
CLEARANCE = float(__import__("os").environ.get("ROAM_CLEAR", 0.5))  # above local ground
# The ceiling has to stay BELOW the surrounding roofline. Set it higher and the flood fill
# escapes over the roofs and the "courtyard" becomes the whole site — which is how the first
# run produced a box spanning the entire model.
CEILING = 2.2  # how far above a stop the visitor may climb
DEPTH = 0.9  # ...and how far below (the ground clearance does the real work underneath)
# How far from the nearest stop a visitor may wander. This is what keeps browsing "in the
# courtyard", and it has to be stated outright: a coarse grid appears to confine the fill, but
# only because it seals real passages shut — the same coarseness cages the camera in a
# single-cell pocket at the stops. Resolution decides collision accuracy; THIS decides range.
MAX_FROM_STOP = float(__import__("os").environ.get("ROAM_RANGE", 14.0))


def read_ply(path):
    f = open(path, "rb")
    hdr = b""
    while b"end_header\n" not in hdr:
        hdr += f.read(1)
    lines = hdr.decode().splitlines()
    n = int([l for l in lines if l.startswith("element vertex")][0].split()[-1])
    names = [l.split()[-1] for l in lines if l.startswith("property float")]
    d = np.frombuffer(f.read(n * len(names) * 4), dtype="<f4").reshape(n, len(names))
    col = lambda c: d[:, names.index(c)].astype(np.float64)
    xyz = np.stack([col("x"), col("y"), col("z")], 1)
    op = 1.0 / (1.0 + np.exp(-col("opacity")))
    return xyz[op > 0.35]


def main():
    ply, tour_path, out_path = sys.argv[1], sys.argv[2], sys.argv[3]
    pts = read_ply(ply)
    P = np.stack([pts[:, 0], -pts[:, 1], -pts[:, 2]], 1)  # stored Y-down -> app world

    lo = P.min(0) - VOX * 2
    hi = P.max(0) + VOX * 2
    dim = np.ceil((hi - lo) / VOX).astype(int)
    idx = np.clip(((P - lo) / VOX).astype(int), 0, dim - 1)
    cnt = np.zeros(dim, dtype=np.int32)
    np.add.at(cnt, (idx[:, 0], idx[:, 1], idx[:, 2]), 1)
    solid = cnt >= max(1, round(SOLID_PER_UNIT3 * VOX**3))
    print(f"grid {tuple(dim)} · solid {solid.sum()}", flush=True)

    to_idx = lambda p: tuple(np.clip(((np.asarray(p) - lo) / VOX).astype(int), 0, dim - 1))

    # ground height per column, so "don't go under the pavement" is a per-column rule rather
    # than one flat floor — the courtyard and the street outside are not at the same level
    ground = np.full((dim[0], dim[2]), lo[1])
    for ix in range(dim[0]):
        for iz in range(dim[2]):
            hits = np.flatnonzero(solid[ix, :, iz])
            if len(hits):
                ground[ix, iz] = lo[1] + (hits[0] + 0.5) * VOX

    stops = [w for w in json.load(open(tour_path)) if w["kind"] == "stop"]
    seeds = [to_idx(w["pos"]) for w in stops]
    ys = [w["pos"][1] for w in stops]
    y_lo, y_hi = min(ys) - DEPTH, max(ys) + CEILING
    print(f"{len(seeds)} stops · height band {y_lo:.1f} … {y_hi:.1f}", flush=True)

    # flood fill the air reachable FROM THE STOPS, which is what confines this to the
    # courtyard: the ring of buildings is the wall that stops the fill escaping
    free = np.zeros(dim, dtype=bool)
    q = deque()
    for s in seeds:
        if not solid[s]:
            free[s] = True
            q.append(s)
    while q:
        x, y, z = q.popleft()
        for dx, dy, dz in ((1, 0, 0), (-1, 0, 0), (0, 1, 0), (0, -1, 0), (0, 0, 1), (0, 0, -1)):
            a, b, c = x + dx, y + dy, z + dz
            if not (0 <= a < dim[0] and 0 <= b < dim[1] and 0 <= c < dim[2]):
                continue
            if free[a, b, c] or solid[a, b, c]:
                continue
            wy = lo[1] + (b + 0.5) * VOX
            if wy < y_lo or wy > y_hi or wy < ground[a, c] + CLEARANCE:
                continue
            wp = lo + (np.array([a, b, c]) + 0.5) * VOX
            if min(np.linalg.norm(wp - np.array(w["pos"])) for w in stops) > MAX_FROM_STOP:
                continue
            free[a, b, c] = True
            q.append((a, b, c))

    where = np.argwhere(free)
    bmin = lo + where.min(0) * VOX
    bmax = lo + (where.max(0) + 1) * VOX
    print(f"roamable {free.sum()} voxels · box {np.round(bmin,1)} … {np.round(bmax,1)}", flush=True)

    # crop to the occupied part and emit as a flat 0/1 string — a few KB, cheap to test
    sub = free[
        where.min(0)[0] : where.max(0)[0] + 1,
        where.min(0)[1] : where.max(0)[1] + 1,
        where.min(0)[2] : where.max(0)[2] + 1,
    ]
    out = {
        "cell": VOX,
        "min": [round(float(v), 3) for v in bmin],
        "dims": [int(v) for v in sub.shape],
        "free": "".join("1" if v else "0" for v in sub.ravel(order="C")),
    }
    json.dump(out, open(out_path, "w"))
    kb = len(out["free"]) / 1024
    print(f"wrote {out_path}: {sub.shape} = {kb:.1f} KB of occupancy", flush=True)


main()
