import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// The viewer is static: `task build:viewer` writes it to dist, which the
// Control Worker serves as its assets. `task dev:viewer` serves it with the
// API calls passed to a deployed Worker, PECIA_VIEWER_API (default staging).
const api = process.env["PECIA_VIEWER_API"];

export default defineConfig({
  plugins: [react()],
  build: { outDir: "dist", emptyOutDir: true },
  server: {
    host: true,
    allowedHosts: true,
    ...(api === undefined
      ? {}
      : {
          proxy: Object.fromEntries(
            ["/workspaces", "/auth"].map((path) => [path, { target: api, changeOrigin: true, secure: true }]),
          ),
        }),
  },
});
