/** Deterministic checks for the showreel camera state machine (no browser or camera required). */
import assert from "node:assert/strict";
import * as THREE from "three";
import {
  DEFAULT_SCENE_NAVIGATION,
  SceneNavigationController,
  sceneAxis,
  sceneSampleIsFresh,
  type SceneNavigationConfig,
  type SceneNavigationMode,
  type SceneNavigationSample,
} from "../apps/kiosk/src/experiments/spark/sceneNavigation";
import { sceneExploreAxes } from "../apps/kiosk/src/lib/vision/flightInput";
import {
  buildProductionTourCurve,
  inspectCurveInRoam,
  isRoamablePoint,
  roamCell,
  routeTourThroughRoam,
  type RoamVolume,
  type TourWaypoint,
} from "../apps/kiosk/src/experiments/spark/safeTour";
import autoTourJson from "../apps/kiosk/src/experiments/spark/tour.json";
import roamJson from "../apps/kiosk/src/experiments/spark/roam.json";

let checks = 0;
const ok = (condition: unknown, message: string) => {
  assert.ok(condition, message);
  checks += 1;
};

const sample = (
  mode: SceneNavigationMode,
  seq: number,
  at: number,
  dx: number,
  dy: number,
): SceneNavigationSample => ({ sessionId: 1, mode, seq, at, dx, dy });

const config = (overrides: Partial<SceneNavigationConfig> = {}): SceneNavigationConfig => ({
  ...DEFAULT_SCENE_NAVIGATION,
  holdMs: 0,
  flingMinRate: 99,
  ...overrides,
});

const camera = () => {
  const value = new THREE.PerspectiveCamera(60, 16 / 9, 0.1, 100);
  value.position.set(0, 1, 0);
  value.quaternion.identity();
  return value;
};

console.log("\nscene navigation — camera semantics\n");

ok(sceneAxis(0.05, 0.08, 0.75, 1.7) === 0, "movement is quiet inside its deadzone");
ok(sceneAxis(8, 0.08, 0.75, 1.7) === 1, "movement is bounded at full reach");
ok(sceneAxis(-8, 0.08, 0.75, 1.7) === -1, "movement remains symmetric");
ok(sceneSampleIsFresh(900, 1000, 180), "a recent decoded sample is accepted");
ok(!sceneSampleIsFresh(800, 1000, 180), "a stale decoded sample is rejected");
ok(
  sceneExploreAxes(0.5, 0.5).dx === 0 && sceneExploreAxes(0.5, 0.5).dy === 0,
  "the calibrated comfortable centre is neutral in Explore",
);
ok(
  sceneExploreAxes(1, 0).dx === 1 && sceneExploreAxes(1, 0).dy === 1,
  "Explore maps the reachable screen edges to bounded turn/travel axes",
);

{
  const roam: RoamVolume = {
    cell: roamJson.cell,
    min: roamJson.min as [number, number, number],
    dims: roamJson.dims as [number, number, number],
    free: roamJson.free,
  };
  const authored = autoTourJson as unknown as TourWaypoint[];
  ok(
    authored.every((waypoint) => isRoamablePoint(roam, ...waypoint.pos)),
    "every authored tour pose starts in measured free air",
  );
  const routed = routeTourThroughRoam(authored, roam);
  ok(routed.length > authored.length, "blocked between-pose spans receive safe routing vias");
  const curve = buildProductionTourCurve(routed);
  const report = inspectCurveInRoam(curve, roam);
  ok(
    report.ok,
    `every production getPointAt sample is takeover-safe (${report.samples} checked)`,
  );

  const samples = Math.max(1, Math.ceil(curve.getLength() / (roam.cell / 4)));
  let isolated = false;
  for (let i = 0; i <= samples; i += 1) {
    const point = curve.getPointAt(i / samples);
    const cell = roamCell(roam, point.x, point.y, point.z);
    if (!cell) {
      isolated = true;
      break;
    }
    const centre: [number, number, number] = [
      roam.min[0] + (cell[0] + 0.5) * roam.cell,
      roam.min[1] + (cell[1] + 0.5) * roam.cell,
      roam.min[2] + (cell[2] + 0.5) * roam.cell,
    ];
    const hasHorizontalExit = [
      [roam.cell, 0],
      [-roam.cell, 0],
      [0, roam.cell],
      [0, -roam.cell],
    ].some(([dx, dz]) =>
      isRoamablePoint(roam, centre[0] + dx!, centre[1], centre[2] + dz!),
    );
    if (!hasHorizontalExit) {
      isolated = true;
      break;
    }
  }
  ok(!isolated, "no automatic-tour takeover starts in an isolated Explore cell");
}

