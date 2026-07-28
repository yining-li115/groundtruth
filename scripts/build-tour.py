#!/usr/bin/env python3
"""
Build the final tour from the hand-picked stops: validate each pose's frame fill, nudge any
pose that lets the void in back onto the model, then route between consecutive stops through
free air so the flight from inside the courtyard ring to outside it never crosses a wall.

Usage: build-tour.py <cropped.ply> <pins.json> <out.json>
"""
import json
import sys
import heapq
import numpy as np

VOX = 0.7
FOV_Y = np.radians(60)
ASPECT = 16 / 9
MAX_SIGHT = 70.0  # a ray that gets this far without hitting anything is looking at void


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

RAY_COLS, RAY_ROWS = 21, 13
MIN_FILL = 0.995
NEAR_CLEAR = 0.6  # closest surface allowed in frame — below this the camera is in a wall
PAD = 8.0  # grid padding, so poses parked outside the data still index into free air


class Grid:
    def __init__(self, pts):
        self.lo = pts.min(0) - PAD
        self.hi = pts.max(0) + PAD
        self.dim = np.ceil((self.hi - self.lo) / VOX).astype(int)
        idx = np.clip(((pts - self.lo) / VOX).astype(int), 0, self.dim - 1)
        cnt = np.zeros(self.dim, dtype=np.int32)
        np.add.at(cnt, (idx[:, 0], idx[:, 1], idx[:, 2]), 1)
        self.solid = cnt >= 3
        print(f"grid {tuple(self.dim)} · solid {self.solid.sum()}", flush=True)

    def to_idx(self, p):
        return tuple(np.clip(((np.asarray(p) - self.lo) / VOX).astype(int), 0, self.dim - 1))

    def to_world(self, i):
        return self.lo + (np.asarray(i, dtype=float) + 0.5) * VOX

    def march(self, o, dirs, max_dist=MAX_SIGHT):
        step = VOX * 0.8
        ts = np.arange(1, int(max_dist / step) + 1) * step
        pts = np.asarray(o)[None, None, :] + dirs[:, None, :] * ts[None, :, None]
        ijk = ((pts - self.lo) / VOX).astype(int)
        inside = np.all((ijk >= 0) & (ijk < self.dim), axis=2)
        ijk = np.clip(ijk, 0, self.dim - 1)
        hit = self.solid[ijk[..., 0], ijk[..., 1], ijk[..., 2]] & inside
        return np.where(hit.any(1), ts[np.argmax(hit, 1)], np.inf)

    def free(self):
        air = ~self.solid
        reach = np.zeros_like(air)
        nx, ny, nz = self.dim
        stack = [(x, ny - 1, z) for x in range(nx) for z in range(nz) if air[x, ny - 1, z]]
        for s in stack:
            reach[s] = True
        while stack:
            x, y, z = stack.pop()
            for d in ((1, 0, 0), (-1, 0, 0), (0, 1, 0), (0, -1, 0), (0, 0, 1), (0, 0, -1)):
                a, b, c = x + d[0], y + d[1], z + d[2]
                if 0 <= a < nx and 0 <= b < ny and 0 <= c < nz and air[a, b, c] and not reach[a, b, c]:
                    reach[a, b, c] = True
                    stack.append((a, b, c))
        print(f"reachable air {reach.sum()}", flush=True)
        return reach

    def flyable(self, reach, global_ground, clearance=0.6):
        """Reachable air is not the same as flyable air. The scanned ground is a shell, so
        the flood fill leaks through its holes into the empty volume UNDER the site — and a
        shortest path will happily dive through it and skim along below the pavement. Keep
        only air that sits at least `clearance` above the local ground.

        `clearance` is deliberately small: the pinned courtyard viewpoints sit barely more
        than a unit over the pavement, and a taller floor would exclude the very stops the
        route has to start and end on. Columns with nothing scanned in them (off the edge of
        the model) fall back to the site's overall ground level rather than being dropped,
        which would wall off the airspace around the model."""
        nx, ny, nz = self.dim
        ys = self.lo[1] + (np.arange(ny) + 0.5) * VOX
        ok = np.zeros_like(reach)
        for ix in range(nx):
            for iz in range(nz):
                hits = np.flatnonzero(self.solid[ix, :, iz])
                ground = self.lo[1] + (hits[0] + 0.5) * VOX if len(hits) else global_ground
                ok[ix, :, iz] = reach[ix, :, iz] & (ys >= ground + clearance)
        print(f"flyable air {ok.sum()} (of {reach.sum()} reachable)", flush=True)
        return ok

    def open_at(self, mask, pos, r=1):
        """make sure a waypoint's own voxel can be routed from, whatever the floor rule said"""
        ix, iy, iz = self.to_idx(pos)
        for a in range(max(0, ix - r), min(self.dim[0], ix + r + 1)):
            for b in range(max(0, iy - r), min(self.dim[1], iy + r + 1)):
                for c in range(max(0, iz - r), min(self.dim[2], iz + r + 1)):
                    if not self.solid[a, b, c]:
                        mask[a, b, c] = True


