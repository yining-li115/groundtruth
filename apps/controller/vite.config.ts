import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  // Fixed port: the kiosk QR encodes :5174 for the controller, so it must always be
  // here (not stolen by the kiosk). host:true exposes it on the LAN for phones.
  server: { host: true, port: 5174, strictPort: true },
});
