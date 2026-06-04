import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  // Fixed port so the controller QR (which targets :5174) is never confused with the
  // kiosk; host:true exposes it on the LAN for phone testing.
  server: { host: true, port: 5173, strictPort: true },
});
