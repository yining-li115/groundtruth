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
 * Radius of the visitor camera's collision body, in campus world units.
 *
 * The roam grid has 0.45-unit cells. A 0.15-unit sphere gives the camera a meaningful 0.30-unit
 * body while leaving measured clearance along every production tour sample and authored stop.
 * `check:scene` binds that claim to the checked-in tour and roam volume; increasing the radius
 * without enough clearance therefore fails before it can strand a visitor in the scene.
 */
export const PRODUCTION_CAMERA_RADIUS = 0.15;

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

/**
 * Whether a spherical camera body lies wholly inside measured free voxels.
 *
 * A Gaussian splat is not a watertight collision mesh. This deliberately makes no such claim:
 * the checked-in roam volume remains the conservative authority, and any sphere/AABB contact
 * with a blocked or out-of-bounds voxel is rejected. The point predicate above remains available
 * for the offline six-connected routing algorithm, whose nodes are voxel centres.
 */
export function isRoamableSphere(
  volume: RoamVolume,
  x: number,
  y: number,
  z: number,
  radius: number,
): boolean {
  if (!validVolume(volume) || ![x, y, z, radius].every(Number.isFinite) || radius < 0) {
    return false;
  }
  if (radius === 0) return isRoamablePoint(volume, x, y, z);

  const position = [x, y, z] as const;
  // Include the voxel on both sides of an exact grid boundary: tangent contact is still contact.
  const boundaryEpsilon = volume.cell * 1e-9;
  const first = position.map((value, axis) =>
    Math.floor((value - radius - volume.min[axis]! - boundaryEpsilon) / volume.cell),
  );
  const last = position.map((value, axis) =>
    Math.floor((value + radius - volume.min[axis]! + boundaryEpsilon) / volume.cell),
  );
  const radiusSq = radius * radius;

  for (let ix = first[0]!; ix <= last[0]!; ix += 1) {
    for (let iy = first[1]!; iy <= last[1]!; iy += 1) {
      for (let iz = first[2]!; iz <= last[2]!; iz += 1) {
        const cell: Cell = [ix, iy, iz];
        if (cell.some((value, axis) => value < 0 || value >= volume.dims[axis]!)) {
          return false;
        }
        if (volume.free[roamIndex(volume, cell)] === "1") continue;

        let distanceSq = 0;
        for (let axis = 0; axis < 3; axis += 1) {
          const cellMin = volume.min[axis]! + cell[axis]! * volume.cell;
          const cellMax = cellMin + volume.cell;
          const value = position[axis]!;
          const distance =
            value < cellMin ? cellMin - value : value > cellMax ? value - cellMax : 0;
          distanceSq += distance * distance;
        }
        // Contact counts as intersection. The tiny tolerance makes the safety result stable at a
        // mathematically tangent face despite binary floating-point representation.
        if (distanceSq <= radiusSq + 1e-12) return false;
      }
    }
  }
  return true;
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

/**
 * Validate the production camera body along a curve without changing point-based tour routing.
 * Samples are no farther apart than one third of the radius (and never coarser than the legacy
 * point audit), making this a stricter takeover invariant than the render cadence.
 */
export function inspectCameraCurveInRoam(
  curve: THREE.Curve<THREE.Vector3>,
  volume: RoamVolume,
  radius = PRODUCTION_CAMERA_RADIUS,
): CurveRoamReport {
  if (!Number.isFinite(radius) || radius <= 0 || !validVolume(volume)) {
    return { ok: false, samples: 0, firstBlocked: curve.getPointAt(0) };
  }
  const spacing = Math.min(volume.cell / 4, radius / 3);
  const samples = Math.max(1, Math.ceil(curve.getLength() / spacing));
  for (let i = 0; i <= samples; i += 1) {
    const point = curve.getPointAt(i / samples);
    if (!isRoamableSphere(volume, point.x, point.y, point.z, radius)) {
      return { ok: false, samples: samples + 1, firstBlocked: point };
    }
  }
  return { ok: true, samples: samples + 1, firstBlocked: null };
}
