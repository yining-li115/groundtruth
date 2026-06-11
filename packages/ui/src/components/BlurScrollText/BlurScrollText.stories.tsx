import type { CSSProperties } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { BlurScrollText } from "./BlurScrollText";

const meta: Meta<typeof BlurScrollText> = {
  title: "Components/BlurScrollText",
  component: BlurScrollText,
  parameters: { layout: "fullscreen" },
};
export default meta;

type Story = StoryObj<typeof BlurScrollText>;

const page: CSSProperties = {
  background: "var(--gt-bg)",
  color: "var(--gt-text-primary)",
  fontFamily: "var(--font-sans)",
};
const spacer: CSSProperties = {
  height: "100vh",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  color: "var(--gt-text-secondary)",
  fontWeight: 500,
};
// The wrapping element carries the type styling; BlurScrollText renders inline spans that
// inherit it.
const headline: CSSProperties = {
  minHeight: "100vh",
  display: "flex",
  alignItems: "center",
  padding: "0 2.5rem",
  fontSize: "clamp(2.5rem, 7vw, 6rem)",
  fontWeight: 700,
  lineHeight: 1.0,
  letterSpacing: "-0.02em",
};

/** Scroll down: the headline sharpens character-by-character as it enters (mode="in"); keep
 *  scrolling and the last line blurs away as it leaves (mode="out"). */
function Demo() {
  return (
    <div style={page}>
      <div style={spacer}>↓ scroll</div>
      <div style={headline}>
        <BlurScrollText as="span" text={"Making Machines\nSee and Think in 3D"} mode="in" />
      </div>
      <div style={headline}>
        <BlurScrollText as="span" text="Spotlight" mode="in" />
      </div>
      <div style={headline}>
        <BlurScrollText as="span" text="Blurs out as it leaves" mode="out" />
      </div>
      <div style={spacer}>end</div>
    </div>
  );
}

export const Default: Story = { render: () => <Demo /> };
