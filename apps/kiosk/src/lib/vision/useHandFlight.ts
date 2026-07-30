import { useEffect, useRef, useState } from "react";
import { JOINT, VisionEngine, extendedFingers, type Landmark } from "./mediapipe";

/**
 * Webcam hand tracking → flight controls for the campus showreel.
 *
 * Three gestures, and no more — every extra one is another thing a passer-by has to be told:
 *
 *   ☝ INDEX FINGER    move your hand → slide left/right and up/down
 *   ✌ INDEX + MIDDLE  move your hand → turn left/right, fly forward/back
 *   🖐 OPEN PALM      —              → stop
 *
 *   No hands for a while             → the tour takes back over.
 *
 * Forward/back rides on the two-finger gesture rather than a thumb-and-index pinch. The pinch
 * was the obvious mapping and it does not work in practice: the aperture spans a couple of
 * centimetres, so tracking noise and signal sit at the same scale, and the thumb is the least
 * reliably tracked digit of the five. Moving a whole hand gives half a frame to work with —
 * the finger pose only SELECTS the action, it never supplies the value.
 *
 * Directions are latched (-1/0/1) rather than proportional to how far the hand is from
 * centre: creeping along a façade would otherwise mean holding a hand hovering exactly at the
 * edge of the deadzone, which nobody can do steadily. Holding a key doesn't work that way.
 *
 * Output is INTENT, not position: `dolly` and `strafe` are velocities in [-1, 1] that the
 * camera loop integrates. That keeps the mapping stable when tracking drops a frame — a lost
 * hand means "stop", never a jump.
 *
 * ASSET HOSTING: the MediaPipe WASM + model still come from a CDN (see `mediapipe.ts`) and
 * must be self-hosted before the kiosk runs offline (architecture §8).
 */

export type HandStatus = "idle" | "loading" | "running" | "error";



/**
 * Panning is a DIRECTION, not an amount. Mapping hand offset to speed proportionally means
 * the only way to creep along a façade is to hold the hand hovering just past the deadzone,
 * which nobody can do steadily. Holding a key doesn't work that way: it moves at one
 * comfortable pace until you let go, and that is what reads as "browsing".
 *
 * Two thresholds rather than one so the direction doesn't chatter when a hand sits near the
 * boundary: it takes ON to start moving, and dropping below OFF to stop.
 */
const ON = 0.11; // fraction of the frame from centre that starts moving
const OFF = 0.07; // ...and how far back toward centre stops it

const ENTER_MS = 350; // hand must persist this long to count as a visitor (anti-flicker)
// Long enough that a visitor can drop their hand, look at what they framed, and pick up where
// they left off — a short timeout snatches the camera back mid-thought.
const LEAVE_MS = 5000;


/** Live hand-driven intent. Mutated in place so the render loop can read it without re-rendering. */
export interface HandFlight {
  /** a hand is being tracked and has persisted long enough to trust */
  present: boolean;
  /** fly direction: −1 pull back, 0 hold, +1 push in */
  dolly: number;
  /** what the hands are currently asking for — drives the on-screen hint too */
  mode: "slide" | "look" | "idle" | "none";
  /** which fingers are out on the leading hand, thumb→pinky (for the skeleton overlay) */
  fingers: boolean[];
  /** turn direction: −1 left, 0 hold, +1 right */
  yaw: number;
  /** slide direction: −1 left, 0 hold, +1 right */
  strafe: number;
  /** rise direction: −1 down, 0 hold, +1 up */
  lift: number;
  /** how many hands are being tracked */
  handCount: number;
  /** every tracked hand's 21 points, normalised to the frame — for drawing the skeletons */
  hands: Landmark[][];
  gesture: string;
}

