import * as Clock from "effect/Clock";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import { sameText } from "./Secrets.ts";

// The reader cookie (docs/viewer.md, "Logging in"). A browser that presented
// the orchestrator key gets `<expires>.<signature>`: the expiry in Unix
// seconds, signed with HMAC-SHA-256 under that key. The key itself never
// leaves the login request, a stolen cookie stops working when it expires,
// and changing the key ends every login.

export const cookieLifetime = Duration.days(7);

/** Whether `credential` is the key. An unset key matches nothing. */
export const isKey = (key: string, credential: string): boolean => key !== "" && sameText(credential, key);

const signature = (key: string, expires: number): Effect.Effect<string> =>
  Effect.promise(async () => {
    const encoder = new TextEncoder();
    const hmac = await crypto.subtle.importKey("raw", encoder.encode(key), { name: "HMAC", hash: "SHA-256" }, false, [
      "sign",
    ]);
    const signed = await crypto.subtle.sign("HMAC", hmac, encoder.encode(`pecia-viewer:${expires}`));
    return new Uint8Array(signed).toBase64({ alphabet: "base64url", omitPadding: true });
  });

/** A cookie value that is valid until `cookieLifetime` from now. */
export const issue = Effect.fnUntraced(function* (
  key: string,
): Effect.fn.Return<{ readonly value: string; readonly expiresAt: Date }> {
  const now = yield* Clock.currentTimeMillis;
  const expires = Math.floor((now + Duration.toMillis(cookieLifetime)) / 1000);
  return { value: `${expires}.${yield* signature(key, expires)}`, expiresAt: new Date(expires * 1000) };
});

/** Whether `value` is a cookie `issue` made under `key` that has not expired. */
export const verify = Effect.fnUntraced(function* (key: string, value: string): Effect.fn.Return<boolean> {
  const match = /^(\d{1,12})\.([\w-]+)$/.exec(value);
  if (key === "" || match === null) return false;
  const expires = Number(match[1]);
  if (expires * 1000 <= (yield* Clock.currentTimeMillis)) return false;
  return sameText(match[2] ?? "", yield* signature(key, expires));
});
