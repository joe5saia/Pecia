// Every fetch the Worker makes leaves through here, the way it leaves a
// Cloudflare isolate for the internet. The Access team's signing keys come
// from the fake Access (`Access.ts`) and Amp's from the fake Amp (`Amp.ts`); everything else, such as the fake
// Artifacts' git remotes on loopback, goes out to the network.
//
// This file runs in workerd, not in Node (see artifacts-binding.ts).

interface Env {
  /** The host of the Access team the Worker trusts, such as `pecia-e2e.cloudflareaccess.com`. */
  readonly ACCESS_HOST: string;
  /** The team's JWKS, as `/cdn-cgi/access/certs` serves it. */
  readonly JWKS: string;
  /** Amp's workload identity JWKS (`Amp.ts`), and whether it is down for the scenario. */
  readonly AMP_JWKS: string;
  readonly NETWORK: { readonly fetch: (request: Request) => Promise<Response> };
}

export default {
  fetch: (request: Request, env: Env): Promise<Response> | Response => {
    const url = new URL(request.url);
    if (url.hostname === env.ACCESS_HOST && url.pathname === "/cdn-cgi/access/certs") {
      return new Response(env.JWKS, { headers: { "content-type": "application/json" } });
    }
    // The scenarios' MCP client's metadata document (CIMD), as a client publishes it (`Mcp.ts`).
    if (url.hostname === "client.pecia-e2e.dev" && url.pathname === "/client.json") {
      return new Response(
        JSON.stringify({
          client_id: url.href,
          client_name: "pecia e2e client",
          redirect_uris: ["http://127.0.0.1/callback"],
          grant_types: ["authorization_code", "refresh_token"],
          response_types: ["code"],
          token_endpoint_auth_method: "none",
        }),
        { headers: { "content-type": "application/json", "cache-control": "max-age=60" } },
      );
    }
    if (url.hostname === "ampcode.com" && url.pathname === "/api/workload-identity/jwks.json") {
      return new Response(env.AMP_JWKS, { headers: { "content-type": "application/json" } });
    }
    return env.NETWORK.fetch(request);
  },
};
