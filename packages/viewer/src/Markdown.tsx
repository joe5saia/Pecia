import type { CommitSha, WorkspaceName } from "@pecia/wiki-api";
import * as Predicate from "effect/Predicate";
import { type ComponentProps, type ReactNode, useEffect, useId, useRef, useState } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import rehypeHighlight from "rehype-highlight";
import rehypeRaw from "rehype-raw";
import rehypeSanitize, { defaultSchema } from "rehype-sanitize";
import rehypeSlug from "rehype-slug";
import remarkGfm from "remark-gfm";
import { fileUrl } from "./api.ts";
import { isMarkdown, resolveLink } from "./paths.ts";
import { fileHref, onLinkClick } from "./router.ts";

// How a wiki page is rendered. Pages are written by agents, so their HTML is
// sanitized with GitHub's rules before anything else sees it; the plugins that
// follow only add ids and highlighting. Links and images are relative to the
// page and are resolved against the commit being read, so a page and the
// files it shows always come from the same commit.

export interface Page {
  readonly ws: WorkspaceName;
  /** The commit being read. */
  readonly sha: CommitSha;
  /** What the route says: `undefined` while reading main. */
  readonly at: string | undefined;
  readonly path: string;
}

/** The YAML front matter of a page, which GitHub shows as a table and other renderers hide. */
const splitFrontMatter = (text: string): { readonly frontMatter: string | undefined; readonly body: string } => {
  const match = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(text);
  return match === null
    ? { frontMatter: undefined, body: text }
    : { frontMatter: match[1], body: text.slice(match[0].length) };
};

