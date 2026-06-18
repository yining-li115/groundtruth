import { PersonDetail } from "./PersonDetail";
import { weihang } from "./peopleData";
import "./detail.css";

/**
 * Standalone preview (?exp=person) of the person-detail page — the Codrops TypeShuffle
 * "terminal" (effect 5) on Weihang Li. Kept separate from the real People roster so the
 * decode treatment can be locked on its own before it's wired into the section. "← back"
 * jumps to the real People list (?view=people).
 */
export function PersonDetailExperiment() {
  return <PersonDetail person={weihang} onBack={() => (window.location.search = "?view=people")} />;
}
