import * as Effect from "effect/Effect";
import type * as Scope from "effect/Scope";
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { type Browser, chromium, type Page } from "playwright-core";
import { Server } from "./Server.ts";

// A browser on the viewer, signed in as a person. `task check` downloads
// nothing (it may not reach the internet), so this uses a Chrome that is
// already installed: PECIA_E2E_CHROME, else one on PATH (GitHub's Ubuntu
// runners have google-chrome), else the one agent-browser installs in orbs.

const onPath = (name: string): string | undefined => {
  try {
    return execFileSync("which", [name], { encoding: "utf8" }).trim() || undefined;
  } catch {
    return undefined;
  }
};

const agentBrowserChrome = (): string | undefined => {
  const browsers = join(homedir(), ".agent-browser", "browsers");
  if (!existsSync(browsers)) return undefined;
  return readdirSync(browsers)
    .toSorted()
    .toReversed()
    .map((version) => join(browsers, version, "chrome"))
    .find((path) => existsSync(path));
};

const chrome = (): string | undefined =>
  process.env["PECIA_E2E_CHROME"] ??
  ["google-chrome", "google-chrome-stable", "chromium", "chromium-browser"]
    .map((name) => onPath(name))
    .find((path) => path !== undefined) ??
  agentBrowserChrome();

/** A browser, closed when the scope closes. */
const launch: Effect.Effect<Browser, never, Scope.Scope> = Effect.acquireRelease(
  Effect.promise(() => {
    const executablePath = chrome();
    if (executablePath === undefined)
      throw new Error("no Chrome to run the viewer scenarios: install one or set PECIA_E2E_CHROME to its path");
    return chromium.launch({ executablePath, args: ["--no-sandbox"] });
  }),
  (browser) => Effect.promise(() => browser.close()),
);

/** A page of the viewer whose browser Access has signed in as `email`. */
export const signedIn = Effect.fnUntraced(function* (
  email: string,
): Effect.fn.Return<Page, never, Server | Scope.Scope> {
  const server = yield* Server;
  const browser = yield* launch;
  const { cookie } = yield* server.access.person(email);
  return yield* Effect.promise(async () => {
    const context = await browser.newContext();
    const [name = "", value = ""] = (cookie ?? "").split(/=(.*)/s);
    await context.addCookies([{ name, value, url: server.url }]);
    return context.newPage();
  });
});

/** Run a step on a page; a step that fails fails the scenario. */
export const step = <A>(run: () => Promise<A>): Effect.Effect<A> => Effect.promise(() => run());
