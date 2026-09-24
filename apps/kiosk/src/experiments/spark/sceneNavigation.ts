import * as THREE from "three";
import type { SceneEndReason, SceneMode } from "../../lib/vision/flightInput";

/** Production uses `explore`; `look`/`move` remain useful for the scene-authoring tool. */
export type SceneNavigationMode = SceneMode;

export interface SceneNavigationSample {
  sessionId: number;
  seq: number;
  mode: SceneNavigationMode;
  /** +x is visitor-right, +y is up; Explore receives calibrated centre-relative axes. */
  dx: number;
  dy: number;
  at: number;
}

export interface SceneNavigationConfig {
  /** radians per unit of grip-relative hand travel */
  yawGain: number;
  pitchGain: number;
  /** palm-span units ignored around the frozen grip origin */
  lookDeadzone: number;
  /** seconds; decoded-sample low-pass, independent of the UI pointer filter */
  lookFilterTau: number;
  /** absolute elevation limit; roll is inherited from the composed tour pose */
  pitchLimit: number;
  /** maximum automatic-Explore turn rate in radians per second */
  exploreYawRate: number;
  moveDeadzone: number;
  moveFullScale: number;
  moveExponent: number;
  strafeSpeed: number;
  dollySpeed: number;
  accelerationTau: number;
  range: number;
  holdMs: number;
  returnSpeed: number;
  returnTurnRate: number;
  maxPhysicsStep: number;
  /** maximum world-space gap between collision samples; production keeps this at radius / 3 */
  maxCollisionStep: number;
  maxReturnStep: number;
  flingWindowMs: number;
  flingMinRate: number;
  flingMaxRate: number;
  flingTau: number;
  flingMaxAngle: number;
}

export const DEFAULT_SCENE_NAVIGATION: SceneNavigationConfig = {
  yawGain: 2.4,
  pitchGain: 1.6,
  lookDeadzone: 0.055,
  lookFilterTau: 0.07,
  pitchLimit: THREE.MathUtils.degToRad(38),
  exploreYawRate: 0.72,
  moveDeadzone: 0.08,
  moveFullScale: 0.75,
  moveExponent: 1.7,
  strafeSpeed: 0.8,
  dollySpeed: 1,
  accelerationTau: 0.22,
  range: 12,
  holdMs: 1800,
  returnSpeed: 1.35,
  returnTurnRate: 0.75,
  maxPhysicsStep: 1 / 120,
  maxCollisionStep: 0.05,
  maxReturnStep: 0.08,
  flingWindowMs: 140,
  flingMinRate: 0.7,
  flingMaxRate: 1.25,
  flingTau: 0.55,
  flingMaxAngle: 0.5,
};

export type SceneNavigationPhase = "idle" | "grab" | "coast" | "hold" | "return";

export interface SceneNavigationStatus {
  phase: SceneNavigationPhase;
  interacting: boolean;
  blocked: boolean;
  sessionId: number;
}

const WORLD_UP = new THREE.Vector3(0, 1, 0);
const CAMERA_FORWARD = new THREE.Vector3(0, 0, -1);

const finite = (n: number) => (Number.isFinite(n) ? n : 0);

/** Remove only the noise around the clutch origin, without quantising useful travel. */
const lookDeadband = (value: number, deadzone: number): number => {
  const v = finite(value);
  const d = Math.max(0, finite(deadzone));
  return Math.abs(v) <= d ? 0 : Math.sign(v) * (Math.abs(v) - d);
};

/** Continuous joystick curve: quiet at rest, precise near centre, bounded at full reach. */
export function sceneAxis(
  value: number,
  deadzone: number,
  fullScale: number,
  exponent: number,
): number {
  const a = Math.abs(finite(value));
  if (a <= deadzone) return 0;
  const width = Math.max(1e-6, fullScale - deadzone);
  const t = THREE.MathUtils.clamp((a - deadzone) / width, 0, 1);
  return Math.sign(value) * t ** exponent;
}