def basis(q):
    x, y, z, w = q
    return np.array([
        [1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w)],
        [2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w)],
        [2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y)],
    ])


def frustum(q, fov=None):
    ty = np.tan((FOV_Y if fov is None else np.radians(fov)) / 2)
    tx = ty * ASPECT
    uu, vv = np.meshgrid(np.linspace(-tx, tx, RAY_COLS), np.linspace(ty, -ty, RAY_ROWS))
    d = np.stack([uu.ravel(), vv.ravel(), -np.ones(uu.size)], 1) @ basis(q).T
    return d / np.linalg.norm(d, axis=1, keepdims=True)


def fill_of(grid, pos, q, fov=None):
    d = grid.march(pos, frustum(q, fov))
    return float(np.isfinite(d).mean()), float(d.min())


def yaw_pitch(q):
    """Recover yaw/pitch from a camera quaternion via its forward vector.

    A three.js camera looks down -Z, so forward = (-sin(yaw)cos(pitch), sin(pitch),
    -cos(yaw)cos(pitch)); taking atan2(f.x, f.z) recovers yaw + 180 deg and every pose
    rebuilt from it faces backwards."""
    f = basis(q) @ np.array([0.0, 0.0, -1.0])
    return float(np.arctan2(-f[0], -f[2])), float(np.arcsin(np.clip(f[1], -1, 1)))


def quat_yp(yaw, pitch):
    cy, sy = np.cos(yaw / 2), np.sin(yaw / 2)
    cp, sp = np.cos(pitch / 2), np.sin(pitch / 2)
    q = np.array([cy * sp, sy * cp, -sy * sp, cy * cp])
    return q / np.linalg.norm(q)


def slerp(a, b, t):
    a, b = np.asarray(a, float), np.asarray(b, float)
    if np.dot(a, b) < 0:
        b = -b
    d = np.clip(np.dot(a, b), -1, 1)
    if d > 0.9995:
        r = a + t * (b - a)
        return r / np.linalg.norm(r)
    th = np.arccos(d) * t
    c = b - a * d
    c /= np.linalg.norm(c)
    return a * np.cos(th) + c * np.sin(th)


def reaim(grid, pos, q, min_fill=0.97):
    """Keep the camera on the model mid-flight. A via's orientation is interpolated between
    its neighbouring stops, which says nothing about what it is pointed at along the way —
    so verify, and if the frame has holes, take the nearest heading that fills it."""
    f, _ = fill_of(grid, pos, q)
    if f >= min_fill:
        return q, f, 0.0
    yaw0, pitch0 = yaw_pitch(q)
    best = None
    for dy in np.arange(-1.4, 1.45, 0.12):
        for dp in np.arange(-0.9, 0.35, 0.08):
            qq = quat_yp(yaw0 + dy, np.clip(pitch0 + dp, -1.35, 0.5))
            ff, near = fill_of(grid, pos, qq)
            if ff >= min_fill and near > NEAR_CLEAR:
                dev = abs(dy) + abs(dp)
                if best is None or dev < best[0]:
                    best = (dev, qq, ff)
    if best:
        return best[1], best[2], best[0]
    # nothing fills from here — take whatever sees the most
    cands = [
        (fill_of(grid, pos, quat_yp(yaw0 + dy, np.clip(pitch0 + dp, -1.35, 0.5)))[0],
         quat_yp(yaw0 + dy, np.clip(pitch0 + dp, -1.35, 0.5)))
        for dy in np.arange(-1.4, 1.45, 0.2)
        for dp in np.arange(-0.9, 0.35, 0.15)
    ]
    ff, qq = max(cands, key=lambda t: t[0])
    return qq, ff, 99.0


