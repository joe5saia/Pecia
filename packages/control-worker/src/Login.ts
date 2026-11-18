import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import { sameText } from "./Secrets.ts";

// The reader cookie (docs/viewer.md, "Logging in"). A browser that presented
// the orchestrator key gets `<expires>.<name>.<signature>`: the expiry in Unix
// seconds and the name it gave for its comments (base64url), signed with
// HMAC-SHA-256 under that key. A login without a name gets
// `<expires>.<signature>`, the form every cookie had before comments. The key
// itself never leaves the login request, a stolen cookie stops working when it
// expires, and changing the key ends every login.

export const cookieLifetime = Duration.days(7);

/** Whether `credential` is the key. An unset key matches nothing. */
export const isKey = (key: string, credential: string): boolean => key !== "" && sameText(credential, key);

/** What is signed: the expiry, and the encoded name if there is one. */
const signature = (key: string, signed: string): Effect.Effect<string> =>
  Effect.promise(async () => {
    const encoder = new TextEncoder();
    const hmac = await crypto.subtle.importKey("raw", encoder.encode(key), { name: "HMAC", hash: "SHA-256" }, false, [
      "sign",
    ]);
    const mac = await crypto.subtle.sign("HMAC", hmac, encoder.encode(`pecia-viewer:${signed}`));
    return new Uint8Array(mac).toBase64({ alphabet: "base64url", omitPadding: true });
  });

/** A cookie value for `name`, or for no name, that is valid until `cookieLifetime` from now. */
export const issue = Effect.fnUntraced(function* (
  key: string,
  name: string | undefined,
): Effect.fn.Return<{ readonly value: string; readonly expiresAt: DateTime.Utc }> {
  const now = yield* Clock.currentTimeMillis;
  const expires = Math.floor((now + Duration.toMillis(cookieLifetime)) / 1000);
  const signed =
    name === undefined
      ? `${expires}`
      : `${expires}.${new TextEncoder().encode(name).toBase64({ alphabet: "base64url", omitPadding: true })}`;
  return { value: `${signed}.${yield* signature(key, signed)}`, expiresAt: DateTime.makeUnsafe(expires * 1000) };
});

/** A cookie `verify` accepted, with the name it was issued for. */
export interface Login {
  readonly name: string | undefined;
}

/** The login of `value` if it is a cookie `issue` made under `key` that has not expired. */
export const verify = Effect.fnUntraced(function* (key: string, value: string): Effect.fn.Return<Login | undefined> {
  const match = /^((\d{1,12})(?:\.([\w-]{1,200}))?)\.([\w-]+)$/.exec(value);
  if (key === "" || match === null) return undefined;
  const [, signed = "", expires = "", encodedName, mac = ""] = match;
  if (Number(expires) * 1000 <= (yield* Clock.currentTimeMillis)) return undefined;
  if (!sameText(mac, yield* signature(key, signed))) return undefined;
  // Signed under the key, so the name is one `issue` encoded.
  return {
    name:
      encodedName === undefined
        ? undefined
        : new TextDecoder().decode(Uint8Array.fromBase64(encodedName, { alphabet: "base64url" })),
  };
});
