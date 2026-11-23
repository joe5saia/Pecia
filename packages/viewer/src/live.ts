import type { WorkspaceName } from "@pecia/wiki-api";
import * as Match from "effect/Match";
import { useEffect, useState } from "react";
import { isSignedIn } from "./api.ts";

// Live updates (docs/viewer.md, "Live updates"). A wiki's page keeps a
// WebSocket to the wiki's Durable Object, which says when main moved or a
// comment changed; the viewer then reads again what it shows. A socket does
// not survive a laptop's sleep and misses what happened while it was closed,
// so the viewer also reads again when the reader comes back to the tab, the
// browser is back online, or a socket opens again.

export interface Live {
  /** Goes up each time main may have moved. */
  readonly main: number;
  /** Goes up each time a comment of the wiki may have changed. */
  readonly comments: number;
  /** Whether the Access sign-in has expired, so nothing new can be read until the reader signs in again. */
  readonly signedOut: boolean;
}

/** A ping keeps the socket through Cloudflare's idle timeout of 100 seconds; the object answers it without waking. */
const pingEvery = 30_000;
/** A socket that has heard nothing, not even a pong, for this long is dead: a laptop slept, or the network changed. */
const deadAfter = 75_000;
/** A socket still opening after this long is stuck: a handshake the network dropped. */
const connectTimeout = 15_000;
/** Coming back fires focus, visibilitychange and pageshow together: one read again is enough. */
const catchUpGap = 2000;
const maxBackoff = 30_000;

/** The changes of wiki `ws`, or with no `ws` only the reader coming back to the tab. */
export const useLive = (ws: WorkspaceName | undefined): Live => {
  const [live, setLive] = useState<Live>({ main: 0, comments: 0, signedOut: false });
  useEffect(() => {
    let socket: WebSocket | undefined;
    let stopped = false;
    let failures = 0;
    let heardAt = Date.now();
    let caughtUpAt = Date.now();
    let retry: ReturnType<typeof setTimeout> | undefined;
    let expiry: ReturnType<typeof setTimeout> | undefined;

    const bump = (main: number, comments: number) =>
      setLive((now) => ({ ...now, main: now.main + main, comments: now.comments + comments }));
    const setSignedOut = (signedOut: boolean) =>
      setLive((now) => (now.signedOut === signedOut ? now : { ...now, signedOut }));
    const catchUp = () => {
      if (Date.now() - caughtUpAt < catchUpGap) {
        return;
      }
      caughtUpAt = Date.now();
      bump(1, 1);
    };
    /** A socket that closed or never opened may have been refused for an expired sign-in: the API says. */
    const checkSignIn = async () => {
      const signedIn = await isSignedIn();
      if (!stopped && signedIn !== undefined) {
        setSignedOut(!signedIn);
      }
    };
    const heard = Match.type<Signal>().pipe(
      Match.discriminatorsExhaustive("kind")({
        main: () => bump(1, 0),
        comments: () => bump(0, 1),
        hello: ({ expiresAt }) => {
          // Access checked the sign-in only when the socket opened: open it again, through Access, once it expires.
          clearTimeout(expiry);
          expiry = setTimeout(
            () => {
              drop();
              connect();
            },
            Math.max(0, expiresAt - Date.now()) + 1000,
          );
        },
      }),
    );
    const drop = () => {
      clearTimeout(expiry);
      // The socket is forgotten first, so its close event is not taken for a failure.
      const closing = socket;
      socket = undefined;
      closing?.close();
    };
    const connect = () => {
      // A hidden tab keeps no socket: coming back to it connects, and catches up.
      if (stopped || ws === undefined || socket !== undefined || document.visibilityState === "hidden") {
        return;
      }
      const url = new URL(`/workspaces/${ws}/events`, globalThis.location.href);
      url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
      const current = new WebSocket(url);
      let isOpen = false;
      socket = current;
      heardAt = Date.now();
      current.addEventListener("open", () => {
        isOpen = true;
        failures = 0;
        heardAt = Date.now();
        setSignedOut(false);
        // Whatever changed before the socket opened, since the page was read or the last one closed, was not told to it.
        bump(1, 1);
      });
      current.addEventListener("message", (event: MessageEvent) => {
        heardAt = Date.now();
        if (typeof event.data !== "string" || event.data === "pong") {
          return;
        }
        const signal = signalOf(event.data);
        if (signal !== undefined) {
          heard(signal);
        }
      });
      current.addEventListener("close", (event: CloseEvent) => {
        if (socket !== current) {
          return;
        }
        socket = undefined;
        clearTimeout(expiry);
        if (!isOpen || event.code === 4001) {
          void checkSignIn();
        }
        schedule();
      });
    };
    /** Connect again after a pause that grows with each failure, unless the tab is hidden: coming back connects. */
    const schedule = () => {
      if (stopped || ws === undefined || retry !== undefined || document.visibilityState === "hidden") {
        return;
      }
      const delay = Math.min(maxBackoff, 1000 * 2 ** failures) * (0.5 + Math.random() / 2);
      failures += 1;
      retry = setTimeout(() => {
        retry = undefined;
        connect();
      }, delay);
    };
    const isDead = () =>
      (socket?.readyState === WebSocket.OPEN && Date.now() - heardAt > deadAfter) ||
      (socket?.readyState === WebSocket.CONNECTING && Date.now() - heardAt > connectTimeout);
    const returned = () => {
      if (document.visibilityState === "hidden") {
        return;
      }
      catchUp();
      if (isDead()) {
        drop();
      }
      if (socket === undefined) {
        clearTimeout(retry);
        retry = undefined;
        failures = 0;
        connect();
      }
    };
    const ping = setInterval(() => {
      if (isDead()) {
        drop();
        connect();
      } else if (socket?.readyState === WebSocket.OPEN) {
        socket.send("ping");
      }
    }, pingEvery);

    connect();
    const events = ["focus", "pageshow", "online"] as const;
    for (const name of events) {
      globalThis.addEventListener(name, returned);
    }
    document.addEventListener("visibilitychange", returned);
    return () => {
      stopped = true;
      drop();
      clearTimeout(retry);
      clearInterval(ping);
      for (const name of events) {
        globalThis.removeEventListener(name, returned);
      }
      document.removeEventListener("visibilitychange", returned);
    };
  }, [ws]);
  return live;
};

type Signal =
  | { readonly kind: "main" }
  | { readonly kind: "comments" }
  | { readonly kind: "hello"; readonly expiresAt: number };

/** What the object sent, or `undefined` for anything this viewer does not know. */
const signalOf = (data: string): Signal | undefined => {
  try {
    const value: unknown = JSON.parse(data);
    if (typeof value !== "object" || value === null || !("kind" in value)) {
      return undefined;
    }
    if (value.kind === "main" || value.kind === "comments") {
      return { kind: value.kind };
    }
    if (value.kind === "hello" && "expiresAt" in value && typeof value.expiresAt === "number") {
      return { kind: "hello", expiresAt: value.expiresAt };
    }
    return undefined;
  } catch {
    return undefined;
  }
};
