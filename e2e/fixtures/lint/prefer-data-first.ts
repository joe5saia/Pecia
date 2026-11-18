import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
// Good
Effect.orDie(effect);
effect.pipe(Effect.map((value) => value + 1), Effect.orDie);
// Good: not dual. Schema's combinators only come in the piped form.
Schema.String.pipe(Schema.brand("WorkspaceName"));
value.pipe(transform);

// Bad: one step in a pipe.
effect.pipe(Effect.orDie); // expect: pecia/prefer-data-first
effect.pipe(Effect.map((value) => value + 1)); // expect: pecia/prefer-data-first
layer.pipe(Layer.provide(other)); // expect: pecia/prefer-data-first
