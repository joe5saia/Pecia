// The Worker's Artifacts binding in workerd, which has no Artifacts of its
// own: a wrapped binding that makes the same calls as Cloudflare's and sends
// each to the fake on loopback (`Artifacts.ts`). It runs in the Worker's
// isolate, so a failure keeps its `code`, as the real binding's does.
//
// This file runs in workerd, not in Node: the harness strips its types and
// loads it as an internal module of the workerd config.

interface Env {
  /** The fake's origin. */
  readonly control: string;
}

interface Failure {
  readonly message: string;
  readonly code: string;
}

const isFailure = (value: unknown): value is { readonly error: Failure } =>
  typeof value === "object" && value !== null && "error" in value;

const isAnswer = (value: unknown): value is { readonly ok: unknown } =>
  typeof value === "object" && value !== null && "ok" in value;

export default (env: Env) => {
  const call = async (operation: string, repo: string, ...args: ReadonlyArray<unknown>): Promise<unknown> => {
    const response = await fetch(`${env.control}/binding`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ operation, repo, args }),
    });
    const answer: unknown = await response.json();
    if (isFailure(answer)) {
      throw Object.assign(new Error(answer.error.message), { code: answer.error.code });
    }
    if (!isAnswer(answer)) {
      throw new Error(`the fake Artifacts answered ${response.status}`);
    }
    return answer.ok;
  };

  /** A repo handle. The real one is an RPC stub, which the Worker disposes. */
  const repo = (name: string) => ({
    info: () => call("info", name),
    listTokens: () => call("listTokens", name),
    log: (options: unknown) => call("log", name, options),
    readTree: (hash: string) => call("readTree", name, hash),
    readFile: async (options: unknown) => {
      const bytes = await call("readFile", name, options);
      return typeof bytes === "string" ? new Blob([Uint8Array.from(atob(bytes), (char) => char.charCodeAt(0))]) : null;
    },
    createToken: (scope: string, ttl: number) => call("createToken", name, scope, ttl),
    revokeToken: (id: string) => call("revokeToken", name, id),
    fork: (fork: string, options: unknown) => call("fork", name, fork, options),
    [Symbol.dispose]: () => {},
  });

  return {
    create: (name: string, options: unknown) => call("create", name, options),
    get: async (name: string) => ((await call("get", name)) === null ? null : repo(name)),
    list: (options: unknown) => call("list", "", options),
    delete: (name: string) => call("delete", name),
  };
};
