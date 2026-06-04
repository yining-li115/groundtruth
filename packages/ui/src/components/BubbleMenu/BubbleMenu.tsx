import { useState, useRef, useEffect, type CSSProperties } from "react";
import { gsap } from "gsap";
import "./BubbleMenu.css";

export interface BubbleMenuItem {
  label: string;
  ariaLabel?: string;
  /** Playful tilt applied on wide screens (degrees). */
  rotation?: number;
  /** Fired when the pill is chosen; the menu then closes. */
  onClick?: () => void;
  /** Marks the current section — rendered in the selected (black) style. */
  active?: boolean;
}

export interface BubbleMenuProps {
  items: BubbleMenuItem[];
  /** Toggle text when collapsed. */
  menuLabel?: string;
  /** Toggle text when expanded. */
  closeLabel?: string;
  menuAriaLabel?: string;
  /** Fixed = follows the viewport (good for a kiosk overlay); else absolute. */
  useFixedPosition?: boolean;
  animationEase?: string;
  animationDuration?: number;
  staggerDelay?: number;
  onMenuClick?: (open: boolean) => void;
  className?: string;
  style?: CSSProperties;
}

const prefersReducedMotion = (): boolean =>
  typeof window !== "undefined" &&
  window.matchMedia("(prefers-reduced-motion: reduce)").matches;

/**
 * Bubble-style navigation menu — adapted from React Bits' BubbleMenu, re-implemented
 * from scratch on our design tokens (CLAUDE.md rule 9): no imported colors, no logo
 * bubble. The GSAP open/close animation is preserved; only the text and colors changed.
 * Collapsed it shows a "MENU" pill; expanding reveals the items as big rounded pills.
 * Hover and the current/selected item are uniformly black; everything else uses tokens.
 */
export function BubbleMenu({
  items,
  menuLabel = "MENU",
  closeLabel = "CLOSE",
  menuAriaLabel = "Toggle menu",
  useFixedPosition = false,
  animationEase = "back.out(1.5)",
  animationDuration = 0.5,
  staggerDelay = 0.12,
  onMenuClick,
  className,
  style,
}: BubbleMenuProps) {
  const [isMenuOpen, setIsMenuOpen] = useState(false);
  const [showOverlay, setShowOverlay] = useState(false);

  const overlayRef = useRef<HTMLDivElement | null>(null);
  const bubblesRef = useRef<Array<HTMLElement | null>>([]);
  const labelRefs = useRef<Array<HTMLElement | null>>([]);

  const containerClassName = [
    "gt-bubble-menu",
    useFixedPosition ? "fixed" : "absolute",
    className,
  ]
    .filter(Boolean)
    .join(" ");

  const handleToggle = () => {
    const next = !isMenuOpen;
    if (next) setShowOverlay(true);
    setIsMenuOpen(next);
    onMenuClick?.(next);
  };

  const closeAndRun = (run?: () => void) => {
    setIsMenuOpen(false);
    onMenuClick?.(false);
    run?.();
  };

  useEffect(() => {
    const overlay = overlayRef.current;
    const bubbles = bubblesRef.current.filter((b): b is HTMLElement => Boolean(b));
    const labels = labelRefs.current.filter((l): l is HTMLElement => Boolean(l));
    if (!overlay || !bubbles.length) return;

    const reduce = prefersReducedMotion();

    if (isMenuOpen) {
      gsap.set(overlay, { display: "flex" });
      gsap.killTweensOf([...bubbles, ...labels]);
      if (reduce) {
        gsap.set(bubbles, { scale: 1, transformOrigin: "50% 50%" });
        gsap.set(labels, { y: 0, autoAlpha: 1 });
        return;
      }
      gsap.set(bubbles, { scale: 0, transformOrigin: "50% 50%" });
      gsap.set(labels, { y: 24, autoAlpha: 0 });
      bubbles.forEach((bubble, i) => {
        const delay = i * staggerDelay + gsap.utils.random(-0.05, 0.05);
        const tl = gsap.timeline({ delay });
        tl.to(bubble, { scale: 1, duration: animationDuration, ease: animationEase });
        const label = labels[i];
        if (label) {
          tl.to(
            label,
            { y: 0, autoAlpha: 1, duration: animationDuration, ease: "power3.out" },
            `-=${animationDuration * 0.9}`,
          );
        }
      });
    } else if (showOverlay) {
      gsap.killTweensOf([...bubbles, ...labels]);
      const done = () => {
        gsap.set(overlay, { display: "none" });
        setShowOverlay(false);
      };
      if (reduce) {
        gsap.set(labels, { y: 24, autoAlpha: 0 });
        gsap.set(bubbles, { scale: 0 });
        done();
        return;
      }
      gsap.to(labels, { y: 24, autoAlpha: 0, duration: 0.2, ease: "power3.in" });
      gsap.to(bubbles, { scale: 0, duration: 0.2, ease: "power3.in", onComplete: done });
    }
  }, [isMenuOpen, showOverlay, animationEase, animationDuration, staggerDelay]);

  useEffect(() => {
    const handleResize = () => {
      if (!isMenuOpen) return;
      const bubbles = bubblesRef.current.filter((b): b is HTMLElement => Boolean(b));
      const isDesktop = window.innerWidth >= 900;
      bubbles.forEach((bubble, i) => {
        const item = items[i];
        if (bubble && item) gsap.set(bubble, { rotation: isDesktop ? item.rotation ?? 0 : 0 });
      });
    };
    window.addEventListener("resize", handleResize);
    return () => window.removeEventListener("resize", handleResize);
  }, [isMenuOpen, items]);

  return (
    <>
      <nav className={containerClassName} style={style} aria-label="Main navigation">
        <button
          type="button"
          className={`gt-bubble gt-toggle ${isMenuOpen ? "open" : ""}`}
          onClick={handleToggle}
          aria-label={menuAriaLabel}
          aria-pressed={isMenuOpen}
        >
          {isMenuOpen ? closeLabel : menuLabel}
        </button>
      </nav>

      {showOverlay && (
        <div
          ref={overlayRef}
          className={`gt-bubble-menu-items ${useFixedPosition ? "fixed" : "absolute"}`}
          aria-hidden={!isMenuOpen}
        >
          <ul className="gt-pill-list" role="menu" aria-label="Menu links">
            {items.map((item, idx) => (
              <li key={idx} role="none" className="gt-pill-col">
                <button
                  type="button"
                  role="menuitem"
                  aria-label={item.ariaLabel || item.label}
                  aria-current={item.active || undefined}
                  className={`gt-pill-link ${item.active ? "active" : ""}`}
                  style={{ "--item-rot": `${item.rotation ?? 0}deg` } as CSSProperties}
                  onClick={() => closeAndRun(item.onClick)}
                  ref={(el) => {
                    bubblesRef.current[idx] = el;
                  }}
                >
                  <span
                    className="gt-pill-label"
                    ref={(el) => {
                      labelRefs.current[idx] = el;
                    }}
                  >
                    {item.label}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </>
  );
}
