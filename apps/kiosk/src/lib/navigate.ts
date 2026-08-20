import { useKioskStore, type View } from "../state/store";
import { runPixelTransition } from "./pixelTransition";
import { scrollToTop } from "./scroll";

/**
 * Navigate to a section view through the pixel transition (covers → swaps view → reveals).
 * Use this instead of calling setView directly for user-driven navigation (menu, back).
 */
export function navigate(view: View) {
  if (useKioskStore.getState().view === view) return;
  runPixelTransition(() => {
    useKioskStore.getState().setView(view);
    // Behind the cover, so the jump is never seen. A page that inherits the last one's scroll
    // opens part-way down itself, and if it is taller than the viewport it clamps to its own
    // bottom — with the way back above the top edge and reachable by nothing.
    scrollToTop();
  });
}