export function useHandFlight(enabled = true) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [status, setStatus] = useState<HandStatus>("idle");
  const [error, setError] = useState<string | null>(null);
  /** the loop writes this every frame; consumers read it without causing renders */
  const flight = useRef<HandFlight>({
    present: false,
    mode: "none",
    fingers: [],
    dolly: 0,
    yaw: 0,
    strafe: 0,
    lift: 0,
    handCount: 0,
    hands: [],
    gesture: "None",
  });
  /** a coarse copy for React (presence only) so UI can react without a per-frame render */
  const [present, setPresent] = useState(false);

  useEffect(() => {
    if (!enabled) return;
    let raf = 0;
    let stopped = false;
    let stream: MediaStream | null = null;
    const engine = new VisionEngine();
    const video = videoRef.current;
    if (!video) return;

    let lastTs = 0;
    let seenSince = 0; // first frame of the current run of hand-present frames
    let goneSince = 0;
    // latched directions, so none of them chatters while a hand sits on a threshold
    const dir = { strafe: 0, lift: 0, yaw: 0, dolly: 0 };
    /** latch with hysteresis: needs ON to start, and a fall back below OFF to stop */
    const latch = (prev: number, off: number) =>
      Math.abs(off) > ON ? Math.sign(off) : Math.abs(off) < OFF ? 0 : prev;

    (async () => {
      try {
        setStatus("loading");
        // navigator.mediaDevices only exists in SECURE contexts. Opening the kiosk on a LAN
        // IP hides the camera API entirely, so say that rather than throwing a TypeError.
        if (!navigator.mediaDevices?.getUserMedia) {
          throw new Error(
            "camera API unavailable — open via http://localhost:5173 (or HTTPS); " +
              "insecure http://<LAN-IP> origins block the webcam",
          );
        }
        stream = await navigator.mediaDevices.getUserMedia({
          video: { width: 640, height: 480, facingMode: "user" },
          audio: false,
        });
        if (stopped) return;
        video.srcObject = stream;
        await video.play();
        await engine.load();
        if (stopped) return;
        setStatus("running");

        const tick = () => {
          if (stopped) return;
          raf = requestAnimationFrame(tick);
          if (video.readyState < 2) return;

          let ts = performance.now(); // MediaPipe VIDEO mode needs strictly increasing stamps
          if (ts <= lastTs) ts = lastTs + 1;
          lastTs = ts;

          const hands = engine.process(video, ts).hands;
          const f = flight.current;
          const now = performance.now();

          if (!hands.length) {
            if (!goneSince) goneSince = now;
            seenSince = 0;
            if (now - goneSince > LEAVE_MS && f.present) {
              f.present = false;
              setPresent(false);
            }
            // decay to a stop rather than cutting: a dropped frame shouldn't jolt the camera
            f.dolly = 0;
            dir.strafe = dir.lift = dir.yaw = dir.dolly = 0;
            f.strafe = f.lift = f.yaw = f.dolly = 0;
            f.mode = "none";
            f.fingers = [];
            f.hands = [];
            f.handCount = 0;
            return;
          }

          goneSince = 0;
          if (!seenSince) seenSince = now;
          if (now - seenSince > ENTER_MS && !f.present) {
            f.present = true;
            setPresent(true);
          }

          let dolly = 0;

          // --- where the hands sit in frame. Mirror x: the webcam view is flipped, so a
          // hand moved to YOUR right has to send the camera right, not left. ---
          const midX =
            1 - hands.reduce((sum, h2) => sum + h2.landmarks[JOINT.wrist]!.x, 0) / hands.length;
          const midY =
            hands.reduce((sum, h2) => sum + h2.landmarks[JOINT.wrist]!.y, 0) / hands.length;
          const offX = midX - 0.5;
          const offY = 0.5 - midY; // screen y grows downward; up should mean up

          // --- fingers pick the action, hand position supplies the value ---
          const fingers = extendedFingers(hands[0]!.landmarks);
          const others = fingers[2] || fingers[3] || fingers[4];
          const indexOnly = fingers[1] && !others;
          const twoUp = fingers[1] && fingers[2] && !fingers[3] && !fingers[4];

          let mode: "slide" | "look" | "idle";
          if (twoUp) mode = "look";
          else if (indexOnly) mode = "slide";
          else mode = "idle"; // an open palm — or anything else — asks for nothing


          dir.strafe = dir.lift = dir.yaw = dir.dolly = 0;
          if (mode === "slide") {
            dir.strafe = latch(dir.strafe, offX);
            dir.lift = latch(dir.lift, offY);
          } else if (mode === "look") {
            dir.yaw = latch(dir.yaw, offX);
            dolly = latch(dir.dolly, offY); // hand up = fly in, down = pull back
            dir.dolly = dolly;
          }

          f.dolly = dolly; // a direction — the camera loop ramps it
          // directions only — the camera loop ramps them, which is what makes a held
          // position feel like a held key rather than a twitch
          f.strafe = dir.strafe;
          f.lift = dir.lift;
          f.yaw = dir.yaw;
          f.mode = mode;
          f.fingers = fingers;
          f.handCount = hands.length;
          f.hands = hands.map((hnd) => hnd.landmarks);
          f.gesture = hands[0]!.label;
        };
        raf = requestAnimationFrame(tick);
      } catch (e) {
        if (stopped) return;
        setError(e instanceof Error ? e.message : String(e));
        setStatus("error");
      }
    })();

    return () => {
      stopped = true;
      cancelAnimationFrame(raf);
      engine.close();
      stream?.getTracks().forEach((t) => t.stop());
      if (video) video.srcObject = null;
      flight.current.present = false;
      flight.current.hands = [];
    };
  }, [enabled]);

  return { videoRef, status, error, flight, present };
}