/** A code fence that `text` cannot close early. */
export const fenced = (text: string, language: string): string => {
  const longest = Math.max(2, ...[...text.matchAll(/`+/g)].map((run) => run[0].length));
  const fence = "`".repeat(longest + 1);
  return `${fence}${language}\n${text}${text.endsWith("\n") ? "" : "\n"}${fence}\n`;
};

const schema = {
  ...defaultSchema,
  attributes: {
    ...defaultSchema.attributes,
    // Task list checkboxes, as GitHub keeps them.
    input: [
      ...(defaultSchema.attributes?.["input"] ?? []),
      ["type", "checkbox"],
      ["checked", true],
      ["disabled", true],
    ],
  },
};

/** The text of a node of the page, such as a code block's source. */
const textOf = (node: unknown): string => {
  if (Predicate.hasProperty(node, "value") && Predicate.isString(node.value)) return node.value;
  if (Predicate.hasProperty(node, "children") && Array.isArray(node.children))
    return node.children.map((child: unknown) => textOf(child)).join("");
  return "";
};

const prefersDark = () => globalThis.matchMedia("(prefers-color-scheme: dark)").matches;

/** A Mermaid diagram, drawn by Mermaid in strict mode, which sanitizes what it draws. Loaded on first use. */
const Mermaid = ({ source }: { readonly source: string }) => {
  const id = `mermaid-${useId().replace(/[^a-zA-Z0-9]/g, "")}`;
  const [drawn, setDrawn] = useState<{ svg: string } | { error: string } | undefined>();
  useEffect(() => {
    let current = true;
    void import("mermaid")
      .then(async ({ default: mermaid }) => {
        mermaid.initialize({ startOnLoad: false, securityLevel: "strict", theme: prefersDark() ? "dark" : "default" });
        const { svg } = await mermaid.render(id, source);
        if (current) setDrawn({ svg });
      })
      .catch((error: unknown) => {
        if (current) setDrawn({ error: error instanceof Error ? error.message : String(error) });
      });
    return () => {
      current = false;
    };
  }, [id, source]);
  if (drawn !== undefined && "svg" in drawn)
    return <div className="mermaid" dangerouslySetInnerHTML={{ __html: drawn.svg }} />;
  return (
    <figure className="mermaid-source">
      <pre>
        <code>{source}</code>
      </pre>
      {drawn !== undefined && <figcaption>Diagram not drawn: {drawn.error}</figcaption>}
    </figure>
  );
};

const CodeBlock = ({ children, language }: { readonly children: ReactNode; readonly language: string | undefined }) => {
  const code = useRef<HTMLPreElement>(null);
  const [copied, setCopied] = useState(false);
  const copy = () => {
    void navigator.clipboard.writeText(code.current?.innerText ?? "").then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  };
  return (
    <div className="code-block">
      <div className="code-bar">
        <span>{language ?? ""}</span>
        <button type="button" onClick={copy}>
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
      <pre ref={code}>{children}</pre>
    </div>
  );
};

/** Go to an anchor of this page. Ids from the page's own HTML are prefixed, as on GitHub. */
const scrollToAnchor = (hash: string): boolean => {
  const target = document.getElementById(hash) ?? document.getElementById(`user-content-${hash}`);
  if (target === null) return false;
  target.scrollIntoView();
  globalThis.history.replaceState(null, "", `#${hash}`);
  return true;
};

const Heading = ({
  level,
  id,
  children,
}: {
  level: 1 | 2 | 3 | 4 | 5 | 6;
  id: string | undefined;
  children: ReactNode;
}) => {
  const Tag = `h${level}` as const;
  return (
    <Tag id={id}>
      {children}
      {id !== undefined && (
        <a className="anchor" href={`#${id}`} aria-label="Link to this section">
          #
        </a>
      )}
    </Tag>
  );
};

const heading =
  (level: 1 | 2 | 3 | 4 | 5 | 6) =>
  ({ id, children }: ComponentProps<"h1">) => (
    <Heading level={level} id={id}>
      {children}
    </Heading>
  );

const components = (page: Page): Components => ({
  h1: heading(1),
  h2: heading(2),
  h3: heading(3),
  h4: heading(4),
  h5: heading(5),
  h6: heading(6),
  a: ({ href, children, node: _node, ...rest }) => {
    const target = href === undefined ? undefined : resolveLink(page.path, href);
    if (target === undefined) return <span title={`Not in this wiki: ${href ?? ""}`}>{children}</span>;
    if (target._tag === "External")
      return (
        <a {...rest} href={target.href} target="_blank" rel="noreferrer noopener">
          {children}
        </a>
      );
    if (target._tag === "Anchor")
      return (
        <a
          {...rest}
          href={`#${target.hash}`}
          onClick={(event) => {
            if (scrollToAnchor(target.hash)) event.preventDefault();
          }}
        >
          {children}
        </a>
      );
    // A page opens in the viewer; any other file opens as itself.
    const link = isMarkdown(target.path)
      ? fileHref(page.ws, target.path, page.at, target.hash)
      : fileUrl(page.ws, page.sha, target.path);
    return (
      <a {...rest} href={link} onClick={isMarkdown(target.path) ? onLinkClick(link) : undefined}>
        {children}
      </a>
    );
  },
  img: ({ src, alt, node: _node, ...rest }) => {
    const target = typeof src === "string" ? resolveLink(page.path, src) : undefined;
    if (target?._tag === "File")
      return <img {...rest} alt={alt} src={fileUrl(page.ws, page.sha, target.path)} loading="lazy" />;
    if (target?._tag === "External" && target.href.startsWith("https://"))
      return <img {...rest} alt={alt} src={target.href} loading="lazy" referrerPolicy="no-referrer" />;
    return <span className="missing-image">{alt ?? "image"}</span>;
  },
  pre: ({ node, children }) => {
    const code = node?.children[0];
    const classes = code?.type === "element" ? code.properties["className"] : undefined;
    const language = Array.isArray(classes)
      ? classes
          .filter((name) => Predicate.isString(name))
          .find((name) => name.startsWith("language-"))
          ?.slice("language-".length)
      : undefined;
    if (language === "mermaid") return <Mermaid source={textOf(code).trimEnd()} />;
    return <CodeBlock language={language}>{children}</CodeBlock>;
  },
  table: ({ node: _node, ...rest }) => (
    <div className="table-wrap">
      <table {...rest} />
    </div>
  ),
});

/** A heading of the page, for its table of contents. */
export interface OutlineEntry {
  readonly id: string;
  readonly text: string;
  readonly level: number;
}

export const Markdown = ({
  page,
  text,
  onHeadings,
}: {
  readonly page: Page;
  readonly text: string;
  readonly onHeadings?: (headings: ReadonlyArray<OutlineEntry>) => void;
}) => {
  const article = useRef<HTMLElement>(null);
  const { frontMatter, body } = splitFrontMatter(text);

  useEffect(() => {
    const headings = [...(article.current?.querySelectorAll("h1[id], h2[id], h3[id]") ?? [])]
      // The footnotes' heading is for screen readers, as on GitHub.
      .filter((element) => element.closest(".footnotes") === null)
      .map((element) => ({
        id: element.id,
        text: element.textContent?.replace(/#$/, "").trim() ?? "",
        level: Number(element.tagName.slice(1)),
      }));
    onHeadings?.(headings);
    // Go to the URL's anchor once the page has its fonts and layout.
    const hash = decodeURIComponent(globalThis.location.hash.slice(1));
    if (hash !== "") void document.fonts.ready.then(() => requestAnimationFrame(() => scrollToAnchor(hash)));
  }, [text, onHeadings]);

  return (
    <article className="markdown" ref={article}>
      {frontMatter !== undefined && (
        <details className="front-matter">
          <summary>Front matter</summary>
          <pre>
            <code>{frontMatter}</code>
          </pre>
        </details>
      )}
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[
          rehypeRaw,
          [rehypeSanitize, schema],
          rehypeSlug,
          [rehypeHighlight, { detect: false, plainText: ["mermaid", "text", "txt"] }],
        ]}
        components={components(page)}
      >
        {body}
      </ReactMarkdown>
    </article>
  );
};
