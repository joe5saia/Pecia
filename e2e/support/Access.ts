import * as Effect from "effect/Effect";
import { decodeJwt, exportJWK, generateKeyPair, SignJWT } from "jose";
import type { JWTPayload } from "jose";

// A stand-in for Cloudflare Access, the only place the scenarios know how
// callers prove who they are. Access stands in front of every URL of a stage:
// it signs callers in, then passes each request on with an assertion, a JWT
// in `Cf-Access-Jwt-Assertion`, that the Worker verifies against the team's
// keys. Here the keys are the harness's own, served to the Worker in place of
// the team's (`workerd/outbound.ts`), and `edge` is what Access does to a
// request on its way in.

/** The Access team the Worker trusts, which the server binds as `PECIA_ACCESS_TEAM`. */
export const accessTeam = "https://pecia-e2e.cloudflareaccess.com";

/** Headers a caller sends, or that Access adds. */
export type Headers = Readonly<Record<string, string>>;

/** A stage's service token. */
export interface ServiceToken {
  readonly clientId: string;
  readonly clientSecret: string;
}

export interface Access {
  /** The stage's Access application's AUD tag, which every assertion carries. */
  readonly audience: string;
  /** The team's signing keys, as Access serves them. */
  readonly jwks: string;
  /** The stage's two service tokens. The Worker hands the sandbox token to each new session. */
  readonly orchestratorToken: ServiceToken;
  readonly sandboxToken: ServiceToken;
  /** The headers an orchestrator or script sends: the orchestrator token. */
  readonly orchestrator: Headers;
  /** What a browser of a person Access signed in sends: the `CF_Authorization` cookie, whose value is an assertion. */
  readonly person: (email: string, options?: { readonly expiresIn?: string }) => Effect.Effect<Headers>;
  /**
   * The assertion header Access adds for a caller with these claims, signed
   * with another key when `forged`. Sent as it is, it reaches the Worker
   * unchanged.
   */
  readonly assertion: (claims: JWTPayload, options?: { readonly forged?: true }) => Effect.Effect<Headers>;
  /**
   * What Access does to a request's headers on the way in: a known service
   * token's headers, or a person's cookie, become the assertion. Anything else
   * passes as it is. A person whose cookie has expired is not let through:
   * `"expired"` says so, and the edge answers as Access does.
   */
  readonly edge: (headers: globalThis.Headers) => Promise<"expired" | undefined>;
}

export const makeAccess: Effect.Effect<Access> = Effect.promise(async () => {
  const signing = await generateKeyPair("RS256", { extractable: true });
  const forger = await generateKeyPair("RS256");
  const audience = "pecia-e2e-aud";
  // What Access signs for a service token: its client ID as `common_name`, and an empty subject.
  const orchestratorToken = { clientId: "orchestrator.access", clientSecret: "e2e-orchestrator-secret" };
  const sandboxToken = { clientId: "sandbox.access", clientSecret: "e2e-sandbox-secret" };
  const sign = (claims: JWTPayload, forged = false, expiresIn = "1h") =>
    new SignJWT({ iss: accessTeam, aud: audience, ...claims })
      .setProtectedHeader({ alg: "RS256", kid: "e2e" })
      .setIssuedAt()
      .setExpirationTime(expiresIn)
      .sign(forged ? forger.privateKey : signing.privateKey);
  const forToken = new Map([
    [`${orchestratorToken.clientId}:${orchestratorToken.clientSecret}`, orchestratorToken.clientId],
    [`${sandboxToken.clientId}:${sandboxToken.clientSecret}`, sandboxToken.clientId],
  ]);
  const jwk = { ...(await exportJWK(signing.publicKey)), alg: "RS256", kid: "e2e" };
  return {
    audience,
    jwks: JSON.stringify({ keys: [jwk] }),
    orchestratorToken,
    sandboxToken,
    orchestrator: {
      "cf-access-client-id": orchestratorToken.clientId,
      "cf-access-client-secret": orchestratorToken.clientSecret,
    },
    person: (email, options) =>
      Effect.promise(async () => ({
        cookie: `CF_Authorization=${await sign({ email, sub: `user-${email}` }, false, options?.expiresIn)}`,
      })),
    assertion: (claims, options) =>
      Effect.promise(async () => ({ "cf-access-jwt-assertion": await sign(claims, options?.forged === true) })),
    edge: async (headers) => {
      const token = forToken.get(`${headers.get("cf-access-client-id")}:${headers.get("cf-access-client-secret")}`);
      if (token !== undefined) {
        headers.set("cf-access-jwt-assertion", await sign({ common_name: token, sub: "" }));
        return undefined;
      }
      const cookie = /(?:^|;\s*)CF_Authorization=([^;]+)/.exec(headers.get("cookie") ?? "")?.[1];
      if (cookie === undefined) {
        return undefined;
      }
      const { exp } = decodeJwt(cookie);
      if (exp !== undefined && exp * 1000 <= Date.now()) {
        return "expired";
      }
      headers.set("cf-access-jwt-assertion", cookie);
      return undefined;
    },
  };
});