{
  const cam = camera();
  const nav = new SceneNavigationController(config());
  nav.begin(cam, sample("look", 1, 0, 0, 0));
  nav.update(cam, sample("look", 2, 20, 0.2, 0.1), 1 / 60, () => true);
  const once = cam.quaternion.clone();
  nav.update(cam, sample("look", 2, 20, 0.8, 0.8), 1 / 60, () => true);
  ok(cam.quaternion.angleTo(once) < 1e-9, "one vision sequence is consumed only once");
  nav.update(cam, sample("look", 1, 30, -0.8, -0.8), 1 / 60, () => true);
  ok(cam.quaternion.angleTo(once) < 1e-9, "an out-of-order vision sequence is ignored");
  const away = cam.quaternion.angleTo(new THREE.Quaternion());
  nav.update(cam, sample("look", 3, 40, 0, 0), 1 / 60, () => true);
  const firstReturn = cam.quaternion.angleTo(new THREE.Quaternion());
  ok(firstReturn > 0 && firstReturn < away, "returning to centre converges without a snap");
  for (let i = 0; i < 40; i += 1) {
    nav.update(cam, sample("look", 4 + i, 60 + i * 20, 0, 0), 1 / 60, () => true);
  }
  ok(
    cam.quaternion.angleTo(new THREE.Quaternion()) < 1e-4,
    "look settles back to the frozen grab orientation",
  );
}

{
  const cam = camera();
  cam.quaternion.setFromEuler(new THREE.Euler(-0.12, 0.38, 0.04));
  const clutch = cam.quaternion.clone();
  const nav = new SceneNavigationController(config());
  nav.begin(cam, sample("look", 1, 0, 0, 0));
  for (let i = 1; i <= 20; i += 1) {
    const sign = i % 2 ? 1 : -1;
    nav.update(cam, sample("look", i + 1, i * 20, sign * 0.05, -sign * 0.045), 1 / 60, () => true);
  }
  ok(
    cam.quaternion.angleTo(clutch) < 1e-9,
    "LOOK noise inside the deadzone does not alter the clutch-relative pose",
  );
}

const lookAfterOneSecond = (hz: number) => {
  const cam = camera();
  const nav = new SceneNavigationController(config());
  nav.begin(cam, sample("look", 1, 0, 0, 0));
  for (let i = 1; i <= hz; i += 1) {
    nav.update(cam, sample("look", i + 1, (i * 1000) / hz, 0.32, -0.18), 1 / hz, () => true);
  }
  return cam.quaternion.clone();
};

const look30 = lookAfterOneSecond(30);
const look120 = lookAfterOneSecond(120);
ok(
  look30.angleTo(look120) < 1e-7,
  "LOOK filtering is equivalent at 30Hz and 120Hz decoded-sample rates",
);
ok(
  look30.angleTo(new THREE.Quaternion()) > 0.2,
  "movement beyond the LOOK deadzone produces a real camera response",
);

{
  const cam = camera();
  const nav = new SceneNavigationController(
    config({ flingMinRate: 0.4, flingMaxRate: 2, flingMaxAngle: 0.4 }),
  );
  nav.begin(cam, sample("look", 1, 0, 0, 0));
  nav.update(cam, sample("look", 1, 0, 0, 0), 1 / 60, () => true);
  nav.update(cam, sample("look", 2, 50, 0.1, 0), 1 / 60, () => true);
  nav.update(cam, sample("look", 3, 100, 0.2, 0), 1 / 60, () => true);
  nav.end(cam, "released", 100);
  ok(nav.status.phase === "coast", "a deliberate, direction-consistent sweep may coast");
  const q = cam.quaternion.clone();
  nav.tick(cam, 0.05, 150, () => true);
  ok(cam.quaternion.angleTo(q) > 0, "the bounded look coast advances after release");
}

{
  const cam = camera();
  const nav = new SceneNavigationController(config({ flingMinRate: 0.4 }));
  nav.begin(cam, sample("look", 1, 0, 0, 0));
  nav.update(cam, sample("look", 1, 0, 0, 0), 1 / 60, () => true);
  nav.update(cam, sample("look", 2, 50, 0.15, 0), 1 / 60, () => true);
  nav.update(cam, sample("look", 3, 100, 0.3, 0), 1 / 60, () => true);
  nav.end(cam, "hand-lost", 100);
  ok(nav.status.phase !== "coast", "tracking loss never manufactures inertia");
}

