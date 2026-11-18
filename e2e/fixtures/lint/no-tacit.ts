import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
// Good: functions written out, and values that are not functions.
Effect.map(effect, (value) => render(value));
effect.pipe(Effect.map((value) => render(value)), Effect.orDie);
Effect.andThen(effect, other);
Effect.provideService(effect, Clock, clock);
Effect.catchTag(effect, "NotFound", (error) => recover(error));
effect.pipe(Effect.catchTag("NotFound", (error) => recover(error)), Effect.orDie);
pipe(Effect.map(effect, (value) => render(value)), Effect.orDie);
Effect.retry(effect, { times: attempts, schedule });
// Good: not Effect.
items.map(render);

// Bad: a function passed by name.
Effect.map(effect, render); // expect: pecia/no-tacit @20
effect.pipe(Effect.map(render), Effect.orDie); // expect: pecia/no-tacit
pipe(effect, Effect.flatMap(Git.push)); // expect: pecia/no-tacit
Option.map(option, render); // expect: pecia/no-tacit
Effect.sync(now); // expect: pecia/no-tacit
Effect.catchTag(effect, "NotFound", recover); // expect: pecia/no-tacit @37
effect.pipe(Effect.catchTag("NotFound", recover), Effect.orDie); // expect: pecia/no-tacit
Effect.catchIf(effect, isRetryable, recover); // expect: pecia/no-tacit, pecia/no-tacit
Effect.tryPromise({ try: () => load(), catch: toError }); // expect: pecia/no-tacit
Effect.retry(effect, { while: isRetryable }); // expect: pecia/no-tacit
