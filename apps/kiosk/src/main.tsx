import { StrictMode, Suspense, lazy } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import "./index.css";

// Lazy so the WebGL experiment (three.js) stays out of the main bundle.
const ShowcaseExperiment = lazy(() =>
  import("./experiments/showcase/ShowcaseExperiment").then((m) => ({
    default: m.ShowcaseExperiment,
  })),
);

const root = document.getElementById("root");
if (!root) throw new Error("Root element #root not found");

// /?exp=showcase renders the isolated WebGL experiment instead of the real kiosk app.
const exp = new URLSearchParams(window.location.search).get("exp");

createRoot(root).render(
  <StrictMode>
    {exp === "showcase" ? (
      <Suspense fallback={null}>
        <ShowcaseExperiment />
      </Suspense>
    ) : (
      <App />
    )}
  </StrictMode>,
);
