import { Color } from "three";
import { palette } from "@groundtruth/tokens";

/**
 * THREE colors derived from our design tokens (no raw hex here — rule 1). Used for the
 * WebGL materials in the showcase experiment.
 */
export const C = {
  electric: new Color(palette.brand.electric),
  green: new Color(palette.accent.green),
  lightblue: new Color(palette.accent.lightblue),
  midblue: new Color(palette.accent.midblue),
  white: new Color(palette.brand.white),
};

