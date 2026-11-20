// The Worker's KV namespace for the OAuth provider (`OAuthKV`) in workerd: a
// wrapped binding that keeps keys in the isolate's memory, with the calls and
// expiry of Cloudflare KV that the provider uses. Unlike KV it is consistent
// at once, which the scenarios do not rely on either way.
//
// This file runs in workerd, not in Node (see artifacts-binding.ts).

interface Entry {
  readonly value: string;
  readonly expiration: number | undefined;
  readonly metadata: unknown;
}

type ReadType = "text" | "json" | { readonly type?: "text" | "json" } | undefined;

const typeOf = (type: ReadType) => (typeof type === "string" ? type : (type?.type ?? "text"));

export default () => {
  const entries = new Map<string, Entry>();
  const live = (key: string): Entry | undefined => {
    const entry = entries.get(key);
    if (entry === undefined) {
      return undefined;
    }
    if (entry.expiration !== undefined && entry.expiration * 1000 <= Date.now()) {
      entries.delete(key);
      return undefined;
    }
    return entry;
  };
  const read = (entry: Entry | undefined, type: ReadType): unknown => {
    if (entry === undefined) {
      return null;
    }
    return typeOf(type) === "json" ? JSON.parse(entry.value) : entry.value;
  };
  return {
    get: async (key: string, type?: ReadType) => read(live(key), type),
    getWithMetadata: async (key: string, type?: ReadType) => {
      const entry = live(key);
      return { value: read(entry, type), metadata: entry?.metadata ?? null };
    },
    put: async (
      key: string,
      value: string,
      options?: { readonly expirationTtl?: number; readonly expiration?: number; readonly metadata?: unknown },
    ) => {
      const expiration =
        options?.expiration ??
        (options?.expirationTtl === undefined ? undefined : Math.floor(Date.now() / 1000) + options.expirationTtl);
      entries.set(key, { value, expiration, metadata: options?.metadata ?? null });
    },
    delete: async (key: string) => {
      entries.delete(key);
    },
    list: async (options?: { readonly prefix?: string; readonly limit?: number; readonly cursor?: string }) => {
      const prefix = options?.prefix ?? "";
      const names = [...entries.keys()]
        .filter((name) => name.startsWith(prefix) && live(name) !== undefined)
        .toSorted();
      const start = options?.cursor === undefined || options.cursor === "" ? 0 : Number(options.cursor);
      const limit = options?.limit ?? 1000;
      const page = names.slice(start, start + limit);
      const complete = start + page.length >= names.length;
      return {
        keys: page.map((name) => {
          const entry = entries.get(name);
          return { name, expiration: entry?.expiration, metadata: entry?.metadata ?? undefined };
        }),
        list_complete: complete,
        cursor: complete ? "" : String(start + page.length),
      };
    },
  };
};
