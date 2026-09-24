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
    // `open` is only an initial deep-link instruction. Leaving that value in the address bar
    // meant Home → Publications remounted the section with the old paper already selected,
    // bypassing the list. Any in-kiosk section navigation starts from the section's own index.
    const url = new URL(window.location.href);
    if (url.searchParams.has("open")) {
      url.searchParams.delete("open");
      window.history.replaceState(null, "", url);
    }
    useKioskStore.getState().setView(view);
    // Behind the cover, so the jump is never seen. A page that inherits the last one's scroll
    // opens part-way down itself, and if it is taller than the viewport it clamps to its own
    // bottom — with the way back above the top edge and reachable by nothing.
    scrollToTop();
  });
}
