import type { getCompatibility } from "@alchemy.run/cloudflare/Workers/Compatibility";

// How the Control Worker runs, beside its code: its compatibility date and
// flags. worker.ts deploys with these and build.ts bundles with them, so the
// scenarios in e2e/ run with the settings production has. Set them here, never
// in worker.ts alone. Empty, the stack uses Alchemy's defaults.
export const runtime: Pick<Parameters<typeof getCompatibility>[0], "compatibility"> = {};
