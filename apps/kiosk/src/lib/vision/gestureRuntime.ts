export type ClickGesture = "pinch" | "fist" | "either";

const params =
  typeof window === "undefined" ? null : new URLSearchParams(window.location.search);
const requested = params?.get("click");

/** One runtime source for both recognition and every piece of instructional copy. */
export const RUNTIME_CLICK_GESTURE: ClickGesture =
  requested === "pinch" || requested === "fist" || requested === "either"
    ? requested
    : "fist";

function optionalNumber(name: string): number | undefined {
  const raw = params?.get(name);
  if (raw === null || raw === undefined || raw.trim() === "") return undefined;
  const value = Number(raw);
  return Number.isFinite(value) ? value : undefined;
}

const dwell = optionalNumber("dwell");
const reach = optionalNumber("reach");

/**
 * Operator overrides are runtime policy, not calibration data. Every profile restore reapplies
 * this object last so a camera/display lookup cannot silently erase the URL contract.
 */
export const RUNTIME_POINTER_OVERRIDES = {
  clickGesture: RUNTIME_CLICK_GESTURE,
  ...(dwell !== undefined && dwell >= 0 ? { dwellMs: dwell } : {}),
  ...(reach !== undefined && reach > 0 && reach <= 1 ? { reachScale: reach } : {}),
} as const;
