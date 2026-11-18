import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import { createLocalJWKSet, exportJWK, generateKeyPair, type JWTPayload, SignJWT } from "jose";
import * as Access from "../Access.ts";

// Cloudflare Access for tests: a signing key of its own in place of the team's,
// and the assertions Access would put on a request from each kind of caller.
// The Worker sees a request through Access as one with `Cf-Access-Jwt-Assertion`
// set, so a test sends that header itself.

const issuer = "https://pecia-test.cloudflareaccess.com";
const audience = "pecia-test-aud";
// What Access signs for a service token: its client ID as `common_name`, and an empty subject.
const orchestratorClientId = "orchestrator.access";
const sandboxClientId = "sandbox.access";

export interface TestAccess {
  readonly service: Access.Access["Service"];
  /** The sandbox token's secret, as the service hands it to sandboxes. */
  readonly sandboxClientSecret: string;
  /** The header Access adds for a caller with these claims, or with another key when `forged`. */
  readonly assertion: (claims: JWTPayload, options?: { readonly forged?: true }) => Promise<Record<string, string>>;
  readonly orchestrator: () => Promise<Record<string, string>>;
  readonly sandbox: () => Promise<Record<string, string>>;
  readonly person: (email: string) => Promise<Record<string, string>>;
  /** The orchestrator token's headers, as a script sends them to Access. */
  readonly orchestratorToken: Readonly<Record<string, string>>;
  /**
   * What Access does to a request's headers on the way in: a known service
   * token's headers become its assertion. Anything else passes as it is, so a
   * test can send an assertion of its own.
   */
  readonly edge: (headers: Headers) => Promise<void>;
}

export const makeTestAccess = async (): Promise<TestAccess> => {
  const signing = await generateKeyPair("RS256");
  const forger = await generateKeyPair("RS256");
  const keys = createLocalJWKSet({ keys: [{ ...(await exportJWK(signing.publicKey)), alg: "RS256", kid: "test" }] });
  const sandboxClientSecret = "test-sandbox-client-secret";
  const orchestratorClientSecret = "test-orchestrator-client-secret";
  const assertion: TestAccess["assertion"] = async (claims, options) => ({
    "cf-access-jwt-assertion": await new SignJWT({ iss: issuer, aud: audience, ...claims })
      .setProtectedHeader({ alg: "RS256", kid: "test" })
      .setIssuedAt()
      .setExpirationTime("1h")
      .sign(options?.forged === true ? forger.privateKey : signing.privateKey),
  });
  const orchestrator = () => assertion({ common_name: orchestratorClientId, sub: "" });
  const sandbox = () => assertion({ common_name: sandboxClientId, sub: "" });
  const tokens = new Map([
    [`${orchestratorClientId}:${orchestratorClientSecret}`, orchestrator],
    [`${sandboxClientId}:${sandboxClientSecret}`, sandbox],
  ]);
  return {
    service: Access.make(
      Effect.succeed({
        issuer,
        audience,
        orchestratorClientId,
        sandboxClientId,
        sandboxClientSecret: Redacted.make(sandboxClientSecret),
      }),
      keys,
    ),
    sandboxClientSecret,
    assertion,
    orchestrator,
    sandbox,
    person: (email) => assertion({ email, sub: `user-${email}` }),
    orchestratorToken: {
      "cf-access-client-id": orchestratorClientId,
      "cf-access-client-secret": orchestratorClientSecret,
    },
    edge: async (headers) => {
      const token = tokens.get(`${headers.get("cf-access-client-id")}:${headers.get("cf-access-client-secret")}`);
      if (token === undefined) return;
      headers.set("cf-access-jwt-assertion", (await token())["cf-access-jwt-assertion"] ?? "");
    },
  };
};
