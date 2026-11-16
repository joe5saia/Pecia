import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { LandResponse } from "./index.ts";

describe("LandResponse", () => {
  it.effect("decodes each land outcome", () =>
    Effect.gen(function* () {
      const decode = Schema.decodeUnknownEffect(LandResponse);
      expect(yield* decode({ status: "landed", sha: "abc" })).toEqual({ status: "landed", sha: "abc" });
      expect(yield* decode({ status: "nothing_to_land" })).toEqual({ status: "nothing_to_land" });
    }),
  );

  it.effect("rejects behind without mainSha", () =>
    Effect.gen(function* () {
      const result = yield* Effect.exit(Schema.decodeUnknownEffect(LandResponse)({ status: "behind" }));
      expect(result._tag).toBe("Failure");
    }),
  );
});
