import { PersonDetail } from "./PersonDetail";
import { people } from "../../lib/content";
import "./detail.css";

/**
 * Standalone preview (?exp=person) of the person-detail page on a real roster entry
 * (Weihang Li, from content/people.json). "← back" jumps to the real People list.
 */
export function PersonDetailExperiment() {
  const person = people.find((p) => p.id === "weihang-li");
  if (!person) return null;
  return (
    <PersonDetail person={person} onBack={() => (window.location.search = "?view=people")} />
  );
}
