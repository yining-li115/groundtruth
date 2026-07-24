import { useEffect, useState, type CSSProperties } from "react";
import { Logo } from "@groundtruth/ui";
import { KioskQR } from "../../components/KioskQR";
import { SplatStage } from "../splatnav/SplatStage";
import { useHandNav } from "../splatnav/useHandNav";
import { splatNav } from "../splatnav/navState";
import { PuzzleRow, PUZZLE_NEWS } from "../puzzle/PuzzleAccordion";

/**
 * Combined idle showreel (experiment) — a presence-driven state machine with two layouts:
 *
 *   IDLE (no hand): puzzle news auto-plays on the LEFT; the Gaussian-splat campus is SCATTERED
 *     on the RIGHT; a bouncing "raise your hand" prompt sits at the right-centre.
 *   INTERACTING (a hand is tracked): the puzzle slides away to the LEFT, and the campus SNAPS
 *     together and glides to CENTRE so the visitor can focus on turning it by hand.
 *   RESET: 8s with no hand → back to IDLE.
 *
 * A bottom-left switch flips between LIVE (presence-driven, above) and MANUAL (you drive: click
 * the puzzle, and 🖐 open palm scatters / ✊ fist gathers the splat). Preview at /?exp=showreel2.
 */
const ENTER_MS = 450; // hand must persist this long before we treat it as a visitor (anti-flicker)
const LEAVE_MS = 8000; // no hand for this long → reset to idle
const EASE = "cubic-bezier(0.22, 1, 0.36, 1)";
const AIM_RIGHT = 46; // campus off-centre-right while idle
const AIM_CENTRE = 0; // campus centred while interacting

/** per-letter staggered bounce so the prompt doesn't read as stiff */
function Bouncy({ text, style }: { text: string; style?: CSSProperties }) {
  return (
    <span aria-label={text} style={style}>
      {Array.from(text).map((ch, i) => (
        <span
          key={i}
          style={{
            display: "inline-block",
            whiteSpace: "pre",
            animation: "gt-letter-bounce 1.5s ease-in-out infinite",
            animationDelay: `${i * 55}ms`,
          }}
        >
          {ch}
        </span>
      ))}
    </span>
  );
}