/** Reject stale input rather than integrating the last direction after tracking stops. */
export function sceneSampleIsFresh(
  freshAt: number,
  now: number,
  ttlMs: number,
): boolean {
  return Number.isFinite(freshAt) && freshAt <= now + 1 && now - freshAt <= ttlMs;
}

type ScenePoint = Readonly<{ x: number; y: number; z: number }>;

/**
 * Check every bounded subdivision of a camera movement, including both endpoints.
 *
 * Render time is already divided by `maxPhysicsStep`, but that alone stops being a spatial
 * guarantee if a speed is tuned upward. This pure sweep caps the actual distance between
 * collision queries, so a long/high-speed frame cannot jump from one free side of a voxel to the
 * other without asking the collision volume about the path between them.
 */
export function sweptSegmentIsRoamable(
  from: ScenePoint,
  to: ScenePoint,
  maxStep: number,
  isRoamable: (x: number, y: number, z: number) => boolean,
): boolean {
  const values = [from.x, from.y, from.z, to.x, to.y, to.z, maxStep];
  if (!values.every(Number.isFinite) || maxStep <= 0) return false;
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const dz = to.z - from.z;
  const distance = Math.hypot(dx, dy, dz);
  const steps = Math.max(1, Math.ceil(distance / maxStep));
  for (let i = 0; i <= steps; i += 1) {
    const t = i / steps;
    if (!isRoamable(from.x + dx * t, from.y + dy * t, from.z + dz * t)) return false;
  }
  return true;
}

/**
 * Camera-side state machine for the Gaussian showreel.
 *
 * It owns camera mathematics only. Gesture ownership and UI/scene routing are decided before
 * this class sees a sample. That separation is what guarantees a cursor hover can never start
 * a flight and a lost observation can never masquerade as a release.
 */
export class SceneNavigationController {
  private readonly cfg: SceneNavigationConfig;
  private phase: SceneNavigationPhase = "idle";
  private sessionId = 0;
  private mode: SceneNavigationMode = "look";
  private blocked = false;
  private lastSeq = -1;

  /** The exact composed tour pose to which this interaction eventually returns. */
  private readonly tourPos = new THREE.Vector3();
  private readonly tourQuat = new THREE.Quaternion();
  /** Pose at the beginning of the current clutch; deltas are always recomputed from this. */
  private readonly grabPos = new THREE.Vector3();
  private readonly grabQuat = new THREE.Quaternion();
  private grabPitch = 0;

  private strafeVelocity = 0;
  private dollyVelocity = 0;
  private desiredStrafe = 0;
  private desiredDolly = 0;
  private turnVelocity = 0;
  private desiredTurn = 0;
  private angularVelocity = 0;
  private coastAngle = 0;
  private holdUntil = 0;
  private returnIndex = -1;
  private filteredLookX = 0;
  private filteredLookY = 0;
  private lastLookAt = 0;
  private readonly breadcrumbs: THREE.Vector3[] = [];
  private readonly lookHistory: Array<{ at: number; dx: number; seq: number }> = [];

  private readonly qYaw = new THREE.Quaternion();
  private readonly qPitch = new THREE.Quaternion();
  private readonly forward = new THREE.Vector3();
  private readonly right = new THREE.Vector3();
  private readonly step = new THREE.Vector3();
  private readonly candidate = new THREE.Vector3();

  constructor(config: SceneNavigationConfig = DEFAULT_SCENE_NAVIGATION) {
    this.cfg = { ...config };
  }

  get status(): SceneNavigationStatus {
    return {
      phase: this.phase,
      interacting: this.phase !== "idle",
      blocked: this.blocked,
      sessionId: this.sessionId,
    };
  }

