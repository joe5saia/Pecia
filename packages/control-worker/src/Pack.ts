import * as Predicate from "effect/Predicate";
import { inflateSync } from "node:zlib";

// Measures a git packfile before anything unpacks it. A pack says how many
// objects it holds, and each object says how large it is once inflated, so a
// pack that would not fit in memory can be refused while it is still only its
// compressed bytes. https://git-scm.com/docs/pack-format

export interface PackLimits {
  /** Objects in the pack. Each one costs index memory, however small it is. */
  readonly objects: number;
  /** Bytes of one object once inflated: what reading that object puts in memory at once. */
  readonly objectBytes: number;
  /** Bytes of all objects once inflated: what indexing the pack has to inflate, one object at a time. */
  readonly inflatedBytes: number;
}

export type PackSize =
  | { readonly _tag: "Fits"; readonly objects: number; readonly inflatedBytes: number }
  | { readonly _tag: "Exceeds"; readonly limit: keyof PackLimits }
  | { readonly _tag: "Malformed"; readonly reason: string };

const exceeds = (limit: keyof PackLimits): PackSize => ({ _tag: "Exceeds", limit });
const malformed = (reason: string): PackSize => ({ _tag: "Malformed", reason });

const signature = 0x5041434b; // "PACK"
const headerBytes = 12;
/** A pack ends with the SHA-1 of everything before it. */
const trailerBytes = 20;

const ofsDelta = 6;
const refDelta = 7;

interface Entry {
  /** The inflated size of the entry's data: the object itself, or the delta that builds it. */
  readonly size: number;
  readonly isDelta: boolean;
  /** Where the entry's zlib stream starts. */
  readonly data: number;
}

/** The header of the entry at `offset`: a type, a size and, for a delta, a reference to its base. */
const entryAt = (pack: Uint8Array, offset: number): Entry | undefined => {
  let cursor = offset;
  let byte = pack[cursor++];
  if (byte === undefined) return undefined;
  const type = (byte >> 4) & 7;
  let size = byte & 15;
  // Multiplied, not shifted: a size can be wider than 32 bits.
  let scale = 16;
  while (byte & 0x80) {
    byte = pack[cursor++];
    if (byte === undefined) return undefined;
    size += (byte & 0x7f) * scale;
    scale *= 128;
  }
  if (type === refDelta) return { size, isDelta: true, data: cursor + 20 };
  if (type === ofsDelta) {
    // The distance back to the base, in as many bytes as have their high bit set, plus one.
    do {
      byte = pack[cursor++];
      if (byte === undefined) return undefined;
    } while (byte & 0x80);
    return { size, isDelta: true, data: cursor };
  }
  // 1 to 4 are commit, tree, blob and tag. Nothing else is a type.
  return type >= 1 && type <= 4 ? { size, isDelta: false, data: cursor } : undefined;
};

/** The size of the object a delta builds: the second of the two numbers the delta starts with. */
const deltaResultSize = (delta: Uint8Array): number | undefined => {
  let cursor = 0;
  let value = 0;
  for (let number = 0; number < 2; number++) {
    value = 0;
    let scale = 1;
    let byte: number | undefined;
    do {
      byte = delta[cursor++];
      if (byte === undefined) return undefined;
      value += (byte & 0x7f) * scale;
      scale *= 128;
    } while (byte & 0x80);
  }
  return value;
};

/**
 * Inflate the zlib stream at the start of `input`, which goes on past the
 * stream's end, into at most `maxBytes`. Returns the bytes and how much of the
 * input the stream took, or `undefined` if it is not a stream that fits.
 */
const inflate = (
  input: Uint8Array,
  maxBytes: number,
): { readonly bytes: Uint8Array; readonly consumed: number } | undefined => {
  try {
    // With `info` the result is `{ buffer, engine }`, which the declared return type does not say.
    const result: unknown = inflateSync(input, { info: true, maxOutputLength: Math.max(1, maxBytes) });
    return Predicate.hasProperty(result, "buffer") &&
      result.buffer instanceof Uint8Array &&
      Predicate.hasProperty(result, "engine") &&
      Predicate.hasProperty(result.engine, "bytesWritten") &&
      typeof result.engine.bytesWritten === "number"
      ? { bytes: result.buffer, consumed: result.engine.bytesWritten }
      : undefined;
  } catch {
    // Not zlib data, or more of it than `maxBytes`.
    return undefined;
  }
};

/**
 * Whether `pack` is within `limits`. It inflates one object at a time, never
 * more than `limits.objectBytes` of it, and stops at the first limit exceeded.
 */
export const measure = (pack: Uint8Array, limits: PackLimits): PackSize => {
  if (pack.byteLength < headerBytes + trailerBytes) return malformed("too short to be a pack");
  const view = new DataView(pack.buffer, pack.byteOffset, pack.byteLength);
  if (view.getUint32(0) !== signature) return malformed("does not start with PACK");
  const version = view.getUint32(4);
  if (version !== 2 && version !== 3) return malformed(`pack version ${version}`);
  const objects = view.getUint32(8);
  if (objects > limits.objects) return exceeds("objects");

  const end = pack.byteLength - trailerBytes;
  let offset = headerBytes;
  let inflatedBytes = 0;
  for (let index = 0; index < objects; index++) {
    const entry = entryAt(pack, offset);
    if (entry === undefined || entry.data > end) return malformed(`object ${index} has no valid header`);
    if (entry.size > limits.objectBytes) return exceeds("objectBytes");
    const data = inflate(pack.subarray(entry.data, end), entry.size);
    if (data === undefined || data.bytes.byteLength !== entry.size) {
      return malformed(`object ${index} does not inflate to the size its header gives`);
    }
    const size = entry.isDelta ? deltaResultSize(data.bytes) : entry.size;
    if (size === undefined) return malformed(`object ${index} is a delta without a header`);
    if (size > limits.objectBytes) return exceeds("objectBytes");
    inflatedBytes += size;
    if (inflatedBytes > limits.inflatedBytes) return exceeds("inflatedBytes");
    offset = entry.data + data.consumed;
  }
  return offset === end ? { _tag: "Fits", objects, inflatedBytes } : malformed("has data after its last object");
};
