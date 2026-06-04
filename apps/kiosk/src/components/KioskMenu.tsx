import { BubbleMenu, type BubbleMenuItem } from "@groundtruth/ui";
import { useKioskStore, type View } from "../state/store";

const SECTIONS: { key: Exclude<View, "home">; label: string; rotation: number }[] = [
  { key: "people", label: "People", rotation: -8 },
  { key: "research", label: "Research", rotation: 8 },
  { key: "projects", label: "Student projects", rotation: 8 },
  { key: "teaching", label: "Teaching", rotation: -8 },
];

/** The kiosk's navigation: the reusable BubbleMenu wired to section view-state. Fixed
 *  position so the MENU toggle and overlay follow the viewport while the page scrolls. */
export function KioskMenu() {
  const view = useKioskStore((s) => s.view);
  const setView = useKioskStore((s) => s.setView);

  const items: BubbleMenuItem[] = SECTIONS.map((s) => ({
    label: s.label,
    ariaLabel: s.label,
    rotation: s.rotation,
    active: view === s.key,
    onClick: () => setView(s.key),
  }));

  return <BubbleMenu items={items} useFixedPosition />;
}
