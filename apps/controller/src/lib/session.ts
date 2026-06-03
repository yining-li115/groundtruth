/**
 * The controller opens at /c/:sessionId (architecture §2). We parse the room id from
 * the path directly — no router dependency needed for a single dynamic segment.
 * Returns null if the URL isn't a valid /c/<id>, so the UI can tell the visitor to
 * scan the kiosk QR instead.
 */
export function parseSessionId(): string | null {
  const match = window.location.pathname.match(/^\/c\/([^/]+)\/?$/);
  return match && match[1] ? decodeURIComponent(match[1]) : null;
}
