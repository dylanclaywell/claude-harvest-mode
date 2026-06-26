import { defineConfig } from "vite";
import { fileURLToPath } from "node:url";
import { assetsApi } from "./vite-assets-plugin";

const at = (p: string) => fileURLToPath(new URL(p, import.meta.url));

// Two entries: the game (index.html) and the dev-only sprite editor
// (editor.html). The editor is a build-time authoring tool, never shipped in the
// Tauri release. Tauri-friendly server settings (fixed port, no screen clear).
export default defineConfig({
  plugins: [assetsApi()],
  clearScreen: false,
  server: { port: 1420, strictPort: true },
  build: {
    target: "es2022",
    rollupOptions: {
      input: {
        main: at("./index.html"),
        editor: at("./editor.html"),
      },
    },
  },
});
