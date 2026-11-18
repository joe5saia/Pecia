// The Worker's tail: each invocation's logs, as Workers Logs gets them, sent
// to the harness's log collector (`Worker.ts`).
//
// This file runs in workerd, not in Node (see artifacts-binding.ts).

interface Env {
  /** Where the collector listens. */
  readonly COLLECTOR: string;
  readonly NETWORK: { readonly fetch: (url: string, init: RequestInit) => Promise<Response> };
}

export default {
  tail: async (events: ReadonlyArray<unknown>, env: Env): Promise<void> => {
    await env.NETWORK.fetch(env.COLLECTOR, { method: "POST", body: JSON.stringify(events) });
  },
};
