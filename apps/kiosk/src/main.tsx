import { StrictMode } from "react";
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

const root = document.getElementById("root");
if (!root) throw new Error("Root element #root not found");

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
