#!/usr/bin/env python3
"""
Replay the kiosk's hand-control loop offline against the roam volume.

Reproduces SparkCampusExperiment's movement exactly — try the whole move, fall back axis by
axis so a push into a wall slides instead of stopping, then clamp to the model bounds — and
drives it with synthetic gestures from every stop, in every direction, for as long as a
visitor plausibly would.

Checks: does any reachable position land in a solid cell (clipping), how long does it take to
cross the courtyard (speed), and does any direction lock up.
"""
import json
import math
import sys

BASE = "/Users/hayden/projects/groundtruth/apps/kiosk/src/experiments/spark/"
roam = json.load(open(BASE + "roam.json"))
tour = json.load(open(BASE + "tour.json"))

CELL = roam["cell"]
RMIN = roam["min"]
NX, NY, NZ = roam["dims"]
FREE = roam["free"]

# must mirror the constants in SparkCampusExperiment.tsx
DOLLY_SPEED = 1.0
STRAFE_SPEED = 0.8
LIFT_SPEED = 0.8
ACCEL = 0.35
FWD_LIMIT, BACK_LIMIT, SIDE_LIMIT, LIFT_LIMIT = 16.0, 5.0, 10.0, 6.0
DT = 1 / 60


def roamable(x, y, z):
    ix = math.floor((x - RMIN[0]) / CELL)
    iy = math.floor((y - RMIN[1]) / CELL)
    iz = math.floor((z - RMIN[2]) / CELL)
    if ix < 0 or iy < 0 or iz < 0 or ix >= NX or iy >= NY or iz >= NZ:
        return False
    return FREE[(ix * NY + iy) * NZ + iz] == "1"


def quat_axes(q):
    x, y, z, w = q
    fwd = (
        -(2 * (x * z + y * w)),
        -(2 * (y * z - x * w)),
        -(1 - 2 * (x * x + y * y)),
    )
    n = math.dist(fwd, (0, 0, 0)) or 1
    fwd = tuple(c / n for c in fwd)
    # right = fwd × up(0,1,0), normalised
    r = (fwd[2] * 1 - 0, 0.0, -(fwd[0] * 1))
    rn = math.hypot(r[0], r[2]) or 1
    right = (r[0] / rn, 0.0, r[2] / rn)
    return fwd, right


def clamp(v, lo, hi):
    return lo if v < lo else hi if v > hi else v


def run(base_pos, q, gesture, seconds=25.0, bounds=None):
    """gesture = (dolly, strafe, lift) each in -1..1, held for the whole run"""
    fwd, right = quat_axes(q)
    d = s = l = 0.0
    pd = ps = pl = 0.0
    vs = vl = 0.0
    gd, gs, gl = gesture
    visited = []
    stuck_for = 0.0
    t = 0.0
    while t < seconds:
        t += DT
        vs += (gs * STRAFE_SPEED - vs) * min(1, DT / ACCEL)
        vl += (gl * LIFT_SPEED - vl) * min(1, DT / ACCEL)
        want_d = clamp(d + gd * DOLLY_SPEED * DT, -BACK_LIMIT, FWD_LIMIT)
        want_s = clamp(s + vs * DT, -SIDE_LIMIT, SIDE_LIMIT)
        want_l = clamp(l + vl * DT, -LIFT_LIMIT, LIFT_LIMIT)

        def place(dd, ss, ll):
            p = [
                base_pos[0] + fwd[0] * dd + right[0] * ss,
                base_pos[1] + fwd[1] * dd + ll,
                base_pos[2] + fwd[2] * dd + right[2] * ss,
            ]
            return p, roamable(*p)

        p, ok = place(want_d, want_s, want_l)
        if not ok:
            kept_l = want_l if place(pd, ps, want_l)[1] else pl
            kept_s = want_s if place(pd, want_s, kept_l)[1] else ps
            kept_d = want_d if place(want_d, kept_s, kept_l)[1] else pd
            p, ok = place(kept_d, kept_s, kept_l)
            d, s, l = kept_d, kept_s, kept_l
        else:
            d, s, l = want_d, want_s, want_l
        pd, ps, pl = d, s, l

        if bounds:  # the app clamps to the model box AFTER the roam test
            p = [clamp(p[i], bounds[0][i], bounds[1][i]) for i in range(3)]
        visited.append((t, tuple(p), roamable(*p)))
        moved = math.dist(visited[-1][1], visited[-2][1]) if len(visited) > 1 else 1
        stuck_for = stuck_for + DT if moved < 1e-4 else 0.0
    return visited, stuck_for


def main():
    stops = [w for w in tour if w["kind"] == "stop"]
    print(f"roam grid {NX}x{NY}x{NZ} cell {CELL} · free {FREE.count('1')}")
    print(f"world span x {RMIN[0]:.1f}..{RMIN[0]+NX*CELL:.1f} "
          f"y {RMIN[1]:.1f}..{RMIN[1]+NY*CELL:.1f} z {RMIN[2]:.1f}..{RMIN[2]+NZ*CELL:.1f}\n")

    print("--- are the stops themselves flyable? ---")
    bad = 0
    for i, w in enumerate(stops):
        ok = roamable(*w["pos"])
        print(f"  stop {i} {w['pos']} -> {'OK' if ok else 'NOT ROAMABLE'}")
        bad += not ok
    if bad:
        print(f"  !! {bad} stop(s) start outside the roam volume — hand control cannot move\n")

    # model bounds as the app has them (mid/max tier, world frame)
    bounds = None  # the app no longer clamps to the model box; the roam cells are the rule

    print("\n--- clipping + speed, holding each gesture for 25 s ---")
    gestures = {
        "forward": (1, 0, 0),
        "back": (-1, 0, 0),
        "left": (0, -1, 0),
        "right": (0, 1, 0),
        "down": (0, 0, -1),
        "up": (0, 0, 1),
        "fwd+right": (1, 1, 0),
    }
    worst = []
    for i, w in enumerate(stops[:4]):
        for name, g in gestures.items():
            visited, stuck = run(w["pos"], w["quat"], g, bounds=bounds)
            clipped = [v for v in visited if not v[2]]
            travel = math.dist(visited[-1][1], visited[0][1])
            first = f"{clipped[0][0]:.1f}s" if clipped else "-"
            flag = "  <-- CLIPS" if clipped else ""
            print(
                f"  stop{i} {name:9s} travel {travel:5.1f}u  clipped {len(clipped):4d} frames"
                f" (first {first}){flag}"
            )
            if clipped:
                worst.append((i, name, clipped[0]))

    print("\n--- how long to cross the courtyard at these speeds ---")
    print(f"  slide {STRAFE_SPEED} u/s  → 10 u of side travel = {10/STRAFE_SPEED:.0f} s")
    print(f"  fly   {DOLLY_SPEED} u/s  → 16 u of forward travel = {16/DOLLY_SPEED:.0f} s")
    print(f"  (1 unit is about 3 m, so {STRAFE_SPEED*3:.1f} m/s and {DOLLY_SPEED*3:.1f} m/s)")

    if worst:
        print(f"\nRESULT: {len(worst)} gesture(s) end up inside geometry — not shippable")
    else:
        print("\nRESULT: no clipping in any tested direction")


main()
