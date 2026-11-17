import { describe, expect, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as OpenApi from "effect/http-api/OpenApi";
import * as Schema from "effect/Schema";
import { LandResponse, SessionId, Timestamp, timestampOf, WikiApi, workspaceOfSession } from "./index.ts";

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
    // Reads and login never reach a workspace, so they have no 503.
    expect(Object.fromEntries(declared)).toEqual({
      "POST /workspaces": "200 400 401 500 502 503",
      "POST /workspaces/{ws}/sessions": "200 400 401 404 500 502 503",
      "GET /workspaces/{ws}/sessions": "200 400 401 404 500 503",
      "DELETE /sessions/{id}": "200 400 401 404 409 500 502 503",
      "POST /sessions/{id}/token": "200 400 401 404 409 500 502 503",
      "POST /sessions/{id}/land": "200 400 401 404 409 422 500 502 503",
      "GET /workspaces": "200 400 401 500 502",
      "GET /workspaces/{ws}/tree": "200 400 401 404 500 502",
      "GET /workspaces/{ws}/file": "200 400 401 404 500 502",
      "GET /workspaces/{ws}/history": "200 400 401 404 500 502",
      "POST /auth/login": "200 400 401 500",
      "POST /auth/logout": "204 400 500",
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

describe("Timestamp", () => {
  it.effect("is UTC with milliseconds, whatever the time it is made from", () =>
    Effect.gen(function* () {
      const decode = Schema.decodeUnknownEffect(Timestamp);
      expect(yield* decode("2026-11-17T19:46:42.518Z")).toBe("2026-11-17T19:46:42.518Z");
      // The forms Artifacts and a clock give: no milliseconds, another zone, Unix milliseconds.
      expect(timestampOf(DateTime.makeUnsafe("2026-11-17T19:46:42Z"))).toBe("2026-11-17T19:46:42.000Z");
      expect(timestampOf(DateTime.makeUnsafe("2026-11-17T19:46:42.518+02:00"))).toBe("2026-11-17T17:46:42.518Z");
      expect(timestampOf(DateTime.makeUnsafe(1_794_944_802_518))).toBe("2026-11-17T19:46:42.518Z");

      const rejected = yield* Effect.forEach(
        ["2026-11-17T19:46:42Z", "2026-11-17T19:46:42.518+00:00", "2026-11-17 19:46:42.518Z", "1794944802518", ""],
        (text) => Effect.exit(decode(text)),
      );
      expect(rejected.map((exit) => exit._tag)).toEqual(["Failure", "Failure", "Failure", "Failure", "Failure"]);
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
