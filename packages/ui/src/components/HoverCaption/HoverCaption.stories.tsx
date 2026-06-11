import type { CSSProperties } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { HoverCaption } from "./HoverCaption";

const meta: Meta<typeof HoverCaption> = {
  title: "Components/HoverCaption",
  component: HoverCaption,
  parameters: { layout: "centered" },
};
export default meta;

type Story = StoryObj<typeof HoverCaption>;

const card: CSSProperties = { width: "min(60vw, 640px)", aspectRatio: "16 / 9" };
const img: CSSProperties = { width: "100%", height: "100%", objectFit: "cover", display: "block" };

/** Hover the card: the gradient rises and the title + description fade in. */
export const Default: Story = {
  render: () => (
    <div style={{ fontFamily: "var(--font-sans)" }}>
      <HoverCaption
        title="Digital Twins"
        description="Photorealistic, geometrically precise 3D replicas of real-world environments."
      >
        <img style={{ ...card, ...img }} src="https://picsum.photos/seed/hovercap/1600/900" alt="" />
      </HoverCaption>
    </div>
  ),
};

/** The same effect driven WITHOUT a mouse — `.is-hover` is toggled (as a custom cursor would
 *  on the kiosk). This card shows the revealed state permanently. */
export const ForcedActive: Story = {
  render: () => (
    <div style={{ fontFamily: "var(--font-sans)" }}>
      <HoverCaption
        className="is-hover"
        title="Sensor Fusion"
        description="LiDAR, radar and imagery fused into one coherent 3D understanding."
      >
        <img style={{ ...card, ...img }} src="https://picsum.photos/seed/hovercap2/1600/900" alt="" />
      </HoverCaption>
    </div>
  ),
};
