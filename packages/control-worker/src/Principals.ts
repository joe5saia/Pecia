import { PrincipalId } from "@pecia/wiki-api";
import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

// The people pecia knows, and the workload identity issuers it trusts
// (docs/mcp.md, "Principals" and "Trust table"). The principals are the
// install's own, from `PECIA_PRINCIPALS`; worker.ts declares the
// issuers. Access's "People" policy is built from the same principals.

/** A workload identity that acts for a principal: the issuer, and the user it names in `userClaim`. */
export const WorkloadIdentity = Schema.Struct({ issuer: Schema.String, user: Schema.String });
export type WorkloadIdentity = typeof WorkloadIdentity.Type;

export const Principal = Schema.Struct({
  /** Stable and never reused: grants, session bindings and comments keep it. */
  id: PrincipalId,
  /** The Access login, and for display. An email can be reassigned, so nothing is keyed by it. */
  email: Schema.String,
  workloads: Schema.Array(WorkloadIdentity),
});
export type Principal = typeof Principal.Type;

/**
 * The principals as JSON in `PECIA_PRINCIPALS`, set where the deploy
 * runs (docs/deploy.md); the scenarios bind their own. Access's "People"
 * policy, the consent page, the MCP endpoint and the token exchange all read
 * this one list, so removing a principal shuts every path at once.
 */
export const fromEnvironment = Config.schema(Schema.fromJsonString(Schema.Array(Principal)), "PECIA_PRINCIPALS");

/** One issuer of identity tokens that the token exchange accepts. */
export interface WorkloadIssuer {
  readonly issuer: string;
  readonly jwksUri: string;
  /** The algorithms its tokens may use. The algorithm comes from here, never from a token's header. */
  readonly algorithms: ReadonlyArray<string>;
  /** Claims a token must have with exactly these values. */
  readonly requiredClaims: Readonly<Record<string, string>>;
  /** The claim matched against a principal's workload `user`. */
  readonly userClaim: string;
  /** The claim a session's binding names, such as an Amp thread ID. */
  readonly subjectClaim: string;
  /** The oldest an accepted token may be, by its `iat`. */
  readonly maxAgeSeconds: number;
}

export class Principals extends Context.Service<
  Principals,
  {
    readonly byEmail: (email: string) => Principal | undefined;
    readonly byId: (id: PrincipalId) => Principal | undefined;
    readonly byWorkload: (issuer: string, user: string) => Principal | undefined;
    readonly issuer: (issuer: string) => WorkloadIssuer | undefined;
  }
>()("pecia/Principals") {}

/** The first value that occurs twice in `values`, if one does. */
const duplicate = (values: ReadonlyArray<string>): string | undefined =>
  values.find((value, index) => values.indexOf(value) !== index);

const workloadKey = (identity: WorkloadIdentity) => `${identity.issuer} ${identity.user}`;

/** The lists as a service. Two principals with one ID, email or workload identity is a broken deploy, so it dies. */
export const make = Effect.fn("Principals.make")(function* (
  principals: ReadonlyArray<Principal>,
  issuers: ReadonlyArray<WorkloadIssuer>,
): Effect.fn.Return<Principals["Service"]> {
  const clashes = [
    duplicate(principals.map((principal) => principal.id)),
    duplicate(principals.map((principal) => principal.email.toLowerCase())),
    duplicate(principals.flatMap((principal) => principal.workloads.map((identity) => workloadKey(identity)))),
    duplicate(issuers.map((issuer) => issuer.issuer)),
  ].filter((clash) => clash !== undefined);
  if (clashes.length > 0) {
    return yield* Effect.die(new Error(`principals or issuers repeat: ${clashes.join(", ")}`));
  }
  // The orchestrator token's edits go under this name (docs/editing.md, "Auth").
  if (principals.some((principal) => principal.id === "orchestrator")) {
    return yield* Effect.die(new Error("no principal may have the id 'orchestrator'"));
  }
  return {
    byEmail: (email) => principals.find((principal) => principal.email.toLowerCase() === email.toLowerCase()),
    byId: (id) => principals.find((principal) => principal.id === id),
    byWorkload: (issuer, user) =>
      principals.find((principal) =>
        principal.workloads.some((identity) => workloadKey(identity) === `${issuer} ${user}`),
      ),
    issuer: (issuer) => issuers.find((entry) => entry.issuer === issuer),
  };
});
