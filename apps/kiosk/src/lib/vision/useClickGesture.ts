import { RUNTIME_CLICK_GESTURE, type ClickGesture } from "./gestureRuntime";

export type { ClickGesture } from "./gestureRuntime";

/** Keep every instruction in lockstep with the single runtime classifier policy. */
export function useClickGesture(): ClickGesture {
  return RUNTIME_CLICK_GESTURE;
}

export function clickGestureNoun(gesture: ClickGesture): string {
  if (gesture === "pinch") return "pinch";
  if (gesture === "fist") return "fist";
  return "fist or pinch";
}

export function clickGestureInstruction(gesture: ClickGesture): string {
  if (gesture === "pinch") return "Pinch thumb and index finger";
  if (gesture === "fist") return "Make a fist";
  return "Make a fist or pinch";
}
