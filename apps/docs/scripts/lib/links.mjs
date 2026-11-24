// Links in Markdown taken from the repository (guides, overviews, the glossary): a link to a file
// that is a page on the site becomes the page's address; a link to any other file in the
// repository goes to it on GitHub; a link to nothing is a problem the run reports.
import { existsSync, statSync } from "node:fs";
import { dirname, join, normalize } from "node:path";
import { slug } from "./text.mjs";

const LINK = /(!?)\[((?:[^\]\\]|\\.)*)\]\(([^)\s]+)(\s+"[^"]*")?\)/g;

/** Applies `fn` to the Markdown outside fenced code blocks and inline code. */
function outsideCode(md, fn) {
  return md
    .split(/(^```[\s\S]*?^```)/m)
    .map((part, i) =>
      i % 2
        ? part
        : part
            .split(/(`[^`\n]*`)/)
            .map((p, j) => (j % 2 ? p : fn(p)))
            .join(""),
    )
    .join("");
}

/**
 * Rewrites the links in `md`, read from the repository file `from`. `routeOf(repoPath)` gives a
 * site address for a file that is a page, or null.
 */
export function rewriteLinks(md, from, { root, repository, routeOf, problems }) {
  return outsideCode(md, (text) =>
    text.replace(LINK, (all, bang, label, target, title = "") => {
      if (/^(https?:|mailto:|#)/.test(target)) return all;
      if (target.startsWith("/")) return all;
      const [pathPart, hash] = target.split("#");
      const repoPath = normalize(join(dirname(from), decodeURI(pathPart))).replace(/\\/g, "/");
      if (repoPath.startsWith("..")) {
        problems.push(`${from}: link outside the repository: ${target}`);
        return all;
      }
      const route = routeOf(repoPath);
      if (route) return `${bang}[${label}](${route}${hash ? `#${hash}` : ""}${title})`;
      const abs = join(root, repoPath);
      if (!existsSync(abs)) {
        problems.push(`${from}: link to a file that does not exist: ${target}`);
        return all;
      }
      const kind = statSync(abs).isDirectory() ? "tree" : "blob";
      const url = `${repository}/${kind}/main/${repoPath}${hash ? `#${hash}` : ""}`;
      return `${bang}[${label}](${url}${title})`;
    }),
  );
}

/** Every site-internal link in a generated page: `/path/` with an optional `#anchor`. */
export function internalLinks(md) {
  const out = [];
  outsideCode(md, (text) => {
    for (const m of text.matchAll(LINK)) {
      if (m[3].startsWith("/") && !m[3].startsWith("//")) out.push(m[3]);
    }
    for (const m of text.matchAll(/href="(\/[^"]*)"/g)) out.push(m[1]);
    return text;
  });
  return out;
}

/** The heading ids of a Markdown page, as Starlight makes them. */
export function anchors(md) {
  const out = new Set();
  const seen = new Map();
  outsideCode(md, (text) => {
    for (const m of text.matchAll(/^#{1,6}\s+(.+?)\s*$/gm)) {
      const plain = m[1].replace(/`/g, "").replace(/\[([^\]]*)\]\([^)]*\)/g, "$1");
      const base = slug(plain);
      const n = seen.get(base) ?? 0;
      seen.set(base, n + 1);
      out.add(n ? `${base}-${n}` : base);
    }
    return text;
  });
  return out;
}
