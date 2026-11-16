import { afterAll, beforeAll, describe, expect, it } from "@effect/vitest";
import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import * as Pack from "./Pack.ts";

// Packs made by real git, measured against what real git says is in them.

const run = promisify(execFile);
let repo: string;

const git = async (...args: string[]) => (await run("git", ["-C", repo, ...args])).stdout.trim();

/** A page of text that does not compress to nothing, so its versions are stored as deltas of each other. */
const page = () => randomBytes(24_000).toString("base64");

beforeAll(async () => {
  repo = await mkdtemp(join(tmpdir(), "pecia-pack-"));
  await git("init", "--quiet", "--initial-branch", "main");
  await git("config", "user.name", "test");
  await git("config", "user.email", "test@example.com");
  const first = page();
  // The larger version is the older one. Git stores old versions as deltas of
  // newer ones, so the largest object in the pack is a delta.
  await writeFile(join(repo, "page.md"), `${first}${"and a long tail ".repeat(200)}`);
  await writeFile(join(repo, "other.md"), "a short page\n");
  await git("add", "--all");
  await git("commit", "--quiet", "--message", "first");
  await writeFile(join(repo, "page.md"), first);
  await git("commit", "--quiet", "--all", "--message", "second");
});
afterAll(async () => {
  await rm(repo, { recursive: true, force: true });
});

/** Pack the whole history, with deltas that name their base by offset or by object ID. */
const pack = async (deltas: "by offset" | "by id"): Promise<Uint8Array> => {
  const flag = deltas === "by offset" ? "--delta-base-offset" : "";
  const { stdout } = await run(
    "sh",
    ["-c", `git -C "$0" rev-list --objects --all | git -C "$0" pack-objects --stdout --quiet ${flag}`, repo],
    { encoding: "buffer", maxBuffer: 64 * 1024 * 1024 },
  );
  return stdout;
};

/** What git says the history holds: the size of every object, largest first. */
const objectSizes = async (): Promise<ReadonlyArray<number>> => {
  const { stdout } = await run("sh", [
    "-c",
    `git -C "$0" rev-list --objects --all | cut -d' ' -f1 | git -C "$0" cat-file --batch-check='%(objectsize)'`,
    repo,
  ]);
  return stdout
    .trim()
    .split("\n")
    .map((size) => Number(size))
    .toSorted((a, b) => b - a);
};

const unlimited: Pack.PackLimits = { objects: 1e9, objectBytes: 1e9, inflatedBytes: 1e9 };

describe.each(["by offset", "by id"] as const)("measure, deltas %s", (deltas) => {
  it("counts the objects and their size once unpacked, deltas as what they build", async () => {
    const sizes = await objectSizes();
    const total = sizes.reduce((sum, size) => sum + size, 0);
    // Two commits, two root trees, two versions of the page and the other page.
    expect(sizes).toHaveLength(7);

    const bytes = await pack(deltas);
    // The pack is much smaller than the two versions of the page: one of them is a delta.
    expect(bytes.byteLength).toBeLessThan(total - 20_000);
    expect(Pack.measure(bytes, unlimited)).toEqual({ _tag: "Fits", objects: 7, inflatedBytes: total });
  });

  it("holds each limit at exactly the size git reports", async () => {
    const sizes = await objectSizes();
    const largest = sizes[0] ?? 0;
    const total = sizes.reduce((sum, size) => sum + size, 0);
    const bytes = await pack(deltas);
    const fits = { _tag: "Fits", objects: 7, inflatedBytes: total };

    expect(Pack.measure(bytes, { ...unlimited, objects: 7 })).toEqual(fits);
    expect(Pack.measure(bytes, { ...unlimited, objects: 6 })).toEqual({ _tag: "Exceeds", limit: "objects" });
    // The largest object is the old version of the page, which the pack holds as a small delta.
    expect(Pack.measure(bytes, { ...unlimited, objectBytes: largest })).toEqual(fits);
    expect(Pack.measure(bytes, { ...unlimited, objectBytes: largest - 1 })).toEqual({
      _tag: "Exceeds",
      limit: "objectBytes",
    });
    expect(Pack.measure(bytes, { ...unlimited, inflatedBytes: total })).toEqual(fits);
    expect(Pack.measure(bytes, { ...unlimited, inflatedBytes: total - 1 })).toEqual({
      _tag: "Exceeds",
      limit: "inflatedBytes",
    });
  });
});

describe("measure", () => {
  it("says a pack that is cut short, padded or not a pack is malformed", async () => {
    const bytes = await pack("by offset");
    const malformed = { _tag: "Malformed" };
    expect(Pack.measure(bytes.subarray(0, bytes.byteLength - 40), unlimited)).toMatchObject(malformed);
    expect(Pack.measure(bytes.subarray(0, 100), unlimited)).toMatchObject(malformed);
    expect(Pack.measure(Buffer.concat([bytes, Buffer.alloc(16)]), unlimited)).toMatchObject(malformed);
    expect(Pack.measure(new TextEncoder().encode("not a pack ".repeat(8)), unlimited)).toMatchObject(malformed);
    expect(Pack.measure(new Uint8Array(4), unlimited)).toMatchObject(malformed);

    // An object whose header claims less than its data inflates to.
    const lying = Uint8Array.from(bytes);
    lying[12] = ((lying[12] ?? 0) & 0xf0) | (((lying[12] ?? 0) & 0x0f) ^ 1);
    expect(Pack.measure(lying, unlimited)).toMatchObject(malformed);
  });
});
