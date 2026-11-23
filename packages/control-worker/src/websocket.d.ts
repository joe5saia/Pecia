import type * as Workers from "@cloudflare/workers-types";

// workerd's global for a WebSocket auto-response, which the workspace object
// answers readers' pings with without waking (WorkspaceObject.ts). The repo
// loads Node's types, not the Workers ambient ones (see artifacts.d.ts), so
// this declares the one global it uses from the package's importable types.

declare global {
  var WebSocketRequestResponsePair: typeof Workers.WebSocketRequestResponsePair;
}
