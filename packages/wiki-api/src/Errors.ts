import * as Schema from "effect/Schema";
import { SessionId } from "./Schemas.ts";

// Error responses of the Control Worker API (docs/mvp.md, "Control Worker API").
// Each is a typed failure in the service, a JSON body `{ "_tag": ..., ...fields }`
// with the status given here on the wire, and the same typed failure again in a
// client derived from the contract. `message` is for people and logs; it is not
// part of the body unless it is a field.

/** 401: the credential is missing or wrong. */
export class Unauthorized extends Schema.TaggedError<Unauthorized>()("Unauthorized", {}, { httpApiStatus: 401 }) {
  override get message(): string {
    return "the credential is missing or wrong";
  }
}

/** 404: unknown workspace or session. */
export class NotFound extends Schema.TaggedError<NotFound>()(
  "NotFound",
  { resource: Schema.Literals(["workspace", "session"]), id: Schema.String },
  { httpApiStatus: 404 },
) {
  override get message(): string {
    return `${this.resource} '${this.id}' does not exist`;
  }
}

/** 409: the session has ended. It does not become active again, so the call is not worth repeating. */
export class SessionNotActive extends Schema.TaggedError<SessionNotActive>()(
  "SessionNotActive",
  { sessionId: SessionId, state: Schema.Literals(["closed", "parked", "deleted"]) },
  { httpApiStatus: 409 },
) {
  override get message(): string {
    return `session '${this.sessionId}' has ended (${this.state}) and can no longer push or land`;
  }
}

/**
 * 422: the session's fork is larger than the service lands. A land clones the
 * fork into the memory of a Worker, so its size has a ceiling
 * (docs/operations.md, "Landing limits"). Repeating the call does not help: the
 * fork has to get smaller, or the wiki has outgrown landing in a Worker.
 */
export class ForkTooLarge extends Schema.TaggedError<ForkTooLarge>()(
  "ForkTooLarge",
  {
    /** The limit the fork exceeds. */
    limit: Schema.Literals(["transferBytes", "objects", "objectBytes", "inflatedBytes"]),
    /** The most the limit allows. */
    max: Schema.Number,
  },
  { httpApiStatus: 422 },
) {
  override get message(): string {
    const what = {
      transferBytes: "its packed history is more than",
      objects: "its history has more objects than",
      objectBytes: "one of its files is more than",
      inflatedBytes: "its unpacked history is more than",
    } as const satisfies Record<ForkTooLarge["limit"], string>;
    const unit = this.limit === "objects" ? "" : " bytes";
    return `the fork is too large to land: ${what[this.limit]} ${this.max}${unit}`;
  }
}

/** 502: an Artifacts call failed. Safe to retry. */
export class ArtifactsUnavailable extends Schema.TaggedError<ArtifactsUnavailable>()(
  "ArtifactsUnavailable",
  { message: Schema.String },
  { httpApiStatus: 502 },
) {}

/**
 * 503: the workspace could not take the call: it is overloaded or restarting.
 * Retry after a pause. The call may or may not have been applied, and no call
 * does harm when repeated (docs/operations.md, "API statuses").
 */
export class WorkspaceUnavailable extends Schema.TaggedError<WorkspaceUnavailable>()(
  "WorkspaceUnavailable",
  { message: Schema.String },
  { httpApiStatus: 503 },
) {}
