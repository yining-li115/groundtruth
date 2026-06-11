import { useKioskStore, type View } from "../state/store";
import { runPixelTransition } from "./pixelTransition";

/**
 * Navigate to a section view through the pixel transition (covers → swaps view → reveals).
 * Use this instead of calling setView directly for user-driven navigation (menu, back).
 */
export function navigate(view: View) {
  if (useKioskStore.getState().view === view) return;
  runPixelTransition(() => useKioskStore.getState().setView(view));
}