const distanceAfterOneSecond = (hz: number) => {
  const cam = camera();
  const nav = new SceneNavigationController(config({ range: 100 }));
  const s = sample("move", 1, 0, 0, 0.75);
  nav.begin(cam, s);
  for (let i = 0; i < hz; i += 1) nav.update(cam, s, 1 / hz, () => true);
  return cam.position.distanceTo(new THREE.Vector3(0, 1, 0));
};

const d15 = distanceAfterOneSecond(15);
const d30 = distanceAfterOneSecond(30);
const d120 = distanceAfterOneSecond(120);
ok(Math.abs(d15 - d120) < 0.04, "move distance is stable across 15/120Hz render loops");
ok(Math.abs(d30 - d120) < 0.025, "move distance is stable across 30/120Hz render loops");

{
  const cam = camera();
  const nav = new SceneNavigationController(config({ range: 100 }));
  nav.begin(cam, sample("explore", 1, 0, 0, 0));
  for (let i = 1; i <= 60; i += 1) {
    nav.update(cam, sample("explore", i + 1, i * (1000 / 60), 0.35, 0.7), 1 / 60, () => true);
  }
  ok(
    cam.quaternion.angleTo(new THREE.Quaternion()) > 0.1,
    "automatic Explore turns from horizontal open-hand position",
  );
  ok(
    cam.position.distanceTo(new THREE.Vector3(0, 1, 0)) > 0.1,
    "automatic Explore travels from vertical open-hand position",
  );
}

{
  const cam = camera();
  const clutch = cam.quaternion.clone();
  const nav = new SceneNavigationController(config({ range: 100 }));
  nav.begin(cam, sample("explore", 1, 0, 0, 0));
  for (let i = 1; i <= 30; i += 1) {
    nav.update(cam, sample("explore", i + 1, i * 20, 0.04, -0.04), 1 / 60, () => true);
  }
  ok(
    cam.quaternion.angleTo(clutch) < 1e-9 &&
      cam.position.distanceTo(new THREE.Vector3(0, 1, 0)) < 1e-9,
    "automatic Explore remains still inside its centre deadzones",
  );
}

const exploreAfterOneSecond = (hz: number) => {
  const cam = camera();
  const nav = new SceneNavigationController(config({ range: 100 }));
  nav.begin(cam, sample("explore", 1, 0, 0, 0));
  for (let i = 1; i <= hz; i += 1) {
    nav.update(
      cam,
      sample("explore", i + 1, (i * 1000) / hz, 0.42, 0.68),
      1 / hz,
      () => true,
    );
  }
  return cam;
};

{
  const at30 = exploreAfterOneSecond(30);
  const at120 = exploreAfterOneSecond(120);
  ok(
    at30.quaternion.angleTo(at120.quaternion) < 1e-6,
    "automatic Explore turn rate is equivalent at 30Hz and 120Hz",
  );
  ok(
    at30.position.distanceTo(at120.position) < 0.015,
    "automatic Explore travel is equivalent at 30Hz and 120Hz",
  );
}

{
  const cam = camera();
  const nav = new SceneNavigationController(config({ range: 100 }));
  const moving = sample("move", 1, 0, 0.75, 0.75);
  nav.begin(cam, moving);
  for (let i = 0; i < 60; i += 1) {
    nav.update(cam, moving, 1 / 60, (_x, _y, z) => z >= -1e-6);
  }
  ok(nav.status.blocked, "a rejected movement axis reports the collision");
  ok(Math.abs(cam.position.z) < 1e-6, "the blocked axis never enters the model");
  ok(cam.position.x > 0.2, "the unblocked component still slides along the boundary");
}

{
  const cam = camera();
  const nav = new SceneNavigationController(config({ range: 100, returnSpeed: 4 }));
  const moving = sample("move", 1, 0, 0.7, 0.7);
  nav.begin(cam, moving);
  for (let i = 0; i < 45; i += 1) nav.update(cam, moving, 1 / 60, () => true);
  ok(cam.position.distanceTo(new THREE.Vector3(0, 1, 0)) > 0.1, "MOVE changes position");
  nav.end(cam, "released", 750);
  for (let i = 0; i < 600 && nav.status.interacting; i += 1) {
    nav.tick(cam, 1 / 60, 751 + (i * 1000) / 60, () => true);
  }
  ok(!nav.status.interacting, "release returns to the tour in bounded time");
  ok(cam.position.distanceTo(new THREE.Vector3(0, 1, 0)) < 1e-6, "return ends at exact tour pose");
}

console.log(`\n${checks}/${checks} scene-navigation checks passed\n`);
