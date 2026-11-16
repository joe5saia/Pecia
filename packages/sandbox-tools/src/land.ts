import type { LandResponse } from "@pecia/wiki-api";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as Match from "effect/Match";
import { loadSession, runTool, sandboxClient } from "./Session.ts";

// wiki-land: ask the Control Worker to publish this session's fork (docs/mvp.md,
// "Sandbox setup"). Prints `landed <sha>`, `behind` or `nothing to land`, and
// exits 0 for landed or nothing to land, 2 for behind, 1 on error.

/** What to print and the exit code for each answer. */
const report = Match.type<LandResponse>().pipe(
  Match.withReturnType<readonly [line: string, exitCode: number]>(),
  Match.discriminatorsExhaustive("status")({
    landed: ({ sha }) => [`landed ${sha}`, 0],
    nothing_to_land: () => ["nothing to land", 0],
    behind: () => ["behind", 2],
  }),
);

runTool(
  "wiki-land",
  Effect.gen(function* () {
    const session = yield* loadSession;
    const client = yield* sandboxClient(session);
    const [line, exitCode] = report(yield* client.land({ params: { id: session.sessionId } }));
    yield* Console.log(line);
    return exitCode;
  }),
);