  /** A new clutch may interrupt hold/coast/return, but never changes the original tour anchor. */
  begin(camera: THREE.PerspectiveCamera, sample: SceneNavigationSample): void {
    if (this.phase === "idle") {
      this.tourPos.copy(camera.position);
      this.tourQuat.copy(camera.quaternion).normalize();
      this.breadcrumbs.length = 0;
      this.breadcrumbs.push(camera.position.clone());
    } else if (this.phase === "return") {
      // We are between `returnIndex + 1` and `returnIndex`. Preserve only the portion that is
      // still a proven path to the tour, then make the current safe pose its new endpoint.
      this.breadcrumbs.splice(Math.max(1, this.returnIndex + 1));
      this.pushBreadcrumb(camera.position, true);
    } else {
      this.pushBreadcrumb(camera.position, true);
    }

    this.phase = "grab";
    this.sessionId = sample.sessionId;
    this.mode = sample.mode;
    this.lastSeq = -1;
    this.blocked = false;
    this.strafeVelocity = 0;
    this.dollyVelocity = 0;
    this.desiredStrafe = 0;
    this.desiredDolly = 0;
    this.turnVelocity = 0;
    this.desiredTurn = 0;
    this.angularVelocity = 0;
    this.coastAngle = 0;
    this.filteredLookX = 0;
    this.filteredLookY = 0;
    this.lastLookAt = sample.at;
    this.lookHistory.length = 0;
    this.grabPos.copy(camera.position);
    this.grabQuat.copy(camera.quaternion).normalize();
    this.grabPitch = Math.asin(
      THREE.MathUtils.clamp(
        this.forward.copy(CAMERA_FORWARD).applyQuaternion(this.grabQuat).normalize().y,
        -1,
        1,
      ),
    );
  }

  /** Consume a decoded vision sample at most once; render frames in between simply hold pose. */
  update(
    camera: THREE.PerspectiveCamera,
    sample: SceneNavigationSample,
    dt: number,
    isRoamable: (x: number, y: number, z: number) => boolean,
  ): void {
    if (this.phase !== "grab" || sample.sessionId !== this.sessionId) return;
    // Camera results can arrive out of order when an inference finishes after a newer frame.
    // `!==` would let that older displacement rewind the camera; only a strictly newer
    // decoded sequence may change the clutch target.
    const isNewSample = sample.seq > this.lastSeq;
    if (isNewSample) this.lastSeq = sample.seq;
    this.blocked = false;

    if (this.mode === "look") {
      if (isNewSample) this.updateLook(camera, sample);
      return;
    }

    if (this.mode === "explore") {
      // A kiosk visitor should not have to operate a mode switch before the model responds.
      // One open hand therefore supplies the two controls needed for ground-plane exploration:
      // its position relative to calibrated screen centre is a joystick — left/right turns the
      // view, while up/down travels along the new heading. Both axes have a neutral deadzone,
      // so holding the comfortable centre is a real, stable stop.
      if (isNewSample) {
        this.desiredTurn =
          -sceneAxis(
            sample.dx,
            this.cfg.moveDeadzone,
            this.cfg.moveFullScale,
            this.cfg.moveExponent,
          ) * this.cfg.exploreYawRate;
        this.desiredStrafe = 0;
        this.desiredDolly =
          sceneAxis(
            sample.dy,
            this.cfg.moveDeadzone,
            this.cfg.moveFullScale,
            this.cfg.moveExponent,
          ) * this.cfg.dollySpeed;
      }
      this.integrateDesiredMove(camera, dt, isRoamable, true);
      return;
    }

    // MOVE is a clutch-relative two-axis joystick. The sample changes at camera cadence, but
    // velocity is integrated over its real elapsed time using bounded substeps.
    if (isNewSample) {
      this.desiredStrafe =
        sceneAxis(
          sample.dx,
          this.cfg.moveDeadzone,
          this.cfg.moveFullScale,
          this.cfg.moveExponent,
        ) * this.cfg.strafeSpeed;
      this.desiredDolly =
        sceneAxis(
          sample.dy,
          this.cfg.moveDeadzone,
          this.cfg.moveFullScale,
          this.cfg.moveExponent,
        ) * this.cfg.dollySpeed;
    }
    this.integrateDesiredMove(camera, dt, isRoamable);
  }

