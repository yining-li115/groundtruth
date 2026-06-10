import * as THREE from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import { MeshSurfaceSampler } from "three/examples/jsm/math/MeshSurfaceSampler.js";

/**
 * GLB → point-cloud sampling helpers for the hero showcase.
 *
 * We only ever sample POINTS off these models — we never render the meshes. So textures,
 * normals, UVs, materials and animations are all discarded here; only vertex positions
 * survive. That makes heavy, multi-mesh, mixed-up-axis Sketchfab GLBs usable: we merge,
 * orient, normalize, then surface-sample. Color is applied later (assetColors), never
 * taken from the model.
 */

export type Orient = "y" | "z" | "x";

/**
 * Merge every mesh in a loaded glTF scene into ONE positions-only geometry, baking each
 * mesh's world transform so multi-part models (e.g. a 1200-piece tower) assemble in the
 * right place. Indices are flattened (toNonIndexed) so geometries with/without an index
 * can merge uniformly.
 */
export function mergeSceneGeometry(root: THREE.Object3D): THREE.BufferGeometry {
  root.updateWorldMatrix(true, true);
  const geos: THREE.BufferGeometry[] = [];
  root.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh || !mesh.geometry) return;
    const pos = mesh.geometry.getAttribute("position");
    if (!pos) return;
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", pos.clone());
    if (mesh.geometry.index) g.setIndex(mesh.geometry.index.clone());
    g.applyMatrix4(mesh.matrixWorld);
    geos.push(g.toNonIndexed());
  });
  if (!geos.length) throw new Error("mergeSceneGeometry: no mesh geometry in glTF");
  const merged = mergeGeometries(geos, false);
  if (!merged) throw new Error("mergeSceneGeometry: merge failed");
  return merged;
}

function reorient(geo: THREE.BufferGeometry, up: Orient) {
  // Sketchfab models come in mixed conventions; rotate so the model's "up" becomes +Y.
  if (up === "z") geo.rotateX(-Math.PI / 2);
  else if (up === "x") geo.rotateZ(Math.PI / 2);
}

/**
 * Reorient to Y-up, drop the base to Y=0, center on X/Z, and scale so HEIGHT = 1.
 * Use for things that sit on the ground (buildings, car, tree): the unit-height prototype
 * is then scaled to a target height at placement time.
 */
export function normalizeUpright(geo: THREE.BufferGeometry, up: Orient = "y"): THREE.BufferGeometry {
  reorient(geo, up);
  geo.computeBoundingBox();
  const bb = geo.boundingBox!;
  const cx = (bb.min.x + bb.max.x) / 2;
  const cz = (bb.min.z + bb.max.z) / 2;
  geo.translate(-cx, -bb.min.y, -cz);
  const h = bb.max.y - bb.min.y || 1;
  geo.scale(1 / h, 1 / h, 1 / h);
  return geo;
}

/**
 * Reorient, center fully at the origin, and scale so the LARGEST dimension = 1.
 * Use for things that float (satellite, drone): placement just sets center + span.
 */
export function normalizeCentered(geo: THREE.BufferGeometry, up: Orient = "y"): THREE.BufferGeometry {
  reorient(geo, up);
  geo.computeBoundingBox();
  const bb = geo.boundingBox!;
  const c = new THREE.Vector3();
  bb.getCenter(c);
  geo.translate(-c.x, -c.y, -c.z);
  const m = Math.max(bb.max.x - bb.min.x, bb.max.y - bb.min.y, bb.max.z - bb.min.z) || 1;
  geo.scale(1 / m, 1 / m, 1 / m);
  return geo;
}

/** Max horizontal extent of a normalized geometry — used to fit buildings into a grid cell. */
export function footprint(geo: THREE.BufferGeometry): number {
  geo.computeBoundingBox();
  const bb = geo.boundingBox!;
  return Math.max(bb.max.x - bb.min.x, bb.max.z - bb.min.z) || 1;
}

/**
 * A reusable point emitter: a built surface-sampler over a normalized prototype geometry.
 * Sample any number of points in the prototype's local space, then transform them into the
 * scene with a placement matrix — so one prototype seeds many instances cheaply.
 */
export class Emitter {
  readonly sampler: MeshSurfaceSampler;
  constructor(geo: THREE.BufferGeometry) {
    this.sampler = new MeshSurfaceSampler(new THREE.Mesh(geo)).build();
  }
  /**
   * Sample `n` points, transform by `matrix`, add a little world-space `jitter`, and push
   * (x,y,z…) into `out`. The jitter softens hard model surfaces into dust so the point
   * cloud reads as scanned data rather than a shrink-wrapped mesh.
   */
  emit(n: number, matrix: THREE.Matrix4, out: number[], jitter = 0) {
    const tmp = new THREE.Vector3();
    for (let k = 0; k < n; k++) {
      this.sampler.sample(tmp);
      tmp.applyMatrix4(matrix);
      out.push(
        tmp.x + THREE.MathUtils.randFloatSpread(jitter),
        tmp.y + THREE.MathUtils.randFloatSpread(jitter),
        tmp.z + THREE.MathUtils.randFloatSpread(jitter),
      );
    }
  }
}
