import { useEffect, useRef } from "react";
import { Scene } from "./Scene";
import "./showcase.css";

/**
 * Hero "interaction showcase" — EXPERIMENT (v0). A point cloud that ASSEMBLES into a
 * city as you scroll down (scroll-linked, not autonomous), orbitable by drag. Not wired
 * into the home; preview standalone at /?exp=showcase. The city is currently a
 * surface-sampled procedural stand-in for a real CC0 city model.
 */
export function ShowcaseExperiment() {
  // 1 = assembled (top), 0 = scattered. Scrolling DOWN disperses the city.
  const progress = useRef(1);

  useEffect(() => {
    const onScroll = () => {
      const max = document.documentElement.scrollHeight - window.innerHeight;
      const s = max > 0 ? Math.min(1, Math.max(0, window.scrollY / max)) : 0;
      progress.current = 1 - s; // top → assembled, scroll down → scatter
    };
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  return (
    <div className="sc-root">
      <div className="sc-sticky">
        <Scene progressRef={progress} />
        <div className="sc-hint">scroll to disperse · drag to orbit</div>
      </div>
      {/* scroll runway that drives the assembly progress */}
      <div className="sc-runway" aria-hidden />
    </div>
  );
}
