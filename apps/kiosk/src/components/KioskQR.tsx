import { QRCodeSVG } from "qrcode.react";
import { palette } from "@groundtruth/tokens";
import { CONTROLLER_LINK } from "../config";

/**
 * The static QR a visitor scans to take control (architecture §2). It encodes the
 * controller URL for this room and is always visible in a corner. Colors come from
 * tokens, never raw hex (CLAUDE.md rule 1).
 */
export function KioskQR() {
  return (
    <div
      className="fixed bottom-8 right-8 flex flex-col items-center gap-3 rounded-2xl p-5"
      style={{
        background: "var(--gt-surface)",
        border: "1px solid var(--gt-border)",
        boxShadow: "0 8px 30px rgb(0 0 0 / 0.08)",
      }}
    >
      <QRCodeSVG
        value={CONTROLLER_LINK}
        size={168}
        fgColor={palette.brand.black}
        bgColor={palette.brand.white}
        level="M"
      />
      <p className="text-sm font-medium" style={{ color: "var(--gt-text-primary)" }}>
        Scan to take control
      </p>
      <p className="max-w-[168px] break-all text-center text-[10px]" style={{ color: "var(--gt-text-secondary)" }}>
        {CONTROLLER_LINK}
      </p>
    </div>
  );
}
