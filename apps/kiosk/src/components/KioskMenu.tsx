import { StaggeredMenu, type StaggeredMenuItem } from "@groundtruth/ui";
import { useKioskStore, type View } from "../state/store";

const SECTIONS: { key: Exclude<View, "home">; label: string }[] = [
  { key: "teaching", label: "Teaching" },
  { key: "research", label: "Research" },
  { key: "projects", label: "Projects" },
  { key: "people", label: "People" },
];

/** The kiosk's navigation: the reusable StaggeredMenu wired to section view-state.
 *  Fixed so the MENU toggle + panel follow the viewport while the long page scrolls. */
export function KioskMenu() {
  const view = useKioskStore((s) => s.view);
  const setView = useKioskStore((s) => s.setView);

  const items: StaggeredMenuItem[] = SECTIONS.map((s) => ({
    label: s.label,
    ariaLabel: s.label,
    active: view === s.key,
    onClick: () => setView(s.key),
  }));

  return <StaggeredMenu items={items} isFixed displayItemNumbering />;
}
