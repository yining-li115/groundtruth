import { StrictMode, Suspense, lazy } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import "./index.css";

// DEV ONLY — camera rescue. Browsers hide getUserMedia (webcam → hand tracking) on
// insecure http://<LAN-IP> origins; in dev the big screen is almost always THIS machine,
// so hop to localhost where the camera works. Opening the kiosk from ANOTHER device on
// purpose? append ?stay=1 to skip the hop. Production (HTTPS) is unaffected.
if (
  import.meta.env.DEV &&
  !window.isSecureContext &&
  /^(\d+\.){3}\d+$/.test(window.location.hostname) &&
  !new URLSearchParams(window.location.search).has("stay")
) {
  const { port, pathname, search, hash } = window.location;
  window.location.replace(`http://localhost:${port}${pathname}${search}${hash}`);
}

// Lazy so each experiment (three.js / gsap) stays out of the main bundle.
const ShowcaseExperiment = lazy(() =>
  import("./experiments/showcase/ShowcaseExperiment").then((m) => ({
    default: m.ShowcaseExperiment,
  })),
);
const GalleryExperiment = lazy(() =>
  import("./experiments/gallery/GalleryExperiment").then((m) => ({
    default: m.GalleryExperiment,
  })),
);
const NewsGridExperiment = lazy(() =>
  import("./experiments/news/NewsGridExperiment").then((m) => ({
    default: m.NewsGridExperiment,
  })),
);
const DepthExperiment = lazy(() =>
  import("./experiments/depth/DepthExperiment").then((m) => ({ default: m.DepthExperiment })),
);
const LiquidExperiment = lazy(() =>
  import("./experiments/liquid/LiquidExperiment").then((m) => ({ default: m.LiquidExperiment })),
);
const PersonDetailExperiment = lazy(() =>
  import("./experiments/people/PersonDetailExperiment").then((m) => ({
    default: m.PersonDetailExperiment,
  })),
);
const LegoExperiment = lazy(() =>
  import("./experiments/lego/LegoExperiment").then((m) => ({ default: m.LegoExperiment })),
);
const CvExperiment = lazy(() =>
  import("./experiments/cv/CvExperiment").then((m) => ({ default: m.CvExperiment })),
);
const SplatViewerExperiment = lazy(() =>
  import("./experiments/splat/SplatViewerExperiment").then((m) => ({
    default: m.SplatViewerExperiment,
  })),
);
const SplatNativeExperiment = lazy(() =>
  import("./experiments/splat/SplatNativeExperiment").then((m) => ({
    default: m.SplatNativeExperiment,
  })),
);
const SplatNavExperiment = lazy(() =>
  import("./experiments/splatnav/SplatNavExperiment").then((m) => ({
    default: m.SplatNavExperiment,
  })),
);
const PuzzleAccordionExperiment = lazy(() =>
  import("./experiments/puzzle/PuzzleAccordion").then((m) => ({
    default: m.PuzzleAccordion,
  })),
);
const ShowreelSplitExperiment = lazy(() =>
  import("./experiments/showreel2/ShowreelSplit").then((m) => ({
    default: m.ShowreelSplit,
  })),
);
const MorphExperiment = lazy(() =>
  import("./experiments/morph/MorphExperiment").then((m) => ({
    default: m.MorphExperiment,
  })),
);
const FlyExperiment = lazy(() =>
  import("./experiments/fly/FlyExperiment").then((m) => ({
    default: m.FlyExperiment,
  })),
);
const FlySplatExperiment = lazy(() =>
  import("./experiments/fly/FlySplatExperiment").then((m) => ({
    default: m.FlySplatExperiment,
  })),
);
const CursorGridExperiment = lazy(() =>
  import("./experiments/cursorgrid/CursorGridExperiment").then((m) => ({
    default: m.CursorGridExperiment,
  })),
);

const root = document.getElementById("root");
if (!root) throw new Error("Root element #root not found");

// /?exp=<name> renders an isolated experiment instead of the real kiosk app.
const exp = new URLSearchParams(window.location.search).get("exp");
const experiment =
  exp === "showcase" ? (
    <ShowcaseExperiment />
  ) : exp === "gallery" ? (
    <GalleryExperiment />
  ) : exp === "news" ? (
    <NewsGridExperiment />
  ) : exp === "depth" ? (
    <DepthExperiment />
  ) : exp === "liquid" ? (
    <LiquidExperiment />
  ) : exp === "person" ? (
    <PersonDetailExperiment />
  ) : exp === "lego" ? (
    <LegoExperiment />
  ) : exp === "cv" ? (
    <CvExperiment />
  ) : exp === "splat" ? (
    <SplatViewerExperiment />
  ) : exp === "splat3d" ? (
    <SplatNativeExperiment />
  ) : exp === "splatnav" ? (
    <SplatNavExperiment />
  ) : exp === "puzzle" ? (
    <PuzzleAccordionExperiment />
  ) : exp === "showreel2" ? (
    <ShowreelSplitExperiment />
  ) : exp === "morph" ? (
    <MorphExperiment />
  ) : exp === "fly" ? (
    <FlyExperiment />
  ) : exp === "flysplat" ? (
    <FlySplatExperiment />
  ) : exp === "cursorgrid" ? (
    <CursorGridExperiment />
  ) : null;

createRoot(root).render(
  <StrictMode>
    {experiment ? <Suspense fallback={null}>{experiment}</Suspense> : <App />}
  </StrictMode>,
);
