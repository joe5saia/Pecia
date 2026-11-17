import { matchUnions } from "./rules/match-unions.ts";
import { noTacit } from "./rules/no-tacit.ts";
import { preferDataFirst } from "./rules/prefer-data-first.ts";
import { preferFn } from "./rules/prefer-fn.ts";
import { preferForEach } from "./rules/prefer-for-each.ts";
import { runAtTheEdge } from "./rules/run-at-the-edge.ts";

// The oxlint plugin for the parts of the Effect code style (AGENTS.md, "Effect
// style") that oxlint has no rule for. .oxlintrc.json loads it as `pecia`.

export default {
  meta: { name: "pecia" },
  rules: {
    "match-unions": matchUnions,
    "no-tacit": noTacit,
    "prefer-data-first": preferDataFirst,
    "prefer-fn": preferFn,
    "prefer-for-each": preferForEach,
    "run-at-the-edge": runAtTheEdge,
  },
};
