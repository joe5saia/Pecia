import type { LandResponse } from "@pecia/wiki-api";
import * as Effect from "effect/Effect";
import * as Match from "effect/Match";
import * as Stdio from "effect/Stdio";
import * as Stream from "effect/Stream";
import { loadSession, printLine, runTool, sandboxClient } from "./Session.ts";

// wiki-land: ask the Control Worker to publish this session's fork (docs/mvp.md,
// "Sandbox setup"). Prints `landed <sha>`, `behind` or `nothing to land`, and
// exits 0 for landed or nothing to land, 2 for behind, 1 on error. After a
// land it says on stderr how many comment threads are open (docs/comments.md),
// so the agent can answer them while the change is fresh.

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
    const response = yield* client.land({ params: { id: session.sessionId } });
    const [line, exitCode] = report(response);
    yield* printLine(line);
    if (response.status === "landed") {
      // Only a hint: the land is done, so a failed listing must not change the exit code.
      const open = yield* Effect.orElseSucceed(
        Effect.map(
          client.listSessionThreads({ params: { id: session.sessionId }, query: {} }),
          (threads) => threads.length,
        ),
        () => 0,
      );
      if (open > 0) {
        const stdio = yield* Stdio.Stdio;
        yield* Effect.orElseSucceed(
          Stream.run(
            Stream.succeed(
              `${open} open comment thread${open === 1 ? "" : "s"} on this wiki: run wiki-comments list\n`,
            ),
            stdio.stderr(),
          ),
          () => undefined,
        );
      }
    }
    return exitCode;
  }),
);
