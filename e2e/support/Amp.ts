import * as Effect from "effect/Effect";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import type { JWTPayload } from "jose";

// A stand-in for Amp's workload identity (docs/mcp.md, "Layer 2"), which a
// sandbox's `amp orb id-token` gets its tokens from. The keys are the
// harness's own, served to the Worker in place of Amp's JWKS
// (`workerd/outbound.ts`), and the claims are those Amp signs.

/** Amp's issuer and the user of the principal `joe`, as packages/control-worker/src/worker.ts trusts them. */
export const ampIssuer = "https://ampcode.com/api/workload-identity";
export const joeAmpUser = "user_01JT10C8QGGPETCT6FTHWJ524K";

export interface Amp {
  /** Amp's signing keys, as its JWKS URL serves them. */
  readonly jwks: string;
  /**
   * An ID token as `amp orb id-token --audience <audience>` prints it in the
   * thread `threadId`. `claims` replaces or adds claims; `forged` signs it with
   * another key; `alg` names another algorithm in its header.
   */
  readonly idToken: (options: {
    readonly threadId: string;
    readonly audience: string;
    readonly userId?: string;
    readonly claims?: JWTPayload;
    readonly forged?: true;
    readonly expiresIn?: string;
    readonly issuedAt?: number;
  }) => Effect.Effect<string>;
}

export const makeAmp: Effect.Effect<Amp> = Effect.promise(async () => {
  const signing = await generateKeyPair("RS256", { extractable: true });
  const forger = await generateKeyPair("RS256");
  const jwk = { ...(await exportJWK(signing.publicKey)), alg: "RS256", kid: "e2e-amp", use: "sig" };
  return {
    jwks: JSON.stringify({ keys: [jwk] }),
    idToken: (options) =>
      Effect.promise(() => {
        const userId = options.userId ?? joeAmpUser;
        const token = new SignJWT({
          iss: ampIssuer,
          aud: options.audience,
          sub: `workspace:e2e:user:${userId}:thread:${options.threadId}`,
          token_use: "exchanged",
          user_id: userId,
          thread_id: options.threadId,
          email: "joe5saia@gmail.com",
          ...options.claims,
        })
          .setProtectedHeader({ alg: "RS256", kid: "e2e-amp", typ: "JWT" })
          .setIssuedAt(options.issuedAt)
          .setExpirationTime(options.expiresIn ?? "10m");
        return token.sign(options.forged === true ? forger.privateKey : signing.privateKey);
      }),
  };
});
