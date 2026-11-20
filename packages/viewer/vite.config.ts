import react from "@vitejs/plugin-react";
import { existsSync, readFileSync } from "node:fs";
import { defineConfig } from "vite";

// The viewer is static: `task build:viewer` writes it to dist, which the
// Control Worker serves as its assets. `task dev:viewer` serves it with the
// API calls passed to a deployed Worker, PECIA_VIEWER_API (default staging).
const api = process.env["PECIA_VIEWER_API"];

// Development only (docs/viewer.md, "During development"): the deployed Worker
// is behind Cloudflare Access, so the proxy sends each API call with the
// stage's orchestrator token, from the file `task access:token` writes
// (PECIA_VIEWER_ACCESS). The token never reaches the browser. Without the file
// the calls answer Access's redirect and the pages say they could not load.
const accessFile = process.env["PECIA_VIEWER_ACCESS"];
const access = new Map(
  accessFile !== undefined && existsSync(accessFile)
    ? readFileSync(accessFile, "utf8")
        .split("\n")
        .flatMap((line) => {
          const separator = line.indexOf("=");
          return separator > 0 ? [[line.slice(0, separator), line.slice(separator + 1)] as const] : [];
        })
    : [],
);
const accessHeaders: Record<string, string> = {
  "cf-access-client-id": access.get("PECIA_ACCESS_CLIENT_ID") ?? "",
  "cf-access-client-secret": access.get("PECIA_ACCESS_CLIENT_SECRET") ?? "",
  // The Worker publishes an edit only for a page of its own origin (docs/editing.md, "Auth"). The
  // browser names the development server, so the proxy names the stage: the call is the proxy's own.
  ...(api === undefined ? {} : { origin: new URL(api).origin }),
};

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
            ["/workspaces", "/auth"].map((path) => [
              path,
              { target: api, changeOrigin: true, secure: true, headers: accessHeaders },
            ]),
          ),
        }),
  },
});
