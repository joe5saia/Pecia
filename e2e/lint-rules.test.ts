import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { execFile } from "node:child_process";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { isRecord, itemsOf, root } from "./support/Server.ts";

// The project's lint rules (packages/lint-rules), run as `task lint` runs
// them: oxlint on the fixture files in fixtures/lint. A line that a rule must
// report ends with `// expect: pecia/<rule>`, once per report, optionally with
// `@<column>` (oxlint's, from 1). Every other line is code the rules must
// leave alone, including each case where a rule once reported good code.

const fixtures = join(root, "e2e/fixtures/lint");

interface Report {
  readonly file: string;
  readonly line: number;
  readonly rule: string;
}

/** What oxlint reports for the fixtures, as `file:line rule`, and the columns where the fixtures name one. */
const lint = Effect.promise(
  () =>
    new Promise<ReadonlyArray<Report & { readonly column: number }>>((resolve, reject) => {
      execFile(
        join(root, "node_modules/.bin/oxlint"),
        ["-c", join(fixtures, "oxlint.json"), "--format", "json", fixtures],
        { cwd: root, maxBuffer: 16 * 1024 * 1024 },
        (_error, stdout, stderr) => {
          // oxlint exits 1 when it reports anything, which the fixtures make it do.
          let output: unknown;
          try {
            output = JSON.parse(stdout);
          } catch {
            return reject(new Error(`oxlint did not answer JSON: ${stderr}`));
          }
          const diagnostics = itemsOf(isRecord(output) ? output["diagnostics"] : undefined);
          resolve(
            diagnostics.flatMap((diagnostic) => {
              if (!isRecord(diagnostic)) {
                return [];
              }
              const [label] = itemsOf(diagnostic["labels"]);
              const { filename, code } = diagnostic;
              const span = isRecord(label) && isRecord(label["span"]) ? label["span"] : {};
              return [
                {
                  file: typeof filename === "string" ? (filename.split("/").at(-1) ?? "") : "",
                  line: Number(span["line"]),
                  column: Number(span["column"]),
                  // oxlint writes `pecia(no-tacit)` for the rule `pecia/no-tacit`.
                  rule: (typeof code === "string" ? code : "").replace(/^(\w+)\((.+)\)$/, "$1/$2"),
                },
              ];
            }),
          );
        },
      );
    }),
);

/** The reports the fixtures expect, from their `// expect:` comments. */
const expected = Effect.promise(async () => {
  const files = (await readdir(fixtures)).filter((file) => file.endsWith(".ts"));
  const all = await Promise.all(
    files.map(async (file) =>
      (await readFile(join(fixtures, file), "utf8")).split("\n").flatMap((text, index) => {
        const comment = /\/\/ expect: (.+)$/.exec(text)?.[1];
        if (comment === undefined) {
          return [];
        }
        return comment.split(",").map((entry) => {
          const [rule = "", at] = entry.trim().split(" @");
          return { file, line: index + 1, rule, column: at === undefined ? undefined : Number(at) };
        });
      }),
    ),
  );
  return all.flat();
});

const key = (report: Report) => `${report.file}:${report.line} ${report.rule}`;

it.live("each project lint rule reports exactly the fixture lines that break its rule, where they break it", () =>
  Effect.gen(function* () {
    const reported = yield* lint;
    const wanted = yield* expected;
    // Every rule of the plugin has fixtures that it reports.
    expect(new Set(wanted.map((report) => report.rule))).toEqual(
      new Set([
        "pecia/no-tacit",
        "pecia/prefer-data-first",
        "pecia/prefer-fn",
        "pecia/prefer-for-each",
        "pecia/match-unions",
        "pecia/run-at-the-edge",
      ]),
    );
    expect(reported.map((report) => key(report)).toSorted()).toEqual(wanted.map((report) => key(report)).toSorted());
    for (const report of wanted) {
      if (report.column === undefined) {
        continue;
      }
      expect(
        reported.some((found) => key(found) === key(report) && found.column === report.column),
        `${key(report)} @${report.column}`,
      ).toBe(true);
    }
  }),
);
