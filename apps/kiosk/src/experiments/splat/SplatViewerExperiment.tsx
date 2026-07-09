/**
 * Original-form reference viewer — embeds the official SuperSplat WebGL viewer for the TUM
 * Main Campus scan (the full 24M-Gaussian splat, exactly as superspl.at renders it). This is
 * for CHECKING what the real model looks like (find the front gate / clock tower / framing);
 * it is NOT our interactive point cloud (that lives at /?exp=cv). Preview at /?exp=splat.
 */
const SCENE_URL = "https://superspl.at/s?id=193ca7e8";

export function SplatViewerExperiment() {
  return (
    <div style={{ position: "fixed", inset: 0, background: "#000" }}>
      <iframe
        title="TUM Main Campus — original SuperSplat scan"
        src={SCENE_URL}
        allow="fullscreen; xr-spatial-tracking"
        style={{ width: "100%", height: "100%", border: "0" }}
      />
    </div>
  );
}