def repair(grid, pos, q):  # noqa: D401
    """Fix a frame that lets the void in WITHOUT moving the camera.

    The position is the part the human actually chose, so it is never touched. A hole means
    the frustum overshot the roofline, which two things can pull back: tilting down, and a
    longer lens. Search both and take the smallest visible change — a few degrees of tilt
    reads as nothing, whereas sliding the camera across the site rewrites the shot."""
    yaw, pitch0 = yaw_pitch(q)
    best = None
    for dp in np.arange(0, -0.85, -0.02):
        for fov in (60, 57, 54, 51, 48, 45, 42, 38, 34, 30, 26):
            qq = quat_yp(yaw, pitch0 + dp)
            f, _ = fill_of(grid, pos, qq, fov)
            # No proximity guard here. The position came from a person who flew to it and
            # looked, so "am I inside a wall" is already answered — and the test can't work
            # anyway at this voxel size: a camera a couple of metres over the pavement always
            # has the floor within one voxel, so the frustum's nearest hit pins to the first
            # ray step no matter where the shot is aimed.
            if f >= MIN_FILL:
                cost = abs(np.degrees(dp)) + (60 - fov) * 1.4
                if best is None or cost < best[0]:
                    best = (cost, qq, fov, f, np.degrees(dp))
                break
    return best


NEIGHBOURS = [
    (dx, dy, dz)
    for dx in (-1, 0, 1)
    for dy in (-1, 0, 1)
    for dz in (-1, 0, 1)
    if (dx, dy, dz) != (0, 0, 0)
]


def astar(reach, start, goal):
    """26-connected: 6-connectivity can't squeeze diagonally through a gap the voxel grid
    has pinched shut, which is how the route out of the ring came back empty."""
    nx, ny, nz = reach.shape
    h = lambda a: max(abs(a[0] - goal[0]), abs(a[1] - goal[1]), abs(a[2] - goal[2]))
    open_, came, cost = [(h(start), 0.0, start)], {}, {start: 0.0}
    while open_:
        _, g, cur = heapq.heappop(open_)
        if cur == goal:
            path = [cur]
            while cur in came:
                cur = came[cur]
                path.append(cur)
            return path[::-1]
        for d in NEIGHBOURS:
            nb = (cur[0] + d[0], cur[1] + d[1], cur[2] + d[2])
            if not (0 <= nb[0] < nx and 0 <= nb[1] < ny and 0 <= nb[2] < nz) or not reach[nb]:
                continue
            # cheap to hold altitude, dear to climb/dive — otherwise the shortest path
            # swoops to the deck and skims across instead of flying a line worth watching
            ng = g + 1 + (1.2 if d[1] else 0)
            if ng < cost.get(nb, 1e18):
                cost[nb], came[nb] = ng, cur
                heapq.heappush(open_, (ng + h(nb), ng, nb))
    return None


