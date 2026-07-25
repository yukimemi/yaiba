import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  build: {
    // rust-embed reads this directory at compile time; the Rust crate's
    // `include` list ships exactly `web/dist/**`.
    outDir: "dist",
    emptyOutDir: true,
  },
  server: {
    port: 5188,
    // Fail loudly if the port is taken instead of silently shifting to
    // 5189/5190/... — the API proxy below assumes a known origin.
    strictPort: true,
    proxy: {
      "/api": { target: "http://127.0.0.1:8188", changeOrigin: true },
    },
  },
});
