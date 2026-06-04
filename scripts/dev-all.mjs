#!/usr/bin/env node
/**
 * One-command dev launcher: relay + kiosk + controller in a single terminal, each with
 * a coloured prefix. Auto-detects this machine's LAN IP (no hard-coded address) and
 * injects it into the apps' VITE_RELAY_URL / VITE_CONTROLLER_URL so phones reach the
 * relay and the QR points at the real controller — change networks freely, no edits.
 *
 *   npm run dev:all
 *   GT_HOST_IP=10.0.0.5 npm run dev:all   # force a specific IP if auto-detect is wrong
 */
import os from "node:os";
import concurrently from "concurrently";

const RELAY_PORT = 3001;
const KIOSK_PORT = 5173;
const CONTROLLER_PORT = 5174;
const SESSION_ID = process.env.VITE_SESSION_ID || "gt-entrance";

/** Pick a non-internal IPv4, preferring the usual Wi-Fi/ethernet interfaces. */
function detectLanIp() {
  const found = [];
  for (const [name, addrs] of Object.entries(os.networkInterfaces())) {
    for (const a of addrs || []) {
      const isV4 = a.family === "IPv4" || a.family === 4;
      if (isV4 && !a.internal) found.push({ name, address: a.address });
    }
  }
  const pick =
    found.find((c) => c.name === "en0") ||
    found.find((c) => /^(en|eth|wlan|wl)/i.test(c.name)) ||
    found[0];
  return pick ? pick.address : "localhost";
}

const ip = process.env.GT_HOST_IP || detectLanIp();
const relayUrl = `http://${ip}:${RELAY_PORT}`;
const kioskUrl = `http://${ip}:${KIOSK_PORT}`;
const controllerUrl = `http://${ip}:${CONTROLLER_PORT}`;
const scanUrl = `${controllerUrl}/c/${SESSION_ID}`;

const rule = "═".repeat(62);
console.log(
  [
    "",
    rule,
    "  Groundtruth dev — relay + kiosk + controller   (Ctrl+C stops all)",
    `  LAN IP: ${ip}${ip === "localhost" ? "   ⚠ no LAN detected — phone access won't work" : ""}`,
    "",
    `  🖥  Big screen (kiosk):   ${kioskUrl}`,
    `  📱 Phone (scan / open):  ${scanUrl}`,
    `  🔌 Relay:                ${relayUrl}`,
    rule,
    "",
  ].join("\n"),
);

const { result } = concurrently(
  [
    {
      command: "npm run dev -w @groundtruth/relay",
      name: "relay",
      prefixColor: "magenta",
    },
    {
      command: "npm run dev -w @groundtruth/kiosk",
      name: "kiosk",
      prefixColor: "cyan",
      env: { ...process.env, VITE_RELAY_URL: relayUrl, VITE_CONTROLLER_URL: controllerUrl },
    },
    {
      command: "npm run dev -w @groundtruth/controller",
      name: "ctrl",
      prefixColor: "green",
      env: { ...process.env, VITE_RELAY_URL: relayUrl },
    },
  ],
  {
    prefix: "name",
    killOthers: ["failure", "success"],
    restartTries: 0,
  },
);

result.then(
  () => process.exit(0),
  () => process.exit(1),
);
