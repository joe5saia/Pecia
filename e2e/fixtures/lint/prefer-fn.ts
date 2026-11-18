import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
// Good
const land1 = Effect.fn("land")(function* (id) { return yield* publish(id); });
const land2 = Effect.fnUntraced(function* (id) { return yield* publish(id); });
// Good: an effect, not a function.
const program = Effect.gen(function* () { yield* start; });
// Good: more than a generator. The function does something of its own first, or wraps the generator.
const land3 = (id) => lock.withPermit(Effect.gen(function* () { yield* publish(id); }));
const land4 = (id) => { const note = noteOf(id); return Effect.gen(function* () { yield* publish(note); }); };
// Good: an inline callback takes its parameter types from where it is passed.
handlers.handle("land", ({ params }) => Effect.gen(function* () { yield* publish(params.id); }));
const tools = { land: (id) => Effect.gen(function* () { yield* publish(id); }) };

// Bad: a function whose body is a generator.
const land5 = (id) => Effect.gen(function* () { yield* publish(id); }); // expect: pecia/prefer-fn @15
const land6 = (id) => Effect.gen(function* () { yield* publish(id); }).pipe(Effect.scoped, Effect.orDie); // expect: pecia/prefer-fn
const land7 = (id) => { return Effect.gen(function* () { yield* publish(id); }); }; // expect: pecia/prefer-fn
const sweep = function () { return Effect.gen(function* () { yield* settle; }); }; // expect: pecia/prefer-fn
