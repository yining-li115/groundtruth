import type { Meta, StoryObj } from "@storybook/react-vite";
import { Logo } from "./Logo";

const meta: Meta<typeof Logo> = {
  title: "Brand/Logo",
  component: Logo,
  parameters: { layout: "centered" },
  tags: ["autodocs"],
  argTypes: {
    variant: { control: "inline-radio", options: ["blue", "white"] },
  },
};
export default meta;

type Story = StoryObj<typeof Logo>;

/** Native TUM logo blue (#3070B3) on the default light background. */
export const Default: Story = {
  args: { variant: "blue" },
};

/** The one allowed recolor — white logo on the dark idle-backdrop (design-system §3). */
export const OnDark: Story = {
  args: { variant: "white" },
  globals: { backgrounds: { value: "dark" } },
};

/** Scales cleanly as a vector (kiosk hero sizing). */
export const Large: Story = {
  args: { variant: "blue", width: 292, height: 152 },
};
