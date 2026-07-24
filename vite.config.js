import { defineConfig } from "vite";
import { resolve } from "path";

export default defineConfig({
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
  },
  build: {
    rollupOptions: {
      // Two pages: the app itself, and the native always-on-top PiP
      // window (see pip.html / enterNativePip in playback-controls.js).
      input: {
        main: resolve(__dirname, "index.html"),
        pip: resolve(__dirname, "pip.html"),
      },
    },
  },
});