  private integrateDesiredMove(
    camera: THREE.PerspectiveCamera,
    dt: number,
    isRoamable: (x: number, y: number, z: number) => boolean,
    turn = false,
  ): void {
    const safeDt = THREE.MathUtils.clamp(dt, 0, 0.1);
    let remaining = safeDt;
    while (remaining > 1e-6) {
      const h = Math.min(remaining, this.cfg.maxPhysicsStep);
      remaining -= h;
      // Ramp inside the fixed-size substeps. Applying the whole frame's acceleration before
      // every movement step made a 15Hz display jump farther during the first few frames than
      // a 120Hz panel, even though both were integrating one real second.
      const alpha = 1 - Math.exp(-h / Math.max(1e-3, this.cfg.accelerationTau));
      if (turn) {
        this.turnVelocity += (this.desiredTurn - this.turnVelocity) * alpha;
        this.qYaw.setFromAxisAngle(WORLD_UP, this.turnVelocity * h);
        camera.quaternion.premultiply(this.qYaw).normalize();
      }
      this.strafeVelocity += (this.desiredStrafe - this.strafeVelocity) * alpha;
      this.dollyVelocity += (this.desiredDolly - this.dollyVelocity) * alpha;
      this.integrateMove(camera, h, isRoamable);
    }
  }

  /** Only an explicit open-hand release may create a small, bounded look fling. */
  end(
    camera: THREE.PerspectiveCamera,
    reason: SceneEndReason,
    now: number,
    gestureAt = now,
  ): void {
    if (this.phase !== "grab") return;
    this.strafeVelocity = 0;
    this.dollyVelocity = 0;
    this.desiredStrafe = 0;
    this.desiredDolly = 0;
    this.turnVelocity = 0;
    this.desiredTurn = 0;
    this.pushBreadcrumb(camera.position, true);

    if (reason === "released" && this.mode === "look") {
      // History is timestamped on the decoded-camera clock. Use the release observation on
      // that same clock, not a later render frame, or slow inference erases a valid fling.
      this.angularVelocity = this.releaseAngularVelocity(gestureAt);
    } else {
      this.angularVelocity = 0;
    }

    if (Math.abs(this.angularVelocity) >= this.cfg.flingMinRate) {
      this.phase = "coast";
      this.coastAngle = 0;
    } else {
      this.startHold(now, reason === "released");
    }
  }

  /** Advance coast/hold/safe-return while no scene gesture owns the camera. */
  tick(
    camera: THREE.PerspectiveCamera,
    dt: number,
    now: number,
    isRoamable: (x: number, y: number, z: number) => boolean,
  ): void {
    const safeDt = THREE.MathUtils.clamp(dt, 0, 0.1);
    if (this.phase === "coast") {
      const room = Math.max(0, this.cfg.flingMaxAngle - this.coastAngle);
      const angle = Math.sign(this.angularVelocity) * Math.min(room, Math.abs(this.angularVelocity * safeDt));
      if (angle) {
        this.qYaw.setFromAxisAngle(WORLD_UP, angle);
        camera.quaternion.premultiply(this.qYaw).normalize();
        this.coastAngle += Math.abs(angle);
      }
      this.angularVelocity *= Math.exp(-safeDt / Math.max(1e-3, this.cfg.flingTau));
      if (
        Math.abs(this.angularVelocity) < 0.03 ||
        this.coastAngle >= this.cfg.flingMaxAngle - 1e-5
      ) {
        this.angularVelocity = 0;
        this.startHold(now, true);
      }
      return;
    }

    if (this.phase === "hold") {
      if (now >= this.holdUntil) this.startReturn();
      return;
    }

    if (this.phase !== "return") return;
    this.advanceReturn(camera, safeDt, isRoamable);
  }

  /** Hard reset for unmount/load failure. It never creates motion. */
  reset(): void {
    this.phase = "idle";
    this.sessionId = 0;
    this.lastSeq = -1;
    this.blocked = false;
    this.strafeVelocity = 0;
    this.dollyVelocity = 0;
    this.desiredStrafe = 0;
    this.desiredDolly = 0;
    this.turnVelocity = 0;
    this.desiredTurn = 0;
    this.angularVelocity = 0;
    this.filteredLookX = 0;
    this.filteredLookY = 0;
    this.lastLookAt = 0;
    this.breadcrumbs.length = 0;
    this.lookHistory.length = 0;
  }

