import type { getCompatibility } from "@alchemy.run/cloudflare/Workers/Compatibility";

// How the Control Worker runs, beside its code: its compatibility date and
// flags. worker.ts deploys with these and build.ts bundles with them, so the
// scenarios in e2e/ run with the settings production has. Set them here, never
// in worker.ts alone. Alchemy adds its own defaults to these flags.
export const runtime: Pick<Parameters<typeof getCompatibility>[0], "compatibility"> = {
  compatibility: {
    // The OAuth provider fetches a client's metadata document (CIMD) only with
    // this flag, which keeps the fetch from reaching the zone's own origins.
    flags: ["global_fetch_strictly_public"],
  },
};
