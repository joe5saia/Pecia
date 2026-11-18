import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
// Good
Effect.gen(function* () { yield* Effect.forEach(tokens, (token) => revoke(token), { discard: true }); });
// Good: a loop that carries state, and a loop that runs no effect.
Effect.gen(function* () { while (cursor !== undefined) { cursor = yield* page(cursor); } });
Effect.gen(function* () { for (const token of tokens) seen.add(token); yield* done; });
// Good: the effect belongs to a generator of its own, made once per element.
Effect.gen(function* () { for (const token of tokens) later.push(Effect.gen(function* () { yield* revoke(token); })); });
// Good: a plain generator, not an effect.
function* all(lists) { for (const list of lists) yield* list; }

// Bad: yield* in a loop.
Effect.gen(function* () { for (const token of tokens) { yield* revoke(token); } }); // expect: pecia/prefer-for-each
Effect.gen(function* () { for (const name in files) { if (name) { yield* write(name); } } }); // expect: pecia/prefer-for-each
Effect.fn("revokeAll")(function* (tokens) { for (const token of tokens) yield* revoke(token); }); // expect: pecia/prefer-for-each