export function ShowreelSplit({
  showQR = true,
  onEnter,
}: {
  showQR?: boolean;
  /** when provided, renders an "Enter site" button that clicks straight into the website */
  onEnter?: () => void;
} = {}) {
  const { videoRef, hud, status, error } = useHandNav();
  const [auto, setAuto] = useState(true); // true = LIVE (presence), false = MANUAL (you drive)
  const [interacting, setInteracting] = useState(false);

  // hand present ≥ ENTER_MS → interacting; hand gone ≥ LEAVE_MS → reset (debounced both ways)
  useEffect(() => {
    const t = setTimeout(
      () => setInteracting(hud.handPresent),
      hud.handPresent ? ENTER_MS : LEAVE_MS,
    );
    return () => clearTimeout(t);
  }, [hud.handPresent]);

  // MANUAL → palm/fist drive the scatter; LIVE → presence drives it (a greeting-palm won't scatter)
  useEffect(() => {
    splatNav.gestureControls = !auto;
  }, [auto]);
  useEffect(() => {
    if (auto) splatNav.disperseTarget = interacting ? 0 : 1;
  }, [auto, interacting]);

  // the "focus on the visitor" layout: puzzle away, campus centred. LIVE-mode only.
  const focused = auto && interacting;

  return (
    <div
      className="fixed inset-0 overflow-hidden"
      data-theme="dark"
      style={{ background: "var(--gt-bg)", color: "var(--gt-text-primary)", fontFamily: "var(--font-sans)" }}
    >
      {/* full-bleed splat: scattered-right while idle, assembled-centre while interacting */}
      <SplatStage amp={120} aimShift={focused ? AIM_CENTRE : AIM_RIGHT} />

      {/* hidden webcam feed that drives presence + hand orbit + (manual) gestures */}
      <video ref={videoRef} style={{ display: "none" }} playsInline muted />

      {/* left scrim so the capsules and brand read over the campus */}
      <div
        className="pointer-events-none absolute inset-0"
        style={{
          background:
            "linear-gradient(90deg, var(--gt-bg) 0%, color-mix(in srgb, var(--gt-bg) 78%, transparent) 36%, color-mix(in srgb, var(--gt-bg) 20%, transparent) 60%, transparent 80%)",
          opacity: focused ? 0 : 1,
          transition: `opacity 700ms ${EASE}`,
        }}
      />

      {/* brand — same block/typography as the section pages (SectionLayout), white logo for dark */}
      <div
        className="absolute left-[clamp(2rem,5vw,5rem)] top-[1.6rem] flex items-start gap-4 text-left"
        style={{ opacity: focused ? 0 : 1, transition: `opacity 500ms ${EASE}` }}
      >
        <span
          className="flex flex-col"
          style={{ fontSize: "0.72rem", lineHeight: 1.35, color: "var(--gt-text-secondary)" }}
        >
          <span className="font-bold" style={{ color: "var(--gt-text-primary)" }}>
            Professorship of Photogrammetry and Remote Sensing
          </span>
          <span>TUM School of Engineering and Design</span>
          <span>Technical University of Munich</span>
        </span>
        <Logo variant="white" width={64} height={33} />
      </div>

      {/* puzzle news — left; slides away to the left when focusing on the visitor */}
      <div
        className="absolute left-[clamp(2rem,5vw,5rem)] top-1/2"
        style={{
          transform: focused ? "translate(-130%, -50%)" : "translate(0, -50%)",
          opacity: focused ? 0 : 1,
          transition: `transform 800ms ${EASE}, opacity 700ms ${EASE}`,
          pointerEvents: focused ? "none" : "auto",
        }}
      >
        <PuzzleRow
          items={PUZZLE_NEWS}
          height="min(84vh, 640px)"
          collapsedW={92}
          activeW="min(84vh, 640px)"
          gap={18}
          radius={28}
          align="start"
          autoPlay={auto && !interacting}
        />
      </div>

      {/* right-centre prompt (idle, LIVE) — pushed further right so an expanded puzzle card
          (which grows rightward during auto-play) doesn't overlap it */}
      <div
        className="pointer-events-none absolute left-[85%] top-1/2 max-w-[22rem] -translate-x-1/2 -translate-y-1/2 text-center"
        style={{
          opacity: auto && !interacting ? 1 : 0,
          transition: `opacity 500ms ${EASE}`,
        }}
      >
        <Bouncy text="✋ Raise your hand" style={{ fontSize: "2.4rem", fontWeight: 700, lineHeight: 1.1 }} />
        <div className="mt-3 text-base" style={{ color: "var(--gt-text-secondary)" }}>
          say hello and the campus comes together
        </div>
      </div>

      {/* centred how-to (interacting, LIVE) */}
      <div
        className="pointer-events-none absolute left-1/2 top-[12%] -translate-x-1/2 text-center"
        style={{ opacity: focused ? 1 : 0, transition: `opacity 500ms ${EASE}` }}
      >
        <div className="text-2xl font-bold">✋ Move your hand to turn the campus</div>
        <div className="mt-2 text-base" style={{ color: "var(--gt-text-secondary)" }}>
          step away and it drifts back apart
        </div>
      </div>

      {/* bottom-left mode switch: LIVE (presence) ↔ MANUAL (you drive) */}
      <div className="absolute bottom-[1.5rem] left-[clamp(2rem,5vw,5rem)] flex items-center gap-3">
        <button
          type="button"
          role="switch"
          aria-checked={auto}
          onClick={() => setAuto((a) => !a)}
          className="relative inline-flex h-6 w-11 shrink-0 items-center rounded-full outline-none"
          style={{
            background: auto ? "var(--gt-accent)" : "color-mix(in srgb, var(--gt-text-secondary) 40%, transparent)",
            transition: "background 250ms ease",
            cursor: "pointer",
          }}
        >
          <span
            className="inline-block h-5 w-5 rounded-full"
            style={{
              background: "var(--gt-brand-white)",
              transform: auto ? "translateX(22px)" : "translateX(3px)",
              transition: `transform 250ms ${EASE}`,
            }}
          />
        </button>
        <span className="text-sm" style={{ color: "var(--gt-text-secondary)" }}>
          {auto
            ? "Live — raise a hand to interact"
            : "Manual — click a card · 🖐 scatter · ✊ gather · move to turn"}
        </span>

        {/* hand-tracking health — the camera/model pipeline used to fail SILENTLY; now the
            reason (camera denied/busy, CDN model unreachable, …) is on screen */}
        {status !== "running" && (
          <span
            className="text-sm font-semibold"
            style={{ color: status === "error" ? "var(--gt-accent-orange)" : "var(--gt-text-secondary)" }}
          >
            {status === "error"
              ? `⚠ hand-tracking failed: ${error ?? "unknown"}`
              : "⏳ hand-tracking loading…"}
          </span>
        )}

        {/* direct-enter (skip the QR) — debug only, sits with the Live switch */}
        {onEnter && (
          <button
            type="button"
            onClick={onEnter}
            className="ml-3 rounded-full px-4 py-1.5 text-sm font-semibold"
            style={{ background: "var(--gt-accent)", color: "var(--gt-brand-white)", cursor: "pointer" }}
          >
            Enter site →
          </button>
        )}
      </div>

      {/* the static QR — scan it to take control (enter the site on your phone). In the real app
          it comes from the global <KioskQR> in App, so this is only for the standalone preview. */}
      {showQR && <KioskQR />}
    </div>
  );
}
