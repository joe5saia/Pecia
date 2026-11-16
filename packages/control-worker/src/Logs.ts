import * as Effect from "effect/Effect";
import * as Logger from "effect/Logger";

// Workers Logs indexes the fields of an object passed to `console.log`, so the
// structured logger makes each log one entry that can be filtered by
// `annotations.event`, `annotations.workspace` and so on. The runtime's default
// pretty logger writes every annotation as a separate entry.
const loggers = new Set([Logger.consoleStructured]);

/** Run `effect` with its logs written as one structured entry each. */
export const structured = <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
  Effect.provideService(effect, Logger.CurrentLoggers, loggers);