def arc_route(grid, a, b, n=14):
    """Fallback when the voxel search finds no corridor: climb clear of everything between
    the two points, cross, and come back down — which is the move the tour wants anyway
    when it leaves the courtyard ring. Returns world positions, or None if the arc itself
    would clip geometry."""
    a, b = np.asarray(a, float), np.asarray(b, float)
    # highest surface anywhere along the straight line, so the crossing clears the roofs
    tops = []
    for t in np.linspace(0, 1, 40):
        p = a + (b - a) * t
        ix, _, iz = grid.to_idx(p)
        hits = np.flatnonzero(grid.solid[ix, :, iz])
        if len(hits):
            tops.append(grid.lo[1] + (hits[-1] + 0.5) * VOX)
    cruise = max(max(tops, default=a[1]) + 2.5, a[1], b[1])
    keys = [a, np.array([a[0], cruise, a[2]]), np.array([b[0], cruise, b[2]]), b]
    out = []
    for i in range(3):
        for t in np.linspace(0, 1, n // 3, endpoint=False):
            out.append(keys[i] + (keys[i + 1] - keys[i]) * t)
    out.append(b)
    for p in out:
        ix, iy, iz = grid.to_idx(p)
        if grid.solid[ix, iy, iz]:
            return None
    print(f"    arc route over y={cruise:.1f}", flush=True)
    return out[1:-1]


def main():
    ply, pins_path, out_path = sys.argv[1], sys.argv[2], sys.argv[3]
    # An auto-cycling showreel runs forever, so the route has to CLOSE: without a routed
    # return leg the player wraps from the last stop straight to the first, which is the
    # hard cut the whole spline exists to avoid.
    close_loop = "--loop" in sys.argv
    pts = read_ply(ply)
    P = np.stack([pts[:, 0], -pts[:, 1], -pts[:, 2]], 1)
    grid = Grid(P)
    ground0 = float(np.percentile(P[:, 1], 2))
    reach = grid.flyable(grid.free(), ground0)
    centre = P.mean(0)

    pins = json.load(open(pins_path))
    stops = []
    for n, w in enumerate(pins):
        pos = np.array(w["pos"], float)
        q = np.array(w["quat"], float)
        fov = 60
        f, near = fill_of(grid, pos, q)
        if f >= MIN_FILL:
            print(f"#{n} keep as pinned — fill {f:.1%}", flush=True)
        else:
            r = repair(grid, pos, q)
            if not r:
                print(f"#{n} fill {f:.1%} — NO in-place repair found, keeping as-is", flush=True)
            else:
                _, q2, fov2, f2, dpdeg = r
                print(f"#{n} fill {f:.1%} -> {f2:.1%}  position UNCHANGED, "
                      f"pitch {dpdeg:+.0f}°, fov {fov2}°", flush=True)
                q, fov = q2, fov2
        stops.append((pos, q, fov))

    for pos, _, _ in stops:
        grid.open_at(reach, pos, r=2)

    tour = []
    for n, (pos, q, fov) in enumerate(stops):
        if n > 0:
            prev_pos, prev_q, prev_fov = stops[n - 1]
            path = astar(reach, grid.to_idx(prev_pos), grid.to_idx(pos))
            if path:
                mids = [grid.to_world(v) for v in path[4:-4:6]]
                how = f"{len(path)} voxels"
            elif np.linalg.norm(np.asarray(pos) - np.asarray(prev_pos)) < 2.0:
                mids, how = [], "direct (stops nearly co-located)"
            else:
                mids = arc_route(grid, prev_pos, pos) or []
                how = "ARC (no corridor)" if mids else "! NO ROUTE"
            fixed = 0
            for j, vw in enumerate(mids):
                t = (j + 1) / (len(mids) + 1)
                vq, vf, dev = reaim(grid, vw, slerp(prev_q, q, t))
                if dev > 0:
                    fixed += 1
                tour.append({"kind": "via",
                             "pos": [round(float(v), 2) for v in vw],
                             "quat": [round(float(v), 4) for v in vq],
                             "fov": round(prev_fov + (fov - prev_fov) * t, 1),
                             "fill": round(vf, 3)})
            print(f"leg {n-1}->{n}: {how}, {len(mids)} vias ({fixed} re-aimed)", flush=True)
        tour.append({"kind": "stop",
                     "pos": [round(float(v), 2) for v in pos],
                     "quat": [round(float(v), 4) for v in q],
                     "fov": fov})

    if close_loop and len(stops) > 2:
        last_pos, last_q, last_fov = stops[-1]
        first_pos, first_q, first_fov = stops[0]
        path = astar(reach, grid.to_idx(last_pos), grid.to_idx(first_pos))
        mids = [grid.to_world(v) for v in path[4:-4:6]] if path else (
            arc_route(grid, last_pos, first_pos) or [])
        for j, vw in enumerate(mids):
            t = (j + 1) / (len(mids) + 1)
            vq, vf, _ = reaim(grid, vw, slerp(last_q, first_q, t))
            tour.append({"kind": "via", "pos": [round(float(v), 2) for v in vw],
                         "quat": [round(float(v), 4) for v in vq],
                         "fov": round(last_fov + (first_fov - last_fov) * t, 1),
                         "fill": round(vf, 3)})
        # land exactly on the opening pose so the wrap-around is invisible
        tour.append({"kind": "stop", "pos": [round(float(v), 2) for v in first_pos],
                     "quat": [round(float(v), 4) for v in first_q], "fov": first_fov})
        print(f"return leg: {len(mids)} vias, closes the loop on stop 0", flush=True)

    # final check: every stop AND via should be looking at model
    worst = 1.0
    for w in tour:
        f, _ = fill_of(grid, np.array(w["pos"], float), np.array(w["quat"], float),
                       w.get("fov"))
        w["fill"] = round(f, 3)
        worst = min(worst, f)
    json.dump(tour, open(out_path, "w"), indent=1)
    n_stop = sum(1 for w in tour if w["kind"] == "stop")
    print(f"\nwrote {out_path}: {len(tour)} waypoints ({n_stop} stops), worst fill {worst:.1%}",
          flush=True)
    for w in tour:
        if w["kind"] == "stop" or w["fill"] < 0.9:
            print(f"  {w['kind']:4s} {w['pos']} fill {w['fill']:.0%}", flush=True)


main()
