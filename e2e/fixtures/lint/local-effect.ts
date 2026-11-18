// A local module that happens to be called Effect is not Effect: no rule reports it.
import * as Effect from "./Effect.ts";
Effect.map(effect, render);
effect.pipe(Effect.orDie);
const land = (id) => Effect.gen(function* () { yield* publish(id); });
Effect.runPromise(program);
