// Every fetch the Worker makes leaves through here, the way it leaves a
// Cloudflare isolate for the internet. The Access team's signing keys come
// from the fake Access (`Access.ts`); everything else, such as the fake
// Artifacts' git remotes on loopback, goes out to the network.
//
// This file runs in workerd, not in Node (see artifacts-binding.ts).

interface Env {
  /** The host of the Access team the Worker trusts, such as `saiaai.cloudflareaccess.com`. */
  readonly ACCESS_HOST: string;
  /** The team's JWKS, as `/cdn-cgi/access/certs` serves it. */
  readonly JWKS: string;
  readonly NETWORK: { readonly fetch: (request: Request) => Promise<Response> };
}

export default {
  fetch: (request: Request, env: Env): Promise<Response> | Response => {
    const url = new URL(request.url);
    if (url.hostname === env.ACCESS_HOST && url.pathname === "/cdn-cgi/access/certs")
      return new Response(env.JWKS, { headers: { "content-type": "application/json" } });
    return env.NETWORK.fetch(request);
  },
};
