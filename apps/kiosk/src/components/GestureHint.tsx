import { useEffect, useState } from "react";
import { useKioskStore } from "../state/store";
import "./gestureHint.css";

/**
 * The one thing a touchless screen cannot do without: telling people what their hands can do.
 *
 * There is no manual at a kiosk and nobody to ask. A visitor gets a few seconds of curiosity,
 * and if the screen has not explained itself by then they walk on — so the grammar is stated
 * plainly the moment someone starts, and then gets out of the way. It comes back when a new
 * visitor arrives, because for them it is the first time.
 *
 * It does NOT leave, though — it recedes. The first version hid itself after a few seconds,
 * on the theory that instructions which never go away stop being read. What actually happened
 * is that someone using the thing could not find out what the gestures were: by the time they
 * had a question, the answer had already gone. A wall of content beats a wall of help, but a
 * faint permanent line beats an interaction nobody can operate.
 */

/** How long the legend stays at full strength before receding. */
const BRIGHT_MS = 9000;

export function GestureHint() {
  const entered = useKioskStore((s) => s.entered);
  const handPresent = useKioskStore((s) => s.handPresent);
  const pinchTrouble = useKioskStore((s) => s.pinchTrouble);
  const [bright, setBright] = useState(false);

  useEffect(() => {
    if (!entered || !handPresent) return;
    setBright(true);
    const id = setTimeout(() => setBright(false), BRIGHT_MS);
    return () => clearTimeout(id);
  }, [entered, handPresent]);

  if (!entered) return null;

  // The pinch has been tried and is not being read. Saying the same thing again, in the same
  // faint grey, would be the screen repeating itself at someone it has already failed.
  if (pinchTrouble) {
    return (
      <div className="gh-bar is-on is-bright is-trouble" role="status" aria-live="polite">
        <span>
          Not reading that pinch — <b>close your whole hand into a fist</b> instead
        </span>
      </div>
    );
  }

  return (
    <div
      className={`gh-bar ${handPresent ? "is-on" : ""} ${bright ? "is-bright" : ""}`}
      role="status"
      aria-live="polite"
    >
      <span>
        <b>Make a fist</b> (or pinch) — hold briefly — to click
      </span>
      <span className="gh-sep" />
      <span>
        <b>Hold it</b> and push the page up or down to scroll
      </span>
    </div>
  );
}
