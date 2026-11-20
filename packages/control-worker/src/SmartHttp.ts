import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";

// The three calls of git's smart HTTP protocol that a land makes itself: read a
// ref, fetch the pack of what one commit has and another lacks, and push a pack.
// isomorphic-git cannot say "I have this commit" for a commit it holds no
// objects of, which is what keeps a land from downloading the whole wiki.
// https://git-scm.com/docs/http-protocol, https://git-scm.com/docs/pack-protocol

export class SmartHttpError extends Data.TaggedError("SmartHttpError")<{
  readonly operation: string;
  readonly reason: string;
}> {
  override get message() {
    return `${this.operation} failed: ${this.reason}`;
  }
}

/** A repo's git remote and the Basic credentials for it. */
export interface Endpoint {
  readonly url: string;
  readonly username: string;
  readonly password: Redacted.Redacted;
}

export type FetchedPack =
  | { readonly _tag: "Pack"; readonly pack: Uint8Array }
  /** The remote does not have the commit it was told we have, so it would send everything. Nothing was downloaded. */
  | { readonly _tag: "NoCommonCommit" }
  /** The pack is over `maxBytes`. The download stopped there. */
  | { readonly _tag: "TooLarge" };

export type Pushed =
  | { readonly _tag: "Updated" }
  /** The remote unpacked the objects and refused to move the ref, e.g. because it is no longer at `from`. */
  | { readonly _tag: "Rejected"; readonly reason: string };

/** What a function below throws; `request` turns it into a `SmartHttpError`. */
class ProtocolError extends Error {}

/** An error's message and those of its causes: `fetch` says only "fetch failed" and puts the reason in `cause`. */
const describe = (cause: unknown): string => {
  if (!(cause instanceof Error)) {
    return typeof cause === "string" ? cause : (JSON.stringify(cause) ?? "unknown error");
  }
  return cause.cause === undefined ? cause.message : `${cause.message}: ${describe(cause.cause)}`;
};

const encoder = new TextEncoder();
const decoder = new TextDecoder();

const pkt = (text: string): Uint8Array<ArrayBuffer> => {
  const payload = encoder.encode(text);
  const line = new Uint8Array(payload.byteLength + 4);
  line.set(encoder.encode((payload.byteLength + 4).toString(16).padStart(4, "0")));
  line.set(payload, 4);
  return line;
};
const flushPkt = encoder.encode("0000");

const concat = (parts: ReadonlyArray<Uint8Array>): Uint8Array<ArrayBuffer> => {
  const joined = new Uint8Array(parts.reduce((total, part) => total + part.byteLength, 0));
  let offset = 0;
  for (const part of parts) {
    joined.set(part, offset);
    offset += part.byteLength;
  }
  return joined;
};

/** The payload of the pkt-line at the start of `bytes` and its length on the wire, `"flush"`, or `undefined` if it is not all there yet. */
const firstPkt = (
  bytes: Uint8Array,
): { readonly payload: Uint8Array | "flush"; readonly length: number } | undefined => {
  if (bytes.byteLength < 4) {
    return undefined;
  }
  const header = decoder.decode(bytes.subarray(0, 4));
  const length = /^[0-9a-f]{4}$/.test(header) ? Number.parseInt(header, 16) : Number.NaN;
  if (length === 0) {
    return { payload: "flush", length: 4 };
  }
  // 1 to 3 are not lengths: they are markers of protocol v2, which is not asked for.
  if (Number.isNaN(length) || length < 4) {
    throw new ProtocolError(`'${header}' is not a pkt-line length`);
  }
  return bytes.byteLength < length ? undefined : { payload: bytes.subarray(4, length), length };
};

