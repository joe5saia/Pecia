import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
// Good: an entry point, and a runtime of its own.
NodeRuntime.runMain(program);
runtime.runPromise(program);

// Bad: running an effect in the middle of the program.
Effect.runPromise(program); // expect: pecia/run-at-the-edge
Effect.runSync(program); // expect: pecia/run-at-the-edge
Effect.runFork(program); // expect: pecia/run-at-the-edge
const run = Effect.runPromiseExit; // expect: pecia/run-at-the-edge
