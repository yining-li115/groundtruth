import type { Meta, StoryObj } from "@storybook/react-vite";

/**
 * Typography specimen — confirms TUM Neue Helvetica (via --font-sans, defined with its
 * @font-face in @groundtruth/tokens) actually loads. If the font failed to load, the
 * samples would fall back to the system sans and look noticeably different from the
 * Georgia serif contrast row below.
 */
const meta: Meta = {
  title: "Foundations/Typography",
  parameters: { layout: "fullscreen" },
};
export default meta;

type Story = StoryObj;

function Specimen() {
  return (
    <div
      style={{
        fontFamily: "var(--font-sans)",
        background: "var(--gt-bg)",
        color: "var(--gt-text-primary)",
        padding: "3rem",
        minHeight: "100vh",
      }}
    >
      <p
        style={{
          margin: 0,
          fontSize: 12,
          letterSpacing: "0.08em",
          textTransform: "uppercase",
          color: "var(--gt-text-secondary)",
        }}
      >
        TUM Neue Helvetica · var(--font-sans)
      </p>

      <h1 style={{ fontSize: 64, fontWeight: 700, lineHeight: 1.05, margin: "0.25em 0 0.1em" }}>
        Making machines see &amp; think in 3D
      </h1>
      <h2 style={{ fontSize: 30, fontWeight: 500, margin: "0 0 1.25rem" }}>
        Photogrammetry &amp; Remote Sensing — TUM
      </h2>
      <p style={{ fontSize: 18, maxWidth: 640, margin: "0 0 2rem" }}>
        The quick brown fox jumps over the lazy dog. 0123456789 — point cloud, SAR,
        InSAR, 3D reconstruction, digital twin.
      </p>

      <div style={{ display: "grid", gap: "0.4rem", fontSize: 22 }}>
        <span style={{ fontWeight: 400 }}>Regular 400 — normal</span>
        <span style={{ fontWeight: 700 }}>Bold 700 — normal</span>
        <span style={{ fontWeight: 400, fontStyle: "italic" }}>Regular 400 — italic</span>
        <span style={{ fontWeight: 700, fontStyle: "italic" }}>Bold 700 — italic</span>
      </div>

      <hr style={{ margin: "2rem 0", border: 0, borderTop: "1px solid var(--gt-border)" }} />

      <div style={{ display: "flex", gap: "3rem", flexWrap: "wrap" }}>
        <div>
          <p style={{ fontSize: 12, color: "var(--gt-text-secondary)", margin: "0 0 0.25rem" }}>
            var(--font-sans) — TUM Neue Helvetica
          </p>
          <p style={{ fontFamily: "var(--font-sans)", fontSize: 40, margin: 0 }}>
            Aa Bb Gg Qq Rg 123
          </p>
        </div>
        <div>
          <p style={{ fontSize: 12, color: "var(--gt-text-secondary)", margin: "0 0 0.25rem" }}>
            Georgia serif (contrast — should look clearly different)
          </p>
          <p style={{ fontFamily: "Georgia, serif", fontSize: 40, margin: 0 }}>
            Aa Bb Gg Qq Rg 123
          </p>
        </div>
      </div>
    </div>
  );
}

export const Specimen_: Story = { name: "Specimen", render: () => <Specimen /> };
