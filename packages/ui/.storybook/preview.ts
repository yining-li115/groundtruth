import type { Preview } from "@storybook/react-vite";
import { light, dark } from "@groundtruth/tokens";
import "../src/index.css";

const preview: Preview = {
  parameters: {
    // Light is the default everywhere (design-system §5). Dark is the optional kiosk
    // idle backdrop — keep both available so every component can be checked on each
    // (component-library.md §2: dark- and light-theme rendering must both work).
    // Storybook 10 backgrounds API: define named `options`, pick the active one via
    // globals (per-story override with `globals.backgrounds.value`). Colors come from
    // the tokens package — never hardcode hex (CLAUDE.md rule 1).
    backgrounds: {
      options: {
        light: { name: "Light", value: light.bg },
        dark: { name: "Dark", value: dark.bg },
      },
    },
  },
  initialGlobals: {
    backgrounds: { value: "light" },
  },
};

export default preview;
