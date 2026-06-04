import type { SVGProps } from "react";
import { palette } from "@groundtruth/tokens";

export type LogoVariant = "blue" | "white" | "black";

export type LogoProps = Omit<SVGProps<SVGSVGElement>, "fill"> & {
  /**
   * `"blue"` (default) renders the native TUM logo blue (`brand.logoBlue` #3070B3).
   * `"white"` (on dark) and `"black"` (on light) are the allowed monochrome recolors
   * (design-system §3). Never recolor to the UI accent or TUM blue `brand.blue`.
   */
  variant?: LogoVariant;
  /** Accessible label for the wordmark. */
  title?: string;
};

/**
 * TUM wordmark. Inlines the vector from assets/logo/tum-logo.svg (73×38) so its fill
 * is recolorable for the dark-background case. Fill always comes from a token — no raw
 * hex (CLAUDE.md rule 1). Keep clear space ≥ the height of the logo's bar; never
 * stretch, rotate, or add shadows (design-system §3).
 */
export function Logo({
  variant = "blue",
  title = "TUM",
  width = 73,
  height = 38,
  ...rest
}: LogoProps) {
  const fill =
    variant === "white"
      ? palette.brand.white
      : variant === "black"
        ? palette.brand.black
        : palette.brand.logoBlue;
  return (
    <svg
      width={width}
      height={height}
      viewBox="0 0 73 38"
      role="img"
      aria-label={title}
      xmlns="http://www.w3.org/2000/svg"
      {...rest}
    >
      <title>{title}</title>
      <path
        d="M28 0v31h8v-31h37v38h-7v-31h-8v31h-7v-31h-8v31h-22v-31h-7v31h-7v-31h-7v-7h28z"
        fill={fill}
      />
    </svg>
  );
}
