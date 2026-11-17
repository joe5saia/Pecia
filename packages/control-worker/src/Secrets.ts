import * as Effect from "effect/Effect";

// What the service does with the secrets it issues and checks: session keys
// (Workspace.ts) and the orchestrator key with its login cookie (Login.ts).

/** Whether two strings are equal, in time that does not depend on where they differ. */
export const sameText = (a: string, b: string): boolean => {
  let difference = a.length ^ b.length;
  for (let index = 0; index < a.length; index++)
    difference |= a.charCodeAt(index) ^ b.charCodeAt(index % (b.length || 1));
  return difference === 0;
};

/** `byteLength` random bytes, as hex. */
export const randomHex = (byteLength: number): Effect.Effect<string> =>
  Effect.sync(() => crypto.getRandomValues(new Uint8Array(byteLength)).toHex());

/** The SHA-256 digest of `text`, as hex. */
export const sha256Hex = (text: string): Effect.Effect<string> =>
  Effect.map(
    Effect.promise(() => crypto.subtle.digest("SHA-256", new TextEncoder().encode(text))),
    (digest) => new Uint8Array(digest).toHex(),
  );
