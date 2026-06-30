import type { Meta, StoryObj } from "@storybook/react-vite";
import { useState } from "react";
import { GooeyNav, type GooeyNavItem } from "./GooeyNav";

const meta: Meta<typeof GooeyNav> = {
  title: "Components/GooeyNav",
  component: GooeyNav,
  parameters: { layout: "fullscreen" },
};
export default meta;

type Story = StoryObj<typeof GooeyNav>;

const FILTERS: GooeyNavItem[] = [
  { label: "IDP" },
  { label: "Guided Research" },
  { label: "Semester Arbeit" },
  { label: "Bachelor Thesis" },
  { label: "Master Thesis" },
];

/**
 * Click a tab — the active pill glides over and a gooey burst of particles fuses behind it.
 * The component needs a DARK surface (mix-blend lighten over black), so the canvas is wrapped
 * in a [data-theme="dark"] box. `onSelect` reports the picked index for filtering.
 */
function Demo() {
  const [active, setActive] = useState(0);
  return (
    <div
      data-theme="dark"
      style={{
        minHeight: "100vh",
        background: "var(--gt-bg)",
        color: "var(--gt-text-primary)",
        fontFamily: "var(--font-sans)",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        gap: "3rem",
        padding: "6rem 2rem",
      }}
    >
      <GooeyNav items={FILTERS} onSelect={(i) => setActive(i)} />
      <p style={{ color: "var(--gt-text-secondary)" }}>
        Filtering by: <strong style={{ color: "var(--gt-accent)" }}>{FILTERS[active]?.label}</strong>
      </p>
    </div>
  );
}

export const Default: Story = { render: () => <Demo /> };
