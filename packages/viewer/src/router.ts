import { useEffect, useState } from "react";

// The viewer's pages and their URLs. The Worker serves index.html for any
// path that is not the API's, so each of these can be opened, bookmarked and
// shared.
//
// - `/`: the workspaces
// - `/w/<workspace>/<path>?at=<sha>`: a file, at main or at a commit
// - `/history/<workspace>`: main's commits

export type Route =
  | { readonly _tag: "Workspaces" }
  | { readonly _tag: "File"; readonly ws: string; readonly path: string; readonly at: string | undefined }
  | { readonly _tag: "History"; readonly ws: string };

const decode = (segment: string): string => {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
};

export const parseRoute = (url: URL): Route => {
  const [first, ws, ...rest] = url.pathname.split("/").slice(1);
  if (first === "w" && ws !== undefined && ws !== "")
    return {
      _tag: "File",
      ws: decode(ws),
      path: rest.map((segment) => decode(segment)).join("/"),
      at: url.searchParams.get("at") ?? undefined,
    };
  if (first === "history" && ws !== undefined && ws !== "") return { _tag: "History", ws: decode(ws) };
  return { _tag: "Workspaces" };
};

export const fileHref = (ws: string, path: string, at?: string, hash?: string): string => {
  const encoded = path
    .split("/")
    .filter((segment) => segment !== "")
    .map((segment) => encodeURIComponent(segment))
    .join("/");
  const query = at === undefined ? "" : `?at=${at}`;
  return `/w/${ws}${encoded === "" ? "" : `/${encoded}`}${query}${hash === undefined || hash === "" ? "" : `#${hash}`}`;
};

/** Go to `href` in the viewer. `replace` leaves no entry to come back to, as for a redirect. */
export const navigate = (href: string, options?: { readonly replace?: boolean }): void => {
  if (options?.replace === true) globalThis.history.replaceState(null, "", href);
  else globalThis.history.pushState(null, "", href);
  globalThis.dispatchEvent(new PopStateEvent("popstate"));
  if (!href.includes("#")) globalThis.scrollTo(0, 0);
};

export const useRoute = (): { readonly route: Route; readonly url: URL } => {
  const [url, setUrl] = useState(() => new URL(globalThis.location.href));
  useEffect(() => {
    const changed = () => setUrl(new URL(globalThis.location.href));
    globalThis.addEventListener("popstate", changed);
    return () => globalThis.removeEventListener("popstate", changed);
  }, []);
  return { route: parseRoute(url), url };
};

/** Follow an in-app link without reloading, unless the reader asked for a new tab. */
export const onLinkClick = (href: string) => (event: React.MouseEvent) => {
  if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey)
    return;
  event.preventDefault();
  navigate(href);
};