  private updateLook(camera: THREE.PerspectiveCamera, sample: SceneNavigationSample): void {
    const sampleAt = finite(sample.at);
    const elapsed = THREE.MathUtils.clamp((sampleAt - this.lastLookAt) / 1000, 0, 0.25);
    this.lastLookAt = Math.max(this.lastLookAt, sampleAt);
    // `expm1` keeps the coefficient accurate for high-rate decoded samples (for example a
    // 120Hz laptop camera). Because elapsed comes from the sample timestamp rather than the
    // render loop, the same physical motion has the same response on 30Hz and 120Hz panels.
    const alpha = -Math.expm1(-elapsed / Math.max(1e-3, this.cfg.lookFilterTau));
    const targetX = lookDeadband(sample.dx, this.cfg.lookDeadzone);
    const targetY = lookDeadband(sample.dy, this.cfg.lookDeadzone);
    this.filteredLookX += (targetX - this.filteredLookX) * alpha;
    this.filteredLookY += (targetY - this.filteredLookY) * alpha;

    const yaw = -this.filteredLookX * this.cfg.yawGain;
    const requestedPitch = this.filteredLookY * this.cfg.pitchGain;
    const pitch = THREE.MathUtils.clamp(
      requestedPitch,
      -this.cfg.pitchLimit - this.grabPitch,
      this.cfg.pitchLimit - this.grabPitch,
    );
    this.qYaw.setFromAxisAngle(WORLD_UP, yaw);
    this.qPitch.setFromAxisAngle(new THREE.Vector3(1, 0, 0), pitch);
    camera.quaternion.copy(this.qYaw).multiply(this.grabQuat).multiply(this.qPitch).normalize();

    // Fling is derived from exactly what the visitor saw, not from the noisy target hidden
    // behind the filter. That prevents an invisible wrist spike at release creating motion.
    this.lookHistory.push({ at: sample.at, dx: this.filteredLookX, seq: sample.seq });
    const cutoff = sample.at - this.cfg.flingWindowMs * 2;
    while (this.lookHistory.length > 2 && this.lookHistory[0]!.at < cutoff) {
      this.lookHistory.shift();
    }
  }

  private integrateMove(
    camera: THREE.PerspectiveCamera,
    dt: number,
    isRoamable: (x: number, y: number, z: number) => boolean,
  ): void {
    this.forward.copy(CAMERA_FORWARD).applyQuaternion(camera.quaternion);
    this.forward.y = 0;
    if (this.forward.lengthSq() < 1e-8) {
      this.forward.copy(CAMERA_FORWARD).applyQuaternion(this.tourQuat);
      this.forward.y = 0;
    }
    this.forward.normalize();
    this.right.crossVectors(this.forward, WORLD_UP).normalize();
    this.step
      .copy(this.forward)
      .multiplyScalar(this.dollyVelocity * dt)
      .addScaledVector(this.right, this.strafeVelocity * dt);

    let collided = false;
    let blockedX = false;
    let blockedZ = false;
    for (const axis of ["x", "z"] as const) {
      if (Math.abs(this.step[axis]) < 1e-9) continue;
      this.candidate.copy(camera.position);
      this.candidate[axis] += this.step[axis];
      if (
        this.candidate.distanceTo(this.tourPos) > this.cfg.range ||
        !sweptSegmentIsRoamable(
          camera.position,
          this.candidate,
          this.cfg.maxCollisionStep,
          isRoamable,
        )
      ) {
        collided = true;
        if (axis === "x") blockedX = true;
        else blockedZ = true;
        continue;
      }
      camera.position.copy(this.candidate);
      this.pushBreadcrumb(camera.position, false);
    }
    if (collided) {
      // Remove the blocked world-axis component, then project the surviving tangent back into
      // camera-relative controls. This prevents velocity charging against a wall without
      // throwing away the valid component that lets a diagonal command slide along it.
      this.step
        .copy(this.forward)
        .multiplyScalar(this.dollyVelocity)
        .addScaledVector(this.right, this.strafeVelocity);
      if (blockedX) this.step.x = 0;
      if (blockedZ) this.step.z = 0;
      this.dollyVelocity = this.step.dot(this.forward);
      this.strafeVelocity = this.step.dot(this.right);
      this.blocked = true;
    }
  }

