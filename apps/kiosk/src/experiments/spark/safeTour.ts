import * as THREE from "three";

export interface RoamVolume {
  cell: number;
  min: readonly [number, number, number];
  dims: readonly [number, number, number];
  free: string;
}

export interface TourWaypoint {
  kind: "stop" | "via";
  pos: [number, number, number];
  quat: [number, number, number, number];
  fov?: number;
}

/**
 * The exact curve constructor used by both the production player and its takeover invariant.
 * Keeping this here prevents a test from validating a subtly different spline type/tension.
 */
export function buildProductionTourCurve(
  waypoints: readonly Pick<TourWaypoint, "pos">[],
): THREE.CatmullRomCurve3 {
  return new THREE.CatmullRomCurve3(
    waypoints.map((waypoint) => new THREE.Vector3(...waypoint.pos)),
    false,
    "centripetal",
    0.5,
  );
}

type Cell = readonly [number, number, number];

function validVolume(volume: RoamVolume): boolean {
  const [nx, ny, nz] = volume.dims;
  return (
    Number.isFinite(volume.cell) &&
    volume.cell > 0 &&
    nx > 0 &&
    ny > 0 &&
    nz > 0 &&
    volume.free.length === nx * ny * nz
  );
}

export function roamCell(volume: RoamVolume, x: number, y: number, z: number): Cell | null {
  if (!validVolume(volume) || ![x, y, z].every(Number.isFinite)) return null;
  const cell: Cell = [
    Math.floor((x - volume.min[0]) / volume.cell),
    Math.floor((y - volume.min[1]) / volume.cell),
    Math.floor((z - volume.min[2]) / volume.cell),
  ];
  return cell.every((value, axis) => value >= 0 && value < volume.dims[axis]!)
    ? cell
    : null;
}

export function roamIndex(volume: RoamVolume, cell: Cell): number {
  return (cell[0] * volume.dims[1] + cell[1]) * volume.dims[2] + cell[2];
}

export function isRoamablePoint(
  volume: RoamVolume,
  x: number,
  y: number,
  z: number,
): boolean {
  const cell = roamCell(volume, x, y, z);
  return cell !== null && volume.free[roamIndex(volume, cell)] === "1";
}

function cellFromIndex(volume: RoamVolume, index: number): Cell {
  const z = index % volume.dims[2];
  const yz = (index - z) / volume.dims[2];
  const y = yz % volume.dims[1];
  return [(yz - y) / volume.dims[1], y, z];
}

function cellCenter(volume: RoamVolume, cell: Cell): [number, number, number] {
  return [
    volume.min[0] + (cell[0] + 0.5) * volume.cell,
    volume.min[1] + (cell[1] + 0.5) * volume.cell,
    volume.min[2] + (cell[2] + 0.5) * volume.cell,
  ];
}

/**
 * Shortest six-connected path through measured free air. Six-connectivity matters here: a
 * diagonal between two corner-touching cells can cut straight through the solid cell between
 * them, while every segment between six-connected cell centres stays inside their union.
 */
function routeCells(volume: RoamVolume, from: Cell, to: Cell): Cell[] {
  const total = volume.free.length;
  const start = roamIndex(volume, from);
  const goal = roamIndex(volume, to);
  if (volume.free[start] !== "1" || volume.free[goal] !== "1") {
    throw new Error("Tour waypoint is outside the measured roam volume");
  }
  if (start === goal) return [from];

  const previous = new Int32Array(total);
  previous.fill(-2);
  previous[start] = -1;
  const queue = new Int32Array(total);
  let head = 0;
  let tail = 0;
  queue[tail++] = start;
  const neighbours: readonly Cell[] = [
    [1, 0, 0],
    [-1, 0, 0],
    [0, 0, 1],
    [0, 0, -1],
    [0, 1, 0],
    [0, -1, 0],
  ];

  while (head < tail && previous[goal] === -2) {
    const current = queue[head++]!;
    const [x, y, z] = cellFromIndex(volume, current);
    for (const [dx, dy, dz] of neighbours) {
      const next: Cell = [x + dx, y + dy, z + dz];
      if (next.some((value, axis) => value < 0 || value >= volume.dims[axis]!)) continue;
      const index = roamIndex(volume, next);
      if (previous[index] !== -2 || volume.free[index] !== "1") continue;
      previous[index] = current;
      queue[tail++] = index;
    }
  }
  if (previous[goal] === -2) throw new Error("Tour waypoints are in disconnected roam regions");

  const reversed: Cell[] = [];
  for (let index = goal; index >= 0; index = previous[index]!) {
    reversed.push(cellFromIndex(volume, index));
  }
  return reversed.reverse();
}

/**
 * Add path-shaping vias between authored poses using the exact occupancy volume MOVE uses.
 * Stops, framing and orientation are preserved; only the between-stop camera path is repaired.
 */
export function routeTourThroughRoam(
  authored: readonly TourWaypoint[],
  volume: RoamVolume,
  defaultFov = 60,
): TourWaypoint[] {
  if (!validVolume(volume)) throw new Error("Invalid roam volume");
  if (authored.length < 2) return authored.map((waypoint) => ({ ...waypoint }));

  const routed: TourWaypoint[] = [{ ...authored[0]! }];
  for (let segment = 0; segment < authored.length - 1; segment += 1) {
    const from = authored[segment]!;
    const to = authored[segment + 1]!;
    const fromCell = roamCell(volume, ...from.pos);
    const toCell = roamCell(volume, ...to.pos);
    if (!fromCell || !toCell) throw new Error("Tour waypoint is outside the roam volume bounds");
    const cells = routeCells(volume, fromCell, toCell);
    const positions = [
      from.pos,
      ...cells.slice(1, -1).map((cell) => cellCenter(volume, cell)),
      to.pos,
    ] as [number, number, number][];
    const cumulative = [0];
    for (let i = 1; i < positions.length; i += 1) {
      cumulative.push(
        cumulative[i - 1]! +
          new THREE.Vector3(...positions[i - 1]!).distanceTo(new THREE.Vector3(...positions[i]!)),
      );
    }
    const totalDistance = cumulative[cumulative.length - 1] || 1;
    const fromQuat = new THREE.Quaternion(...from.quat);
    const toQuat = new THREE.Quaternion(...to.quat);
    const fromFov = from.fov ?? defaultFov;
    const toFov = to.fov ?? defaultFov;

    for (let i = 1; i < positions.length - 1; i += 1) {
      const t = cumulative[i]! / totalDistance;
      const quat = fromQuat.clone().slerp(toQuat, t);
      routed.push({
        kind: "via",
        pos: positions[i]!,
        quat: [quat.x, quat.y, quat.z, quat.w],
        fov: fromFov + (toFov - fromFov) * t,
      });
    }
    routed.push({ ...to });
  }
  return routed;
}

export interface CurveRoamReport {
  ok: boolean;
  samples: number;
  firstBlocked: THREE.Vector3 | null;
}

/** Sample by arc length, exactly as the production player calls `getPointAt`. */
export function inspectCurveInRoam(
  curve: THREE.Curve<THREE.Vector3>,
  volume: RoamVolume,
): CurveRoamReport {
  const samples = Math.max(1, Math.ceil(curve.getLength() / (volume.cell / 4)));
  for (let i = 0; i <= samples; i += 1) {
    const point = curve.getPointAt(i / samples);
    if (!isRoamablePoint(volume, point.x, point.y, point.z)) {
      return { ok: false, samples: samples + 1, firstBlocked: point };
    }
  }
  return { ok: true, samples: samples + 1, firstBlocked: null };
}
