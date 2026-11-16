import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as OpenApi from "effect/http-api/OpenApi";
import * as Schema from "effect/Schema";
import { LandResponse, SessionId, WikiApi, workspaceOfSession } from "./index.ts";

describe("WikiApi", () => {
  it("declares every status each endpoint answers", () => {
    const declared = Object.entries(OpenApi.fromApi(WikiApi).paths).flatMap(([path, operations]) =>
      Object.entries(operations).flatMap(([method, operation]) =>
        "responses" in operation
          ? [[`${method.toUpperCase()} ${path}`, Object.keys(operation.responses).join(" ")]]
          : [],
      ),
    );
    // 400 and 500 come from ProblemDetails, 401 from each group's auth and 503 from reaching the workspace.
    expect(Object.fromEntries(declared)).toEqual({
      "POST /workspaces": "200 400 401 500 502 503",
      "POST /workspaces/{ws}/sessions": "200 400 401 404 500 502 503",
      "GET /workspaces/{ws}/sessions": "200 400 401 404 500 503",
      "DELETE /sessions/{id}": "200 400 401 404 409 500 502 503",
      "POST /sessions/{id}/token": "200 400 401 404 409 500 502 503",
      "POST /sessions/{id}/land": "200 400 401 404 409 422 500 502 503",
    });
  });
});

describe("SessionId", () => {
  it.effect("starts with a valid workspace name, which is the workspace it belongs to", () =>
    Effect.gen(function* () {
      const decode = Schema.decodeUnknownEffect(SessionId);
      expect(workspaceOfSession(yield* decode("eng-wiki.ab12"))).toBe("eng-wiki");
      const longest = "a".repeat(40);
      expect(workspaceOfSession(yield* decode(`${longest}.ab12`))).toBe(longest);

      const tooLong = yield* Effect.exit(decode(`${longest}a.ab12`));
      expect(tooLong._tag).toBe("Failure");
      const doubleHyphen = yield* Effect.exit(decode("eng--wiki.ab12"));
      expect(doubleHyphen._tag).toBe("Failure");
    }),
  );
});

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
