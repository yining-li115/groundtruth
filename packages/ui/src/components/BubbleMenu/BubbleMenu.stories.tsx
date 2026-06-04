import type { Meta, StoryObj } from "@storybook/react-vite";
import { useState } from "react";
import { BubbleMenu, type BubbleMenuItem } from "./BubbleMenu";

const meta: Meta<typeof BubbleMenu> = {
  title: "Components/BubbleMenu",
  component: BubbleMenu,
  parameters: { layout: "fullscreen" },
};
export default meta;

type Story = StoryObj<typeof BubbleMenu>;

const SECTIONS = [
  { key: "people", label: "People", rotation: -8 },
  { key: "research", label: "Research", rotation: 8 },
  { key: "projects", label: "Student projects", rotation: 8 },
  { key: "teaching", label: "Teaching", rotation: -8 },
] as const;

/**
 * Click the "MENU" pill (top-right) to expand the bubbles; pick one to select it (it
 * stays black as the "current" section) and the menu closes. Hover a pill → black.
 * Rendered inside a relative box so the overlay stays within the story canvas.
 */
function Demo() {
  const [active, setActive] = useState<string>("people");
  const items: BubbleMenuItem[] = SECTIONS.map((s) => ({
    label: s.label,
    ariaLabel: s.label,
    rotation: s.rotation,
    active: active === s.key,
    onClick: () => setActive(s.key),
  }));

  return (
    <div
      style={{
        position: "relative",
        minHeight: "100vh",
        background: "var(--gt-bg)",
        color: "var(--gt-text-primary)",
        fontFamily: "var(--font-sans)",
        overflow: "hidden",
      }}
    >
      <div style={{ padding: "2.2em 2em" }}>
        <p style={{ fontWeight: 700, maxWidth: "24ch" }}>
          Professorship of Photogrammetry and Remote Sensing
        </p>
        <p style={{ marginTop: 24, color: "var(--gt-text-secondary)" }}>
          Open the <strong>MENU</strong> (top-right) to expand the bubble navigation.
          Current section: <strong>{active}</strong>.
        </p>
      </div>
      <BubbleMenu items={items} />
    </div>
  );
}

export const Default: Story = { render: () => <Demo /> };

/** Fixed positioning — the toggle and overlay follow the viewport (kiosk usage). */
export const FixedPosition: Story = {
  render: () => {
    const items: BubbleMenuItem[] = SECTIONS.map((s) => ({
      label: s.label,
      rotation: s.rotation,
    }));
    return (
      <div style={{ minHeight: "100vh", background: "var(--gt-bg)" }}>
        <BubbleMenu items={items} useFixedPosition />
      </div>
    );
  },
};
