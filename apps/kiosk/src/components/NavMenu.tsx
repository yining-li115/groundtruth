import { useKioskStore, type View } from "../state/store";

/** The four browsable sections, tiled horizontally (not a collapsed MENU button). */
export const SECTIONS: { key: Exclude<View, "home">; label: string }[] = [
  { key: "people", label: "People" },
  { key: "research", label: "Research" },
  { key: "projects", label: "Student projects" },
  { key: "teaching", label: "Teaching" },
];

export function NavMenu() {
  const view = useKioskStore((s) => s.view);
  const setView = useKioskStore((s) => s.setView);

  return (
    <nav className="flex items-center gap-1">
      {SECTIONS.map((s) => (
        <button
          key={s.key}
          type="button"
          className="gt-nav-btn"
          aria-current={view === s.key}
          onClick={() => setView(s.key)}
        >
          {s.label}
        </button>
      ))}
    </nav>
  );
}
