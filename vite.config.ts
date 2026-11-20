import { defineConfig } from "vite";
// @ts-expect-error type error without @types/node package
import process from "node:process";
const host = process.env.TAURI_DEV_HOST;

// https://vite.dev/config/
export default defineConfig(() => ({
  // serve assets/ as static root so /pet/pet.json and /pet/spritesheet.png are reachable
  publicDir: "assets",

  // four entries: the pet window (index.html), the chat bubble window
  // (chat.html), the sessions panel (sessions.html, v1.2 Task 4) and the
  // settings window (settings.html, v1.3.x Task 1)
  build: {
    rollupOptions: {
      input: {
        main: "index.html",
        chat: "chat.html",
        sessions: "sessions.html",
        settings: "settings.html",
      },
    },
  },

  // Vite options tailored for Tauri development and only applied in `tauri dev` or `tauri build`
  //
  // 1. prevent Vite from obscuring rust errors
  clearScreen: false,
  // 2. tauri expects a fixed port, fail if that port is not available
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1421,
        }
      : undefined,
    watch: {
      // 3. tell Vite to ignore watching `src-tauri`
      ignored: ["**/src-tauri/**"],
    },
  },
}));
