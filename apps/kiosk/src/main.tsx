import { StrictMode, Suspense, lazy } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import "./index.css";

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
  ) : null;

createRoot(root).render(
  <StrictMode>
    {experiment ? <Suspense fallback={null}>{experiment}</Suspense> : <App />}
  </StrictMode>,
);