/** The pkt-lines of a response body, read as it arrives. Stopping early cancels the download. */
const pktLines = async function* (body: ReadableStream<Uint8Array>): AsyncGenerator<Uint8Array | "flush"> {
  const reader = body.getReader();
  let pending: Uint8Array = new Uint8Array(0);
  try {
    for (let read = await reader.read(); !read.done; read = await reader.read()) {
      pending = pending.byteLength === 0 ? read.value : concat([pending, read.value]);
      for (let line = firstPkt(pending); line !== undefined; line = firstPkt(pending)) {
        pending = pending.subarray(line.length);
        yield line.payload;
      }
    }
    if (pending.byteLength > 0) {
      throw new ProtocolError("the response ends inside a pkt-line");
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
};

const textOf = (payload: Uint8Array): string => decoder.decode(payload).replace(/\n$/, "");

const authorization = (endpoint: Endpoint): string =>
  `Basic ${btoa(`${endpoint.username}:${Redacted.value(endpoint.password)}`)}`;

/** Send one request of `service` and hand its response to `read`. Every way it can fail becomes a `SmartHttpError`. */
const request = <A>(
  operation: string,
  endpoint: Endpoint,
  send: { readonly path: string; readonly service?: string; readonly body?: Uint8Array<ArrayBuffer> },
  read: (response: Response) => Promise<A>,
): Effect.Effect<A, SmartHttpError> =>
  Effect.tryPromise({
    try: async (signal) => {
      const response = await fetch(`${endpoint.url}/${send.path}`, {
        method: send.body === undefined ? "GET" : "POST",
        headers: {
          authorization: authorization(endpoint),
          ...(send.service === undefined
            ? {}
            : {
                "content-type": `application/x-${send.service}-request`,
                accept: `application/x-${send.service}-result`,
              }),
        },
        ...(send.body === undefined ? {} : { body: send.body }),
        signal,
      });
      if (!response.ok) {
        await response.body?.cancel();
        throw new ProtocolError(`the remote answered HTTP ${response.status}`);
      }
      return await read(response);
    },
    // What `fetch` and the parsing above throw is classified once, here.
    catch: (cause) => new SmartHttpError({ operation, reason: describe(cause) }),
  });

const bodyOf = (response: Response): ReadableStream<Uint8Array> => {
  if (response.body === null) {
    throw new ProtocolError("the response has no body");
  }
  return response.body;
};

/** The commit `ref` points at on the remote, or `undefined` if the remote has no such ref. */
export const advertised = (endpoint: Endpoint, ref: string): Effect.Effect<string | undefined, SmartHttpError> =>
  request(`read ${ref}`, endpoint, { path: "info/refs?service=git-upload-pack" }, async (response) => {
    for await (const line of pktLines(bodyOf(response))) {
      if (line === "flush") {
        continue;
      }
      // `<sha> <ref>`, and on the first ref a NUL and the remote's capabilities.
      const [sha, name] = (textOf(line).split("\0")[0] ?? "").split(" ");
      if (name === ref && sha !== undefined) {
        return sha;
      }
    }
    return undefined;
  });

/**
 * Fetch the pack of everything `want` has and `have` lacks, as the remote
 * computes it. The pack is not thin: every object it needs is in it.
 */
export const fetchPack = (
  endpoint: Endpoint,
  options: { readonly want: string; readonly have: string; readonly maxBytes: number },
): Effect.Effect<FetchedPack, SmartHttpError> =>
  request(
    `fetch ${options.want}`,
    endpoint,
    {
      path: "git-upload-pack",
      service: "git-upload-pack",
      body: concat([
        pkt(`want ${options.want} side-band-64k ofs-delta no-progress agent=pecia\n`),
        flushPkt,
        pkt(`have ${options.have}\n`),
        pkt("done\n"),
      ]),
    },
    async (response): Promise<FetchedPack> => {
      const lines = pktLines(bodyOf(response));
      const first = await lines.next();
      const answer = first.done || first.value === "flush" ? "" : textOf(first.value);
      // Without `multi_ack` the remote says one thing before the pack: `ACK <have>` if it has the
      // commit, `NAK` if not. After a NAK the pack is the whole history, which nobody asked for.
      if (answer === "NAK") {
        await lines.return(undefined);
        return { _tag: "NoCommonCommit" };
      }
      if (answer !== `ACK ${options.have}`) {
        throw new ProtocolError(`the remote answered '${answer.slice(0, 200)}' where ACK or NAK belongs`);
      }
      const parts: Array<Uint8Array> = [];
      let bytes = 0;
      for await (const line of lines) {
        if (line === "flush") {
          break;
        }
        // Side-band: 1 carries the pack, 2 progress for a person, 3 an error.
        const band = line[0];
        if (band === 3) {
          throw new ProtocolError(`the remote reported: ${textOf(line.subarray(1)).slice(0, 200)}`);
        }
        if (band !== 1) {
          continue;
        }
        bytes += line.byteLength - 1;
        if (bytes > options.maxBytes) {
          return { _tag: "TooLarge" };
        }
        parts.push(line.subarray(1));
      }
      return { _tag: "Pack", pack: concat(parts) };
    },
  );

/**
 * Push `pack` and move `ref` from `from` to `to`. The remote moves the ref only
 * if it is still at `from`.
 */
export const pushPack = (
  endpoint: Endpoint,
  options: { readonly ref: string; readonly from: string; readonly to: string; readonly pack: Uint8Array },
): Effect.Effect<Pushed, SmartHttpError> =>
  request(
    `push ${options.ref}`,
    endpoint,
    {
      path: "git-receive-pack",
      service: "git-receive-pack",
      body: concat([
        pkt(`${options.from} ${options.to} ${options.ref}\0 report-status agent=pecia\n`),
        flushPkt,
        options.pack,
      ]),
    },
    async (response): Promise<Pushed> => {
      const report: Array<string> = [];
      for await (const line of pktLines(bodyOf(response))) {
        if (line !== "flush") {
          report.push(textOf(line));
        }
      }
      // `unpack ok`, then `ok <ref>` or `ng <ref> <reason>`.
      const [unpack, update] = report;
      if (unpack !== "unpack ok") {
        throw new ProtocolError(`the remote answered '${(unpack ?? "").slice(0, 200)}'`);
      }
      if (update === `ok ${options.ref}`) {
        return { _tag: "Updated" };
      }
      const refused = `ng ${options.ref} `;
      if (update?.startsWith(refused) === true) {
        return { _tag: "Rejected", reason: update.slice(refused.length) };
      }
      throw new ProtocolError(`the remote did not report on ${options.ref}`);
    },
  );
