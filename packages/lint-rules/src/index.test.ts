import { describe, it } from "@effect/vitest";
import { RuleTester } from "oxlint/plugins-dev";
import plugin from "./index.ts";

RuleTester.describe = describe;
RuleTester.it = it;

const tester = new RuleTester({ languageOptions: { parserOptions: { lang: "ts" } } });

/** A file that imports the Effect modules the way this repository does. */
const file = (code: string): string =>
  [
    'import * as Effect from "effect/Effect";',
    'import * as Layer from "effect/Layer";',
    'import * as Option from "effect/Option";',
    'import * as Schema from "effect/Schema";',
    code,
  ].join("\n");

tester.run("no-tacit", plugin.rules["no-tacit"], {
  valid: [
    file("Effect.map(effect, (value) => render(value));"),
    file("effect.pipe(Effect.map((value) => render(value)), Effect.orDie);"),
    // Values, not functions: the effect itself, another effect, a tag, a service.
    file("Effect.andThen(effect, other);"),
    file("Effect.provideService(effect, Clock, clock);"),
    file('Effect.catchTag(effect, "NotFound", (error) => recover(error));'),
    file('effect.pipe(Effect.catchTag("NotFound", (error) => recover(error)), Effect.orDie);'),
    file("pipe(Effect.map(effect, (value) => render(value)), Effect.orDie);"),
    file("Effect.retry(effect, { times: attempts, schedule });"),
    // Not Effect: an array method, and a local module that happens to be called Effect.
    "items.map(render);",
    'import * as Effect from "./Effect.ts";\nEffect.map(effect, render);',
  ],
  invalid: [
    { code: file("Effect.map(effect, render);"), errors: [{ messageId: "tacit", line: 5, column: 19 }] },
    { code: file("effect.pipe(Effect.map(render), Effect.orDie);"), errors: [{ messageId: "tacit" }] },
    { code: file("pipe(effect, Effect.flatMap(Git.push));"), errors: [{ messageId: "tacit" }] },
    { code: file("Option.map(option, render);"), errors: [{ messageId: "tacit" }] },
    { code: file("Effect.sync(now);"), errors: [{ messageId: "tacit" }] },
    {
      code: file('Effect.catchTag(effect, "NotFound", recover);'),
      errors: [{ messageId: "tacit", line: 5, column: 36 }],
    },
    {
      code: file('effect.pipe(Effect.catchTag("NotFound", recover), Effect.orDie);'),
      errors: [{ messageId: "tacit" }],
    },
    { code: file("Effect.catchIf(effect, isRetryable, recover);"), errors: 2 },
    { code: file("Effect.tryPromise({ try: () => load(), catch: toError });"), errors: [{ messageId: "tacit" }] },
    { code: file("Effect.retry(effect, { while: isRetryable });"), errors: [{ messageId: "tacit" }] },
    { code: 'import { Effect } from "effect";\nEffect.map(effect, render);', errors: [{ messageId: "tacit" }] },
  ],
});

tester.run("prefer-data-first", plugin.rules["prefer-data-first"], {
  valid: [
    file("Effect.orDie(effect);"),
    file("effect.pipe(Effect.map((value) => value + 1), Effect.orDie);"),
    // Not dual: Schema's combinators only come in the piped form.
    file('Schema.String.pipe(Schema.brand("WorkspaceName"));'),
    file("value.pipe(transform);"),
    'import * as Effect from "./Effect.ts";\neffect.pipe(Effect.orDie);',
  ],
  invalid: [
    {
      code: file("effect.pipe(Effect.orDie);"),
      errors: [{ messageId: "dataFirst", data: { module: "Effect", name: "orDie" } }],
    },
    { code: file("effect.pipe(Effect.map((value) => value + 1));"), errors: [{ messageId: "dataFirst" }] },
    { code: file("layer.pipe(Layer.provide(other));"), errors: [{ messageId: "dataFirst" }] },
  ],
});

tester.run("match-unions", plugin.rules["match-unions"], {
  valid: [
    // A guard and an early return are not a branch on every case.
    'if (session.status === "landed") done();',
    'if (session.status === "landed") done(); else retry();',
    // Two different questions.
    'if (session.status === "landed") done(); else if (session.owner === "amp") retry();',
    "if (count > 1) many(); else if (count > 0) one();",
  ],
  invalid: [
    { code: "switch (session.status) { case 'landed': done(); }", errors: [{ messageId: "match" }] },
    {
      code: 'if (session.status === "landed") done(); else if (session.status === "parked") park();',
      errors: [{ messageId: "match" }],
    },
    {
      code: 'if ("landed" === session.status) done(); else if (session.status === "parked") park(); else wait();',
      errors: [{ messageId: "match" }],
    },
  ],
});

tester.run("prefer-for-each", plugin.rules["prefer-for-each"], {
  valid: [
    file("Effect.gen(function* () { yield* Effect.forEach(tokens, (token) => revoke(token), { discard: true }); });"),
    // A loop that carries state, and a loop that runs no effect.
    file("Effect.gen(function* () { while (cursor !== undefined) { cursor = yield* page(cursor); } });"),
    file("Effect.gen(function* () { for (const token of tokens) seen.add(token); yield* done; });"),
    // The effect belongs to a generator of its own, made once per element.
    file(
      "Effect.gen(function* () { for (const token of tokens) later.push(Effect.gen(function* () { yield* revoke(token); })); });",
    ),
    // A plain generator, not an effect.
    "function* all(lists) { for (const list of lists) yield* list; }",
  ],
  invalid: [
    {
      code: file("Effect.gen(function* () { for (const token of tokens) { yield* revoke(token); } });"),
      errors: [{ messageId: "forEach" }],
    },
    {
      code: file("Effect.gen(function* () { for (const name in files) { if (name) { yield* write(name); } } });"),
      errors: [{ messageId: "forEach" }],
    },
    {
      code: file('Effect.fn("revokeAll")(function* (tokens) { for (const token of tokens) yield* revoke(token); });'),
      errors: [{ messageId: "forEach" }],
    },
  ],
});

tester.run("run-at-the-edge", plugin.rules["run-at-the-edge"], {
  valid: [
    file("NodeRuntime.runMain(program);"),
    file("runtime.runPromise(program);"),
    'import * as Effect from "./Effect.ts";\nEffect.runPromise(program);',
  ],
  invalid: [
    { code: file("Effect.runPromise(program);"), errors: [{ messageId: "run", data: { name: "runPromise" } }] },
    { code: file("Effect.runSync(program);"), errors: [{ messageId: "run" }] },
    { code: file("Effect.runFork(program);"), errors: [{ messageId: "run" }] },
    { code: file("const run = Effect.runPromiseExit;"), errors: [{ messageId: "run" }] },
  ],
});
