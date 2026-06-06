import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const root = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  root: "client",
  plugins: [react()],
  build: {
    outDir: "../dist",
    emptyOutDir: true
  },
  server: {
    host: "0.0.0.0",
    port: 5173,
    fs: {
      allow: [root]
    },
    proxy: {
      "/api": "http://127.0.0.1:8789",
      "/exports": "http://127.0.0.1:8789"
    }
  }
});
