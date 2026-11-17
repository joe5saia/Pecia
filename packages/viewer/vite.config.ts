import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";

// The viewer is static: `task build:viewer` writes it to dist, which the
// Control Worker serves as its assets. `task dev:viewer` serves it with the
// API calls passed to a deployed Worker, PECIA_VIEWER_API (default staging).
const api = process.env["PECIA_VIEWER_API"];

// A path on this origin to go to after the development login: `/x`, never
// `//host` or `/\host`, which a browser reads as another site.
const safeReturnTo = (value: string | null): string => (value !== null && /^\/(?![/\\])/.test(value) ? value : "/");

// Development only (docs/viewer.md, "Logging in during development"):
// `GET /__dev/log-me-in?returnTo=<path>` logs the browser in without anyone
// typing the key. The dev server trades staging's orchestrator key, from its
// own environment, for the login cookie at the deployed Worker and hands the
// browser that cookie. The key never reaches the browser. `apply: "serve"`
// keeps the route out of `vite build`, so no deployed stage has it.
const devLogin = (target: string | undefined): Plugin => ({
  name: "pecia-dev-login",
  apply: "serve",
  configureServer: (server) => {
    server.middlewares.use("/__dev/log-me-in", (request, response) => {
      const key = process.env["PECIA_ORCHESTRATOR_KEY_STAGING"];
      const answer = (status: number, message: string) => {
        response.writeHead(status, { "content-type": "text/plain; charset=utf-8" });
        response.end(`${message}\n`);
      };
      if (target === undefined || key === undefined || key === "") {
        answer(404, "No development login: PECIA_VIEWER_API or PECIA_ORCHESTRATOR_KEY_STAGING is not set.");
        return;
      }
      const returnTo = safeReturnTo(new URL(request.url ?? "/", "http://localhost").searchParams.get("returnTo"));
      fetch(new URL("/auth/login", target), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ key }),
      }).then(
        (login) => {
          const cookies = login.headers.getSetCookie();
          if (!login.ok || cookies.length === 0) {
            answer(502, `${target} refused the development login with status ${login.status}.`);
            return;
          }
          response.writeHead(302, { location: returnTo, "set-cookie": cookies, "cache-control": "no-store" });
          response.end();
        },
        (error: unknown) => {
          answer(502, `${target} did not answer the development login: ${String(error)}`);
        },
      );
    });
  },
});

export default defineConfig({
  plugins: [react(), devLogin(api)],
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
