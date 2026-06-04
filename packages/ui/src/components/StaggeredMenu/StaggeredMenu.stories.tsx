import type { Meta, StoryObj } from "@storybook/react-vite";
import { useState } from "react";
import { StaggeredMenu, type StaggeredMenuItem } from "./StaggeredMenu";

const meta: Meta<typeof StaggeredMenu> = {
  title: "Components/StaggeredMenu",
  component: StaggeredMenu,
  parameters: { layout: "fullscreen" },
};
export default meta;

type Story = StoryObj<typeof StaggeredMenu>;

const SECTIONS = [
  { key: "teaching", label: "Teaching" },
  { key: "research", label: "Research" },
  { key: "projects", label: "Projects" },
  { key: "people", label: "People" },
] as const;

/** Click "MENU" (top-right) → the panel staggers in from the right with the prelayer
 *  sweep; pick an item to select it (stays accent) and the menu closes. */
function Demo() {
  const [active, setActive] = useState<string>("people");
  const items: StaggeredMenuItem[] = SECTIONS.map((s) => ({
    label: s.label,
    ariaLabel: s.label,
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
          Open the <strong>MENU</strong> (top-right). Current section:{" "}
          <strong>{active}</strong>.
        </p>
      </div>
      {/* isFixed so the panel fills the viewport height (same as the kiosk usage);
          without it, height:100% has no definite parent height to resolve against. */}
      <StaggeredMenu items={items} isFixed displayItemNumbering />
    </div>
  );
}

export const Default: Story = { render: () => <Demo /> };
