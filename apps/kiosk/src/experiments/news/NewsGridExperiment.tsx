import { NewsGrid } from "../../components/NewsGrid";

/**
 * Standalone preview (?exp=news) of the home News section (components/NewsGrid). Just wraps
 * it on the light page so the 3D staggered scroll grid can be checked in isolation.
 */
export function NewsGridExperiment() {
  return (
    <div
      style={{ minHeight: "100vh", background: "var(--gt-bg)", color: "var(--gt-text-primary)" }}
    >
      <NewsGrid />
    </div>
  );
}
