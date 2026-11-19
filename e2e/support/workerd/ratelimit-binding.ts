// The Worker's rate limiter (`OAuthRateLimit`) in workerd: it lets every
// request through. What a limit does under load is Cloudflare's, not pecia's.
//
// This file runs in workerd, not in Node (see artifacts-binding.ts).

export default () => ({ limit: async (_options: { readonly key: string }) => ({ success: true }) });