  private releaseAngularVelocity(now: number): number {
    const recent = this.lookHistory.filter((p) => now - p.at <= this.cfg.flingWindowMs);
    if (recent.length < 3) return 0;
    const first = recent[0]!;
    const last = recent[recent.length - 1]!;
    const dt = (last.at - first.at) / 1000;
    if (dt < 0.04) return 0;

    let direction = 0;
    for (let i = 1; i < recent.length; i += 1) {
      const d = recent[i]!.dx - recent[i - 1]!.dx;
      if (Math.abs(d) < 0.002) continue;
      const s = Math.sign(d);
      if (direction && s !== direction) return 0;
      direction = s;
    }
    if (!direction) return 0;
    const rate = -((last.dx - first.dx) / dt) * this.cfg.yawGain;
    if (Math.abs(rate) < this.cfg.flingMinRate) return 0;
    return THREE.MathUtils.clamp(rate, -this.cfg.flingMaxRate, this.cfg.flingMaxRate);
  }

  private startHold(now: number, deliberateRelease: boolean): void {
    this.phase = "hold";
    // A cancellation should become safe immediately; a real release leaves a short moment to
    // inspect the framing or re-grip before the unattended tour takes the camera back.
    this.holdUntil = now + (deliberateRelease ? this.cfg.holdMs : 0);
  }

  private startReturn(): void {
    this.phase = "return";
    this.returnIndex = this.breadcrumbs.length - 2;
    this.blocked = false;
  }

  private advanceReturn(
    camera: THREE.PerspectiveCamera,
    dt: number,
    isRoamable: (x: number, y: number, z: number) => boolean,
  ): void {
    let budget = this.cfg.returnSpeed * dt;
    while (budget > 1e-7 && this.returnIndex >= 0) {
      const target = this.breadcrumbs[this.returnIndex]!;
      const distance = camera.position.distanceTo(target);
      if (distance < 1e-6) {
        this.returnIndex -= 1;
        continue;
      }
      const travel = Math.min(distance, budget, this.cfg.maxReturnStep);
      this.candidate.copy(target).sub(camera.position).multiplyScalar(travel / distance).add(camera.position);
      if (
        !sweptSegmentIsRoamable(
          camera.position,
          this.candidate,
          this.cfg.maxCollisionStep,
          isRoamable,
        )
      ) {
        // Breadcrumbs are accepted camera poses; failure here indicates a changed/corrupt roam
        // volume. Stop rather than taking a straight-line shortcut through the model.
        this.blocked = true;
        budget = 0;
        break;
      }
      camera.position.copy(this.candidate);
      budget -= travel;
      if (travel >= distance - 1e-6) this.returnIndex -= 1;
    }

    camera.quaternion.rotateTowards(this.tourQuat, this.cfg.returnTurnRate * dt);
    const positionDone = this.returnIndex < 0 && camera.position.distanceTo(this.tourPos) < 0.005;
    const rotationDone = camera.quaternion.angleTo(this.tourQuat) < 0.005;
    if (!positionDone || !rotationDone) return;

    camera.position.copy(this.tourPos);
    camera.quaternion.copy(this.tourQuat);
    this.phase = "idle";
    this.sessionId = 0;
    this.blocked = false;
    this.breadcrumbs.length = 0;
    this.lookHistory.length = 0;
  }

  private pushBreadcrumb(position: THREE.Vector3, force: boolean): void {
    const last = this.breadcrumbs[this.breadcrumbs.length - 1];
    if (!last || force || last.distanceToSquared(position) > 1e-8) {
      if (!last || last.distanceToSquared(position) > 1e-12) {
        this.breadcrumbs.push(position.clone());
      }
    }
  }
}
