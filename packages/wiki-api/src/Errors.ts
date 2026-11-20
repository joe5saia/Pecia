import * as Schema from "effect/Schema";
import { EndedSessionState, SessionId } from "./Schemas.ts";

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

/** 404: unknown workspace, session, comment thread or comment, or a commit or file a wiki does not have. */
export class NotFound extends Schema.TaggedError<NotFound>()(
  "NotFound",
  { resource: Schema.Literals(["workspace", "session", "commit", "file", "thread", "comment"]), id: Schema.String },
  { httpApiStatus: 404 },
) {
  override get message(): string {
    return `${this.resource} '${this.id}' does not exist`;
  }
}

/** 409: the session has ended. It does not become active again, so the call is not worth repeating. */
export class SessionNotActive extends Schema.TaggedError<SessionNotActive>()(
  "SessionNotActive",
  { sessionId: SessionId, state: EndedSessionState },
  { httpApiStatus: 409 },
) {
  override get message(): string {
    return `session '${this.sessionId}' has ended (${this.state}) and can no longer push or land`;
  }
}

/**
 * 422: the session's fork adds more to main than the service lands at once. A
 * land holds the fork's new commits in the memory of a Worker, so their size
 * has a ceiling (docs/operations.md, "Landing limits"). Repeating the call does
 * not help: the work has to be landed in smaller steps.
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
      transferBytes: "its new commits pack to more than",
      objects: "its new commits have more objects than",
      objectBytes: "one of its files is more than",
      inflatedBytes: "its new commits unpack to more than",
    } as const satisfies Record<ForkTooLarge["limit"], string>;
    const unit = this.limit === "objects" ? "" : " bytes";
    return `the fork is too large to land: ${what[this.limit]} ${this.max}${unit}`;
  }
}

/**
 * 422: a comment's anchor does not fit the page it is for: the page is not
 * text, the range is not inside it, or the quoted text is not in it exactly
 * once. Repeating the call does not help; change the anchor.
 */
export class AnchorMismatch extends Schema.TaggedError<AnchorMismatch>()(
  "AnchorMismatch",
  {
    path: Schema.String,
    reason: Schema.Literals(["not_text", "out_of_range", "quote_not_found", "quote_ambiguous", "page_not_edited"]),
  },
  { httpApiStatus: 422 },
) {
  override get message(): string {
    const why = {
      not_text: "is not text",
      out_of_range: "has no such range",
      quote_not_found: "does not contain the quoted text",
      quote_ambiguous: "contains the quoted text more than once; quote more of it",
      page_not_edited: "is not a page the edit writes, so the edit cannot say where a passage of it is",
    } as const satisfies Record<AnchorMismatch["reason"], string>;
    return `'${this.path}' ${why[this.reason]}`;
  }
}

/**
 * 403: the caller may not change this comment. A person edits and deletes only
 * comments under their own name; an agent never edits, and deletes only its
 * own session's comments.
 */
export class NotYourComment extends Schema.TaggedError<NotYourComment>()(
  "NotYourComment",
  { commentId: Schema.String, action: Schema.Literals(["edit", "delete"]) },
  { httpApiStatus: 403 },
) {
  override get message(): string {
    return `you may not ${this.action} comment '${this.commentId}'`;
  }
}

/**
 * 409: what the caller read has changed since: a thread's revision, a page's
 * set of threads, a fork's head or a page's content. Read it again and decide
 * whether the change still applies (docs/mcp.md, "Writes"; docs/editing.md).
 * For a page, `expected` and `actual` are its hashes, `none` where it does not exist.
 */
export class Conflict extends Schema.TaggedError<Conflict>()(
  "Conflict",
  {
    resource: Schema.Literals(["thread", "threads", "fork", "page"]),
    id: Schema.String,
    /** What the caller said it read, and what is there now. */
    expected: Schema.String,
    actual: Schema.String,
  },
  { httpApiStatus: 409 },
) {
  override get message(): string {
    const what = { thread: "thread", threads: "the threads of", fork: "the fork of session", page: "page" } as const;
    return `${what[this.resource]} '${this.id}' is at ${this.actual}, not ${this.expected}`;
  }
}

/**
 * 403: the session was started by another principal, or by an orchestrator
 * over the HTTP API. Only the principal that started a session over MCP may
 * land, end or comment through it.
 */
export class NotYourSession extends Schema.TaggedError<NotYourSession>()(
  "NotYourSession",
  { sessionId: SessionId },
  { httpApiStatus: 403 },
) {
  override get message(): string {
    return `session '${this.sessionId}' was not started by you over MCP`;
  }
}

/**
 * 422: an edit writes a page the service does not commit: it is over the size
 * limit, is not text, is where something other than a file is, has a path git
 * or a file system would not take, or is in a directory the service cannot
 * write back as it is. Repeating the call does not help (docs/editing.md).
 */
export class PageRefused extends Schema.TaggedError<PageRefused>()(
  "PageRefused",
  {
    path: Schema.String,
    reason: Schema.Literals([
      "too_large",
      "not_text",
      "not_a_file",
      "reserved_path",
      "invalid_path",
      "unwritable_directory",
    ]),
  },
  { httpApiStatus: 422 },
) {
  override get message(): string {
    const why = {
      too_large: "is larger than a page may be",
      not_text: "is not text",
      not_a_file: "is not a file: a directory, a link or a file in its way is there",
      reserved_path: "is inside .git, or a name some system reads as .git, where no page can be",
      invalid_path:
        "has a path that is not well-formed text, has a control character or a backslash, or has a name over 255 bytes",
      unwritable_directory:
        "is in a directory the service cannot write back as it is: one of its names is not UTF-8 text, or it is not as git writes one",
    } as const satisfies Record<PageRefused["reason"], string>;
    return `'${this.path}' ${why[this.reason]}`;
  }
}

/**
 * 403: a browser sent the call from a page of another site. The viewer's own
 * pages are the only ones that publish edits (docs/editing.md, "Auth").
 */
export class ForbiddenOrigin extends Schema.TaggedError<ForbiddenOrigin>()(
  "ForbiddenOrigin",
  { origin: Schema.String },
  { httpApiStatus: 403 },
) {
  override get message(): string {
    return `a page of '${this.origin}' may not publish edits`;
  }
}

/** 422: an idempotency key already names a request with other input. */
export class IdempotencyKeyReuse extends Schema.TaggedError<IdempotencyKeyReuse>()(
  "IdempotencyKeyReuse",
  { key: Schema.String },
  { httpApiStatus: 422 },
) {
  override get message(): string {
    return `idempotency key '${this.key}' was used for another request`;
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
