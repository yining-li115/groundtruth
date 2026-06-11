import type { Meta, StoryObj } from "@storybook/react-vite";
import { HeroScrollHint } from "./HeroScrollHint";

const meta: Meta<typeof HeroScrollHint> = {
  title: "Components/HeroScrollHint",
  component: HeroScrollHint,
  parameters: { layout: "centered" },
  args: { label: "Spotlight" },
};
export default meta;

type Story = StoryObj<typeof HeroScrollHint>;

/** The hint bobs continuously (a "scroll down" invitation). On a real page you'd pass a
 *  `fadeTrigger` so it also blurs out as the hero leaves. */
export const Default: Story = {
  render: (args) => (
    <div style={{ fontFamily: "var(--font-sans)", padding: "2rem" }}>
      <HeroScrollHint {...args} />
    </div>
  ),
};
