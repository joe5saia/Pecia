import * as Schema from "effect/Schema";

// Shared request and response contract for the Control Worker API (docs/mvp.md).

export const LandResponse = Schema.Union([
  Schema.Struct({ status: Schema.Literal("landed"), sha: Schema.String }),
  Schema.Struct({ status: Schema.Literal("behind"), mainSha: Schema.String }),
  Schema.Struct({ status: Schema.Literal("nothing_to_land") }),
]);
export type LandResponse = typeof LandResponse.Type;
