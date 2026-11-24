// Small text helpers for the generator: front matter, slugs, Markdown escaping and tables. Node
// built-ins only, so the documents lane runs them with no install.

/**
 * Splits `---` front matter from a Markdown file. Understands the subset the docs use: `key: value`,
 * `key: [a, b]` and `key:` followed by `- item` lines. Values are strings; nothing is evaluated.
 */
export function frontMatter(text) {
  const m = text.match(/^---\n([\s\S]*?)\n---\n?/);
  if (!m) return { data: {}, body: text };
  const data = {};
  let list = null;
  for (const raw of m[1].split("\n")) {
    const line = raw.replace(/\s+$/, "");
    if (!line.trim() || line.trim().startsWith("#")) continue;
    const item = line.match(/^\s+-\s+(.*)$/);
    if (item && list) {
      data[list].push(unquote(item[1]));
      continue;
    }
    const nested = line.match(/^\s+([A-Za-z][\w-]*):\s*(.*)$/);
    if (nested && list) {
      // `key:` with indented `name: value` lines under it: an object.
      if (Array.isArray(data[list]) && !data[list].length) data[list] = {};
      data[list][nested[1]] = unquote(nested[2]);
      continue;
    }
    const kv = line.match(/^([A-Za-z][\w-]*):\s*(.*)$/);
    if (!kv) throw new Error(`Front matter line not understood: ${line}`);
    const [, key, value] = kv;
    if (value === "") {
      data[key] = [];
      list = key;
    } else if (value.startsWith("[") && value.endsWith("]")) {
      data[key] = value
        .slice(1, -1)
        .split(",")
        .map((v) => unquote(v.trim()))
        .filter(Boolean);
      list = null;
    } else {
      data[key] = unquote(value);
      list = null;
    }
  }
  return { data, body: text.slice(m[0].length) };
}

function unquote(v) {
  return /^(["']).*\1$/.test(v) ? v.slice(1, -1) : v;
}

/** The heading id Starlight gives a heading (github-slugger's rule). */
export function slug(text) {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{M}\p{N}\p{Pc} -]/gu, "")
    .replace(/ /g, "-");
}

/** Text from the code, made safe for Markdown prose: no raw HTML, no line breaks in a cell. */
export function inline(text) {
  if (text === undefined || text === null) return "";
  return String(text)
    .split(/(`[^`]*`)/)
    .map((part, i) => (i % 2 ? part : part.replace(/</g, "&lt;").replace(/>/g, "&gt;")))
    .join("")
    .replace(/\s*\n\s*/g, " ")
    .trim();
}

/** A table cell: inline text with its pipes escaped. */
export function cell(text) {
  return inline(text).replace(/\|/g, "\\|");
}

export const code = (text) => `\`${String(text).replace(/`/g, "'")}\``;

/** A Markdown table, or `empty` when there are no rows. */
export function table(head, rows, empty = "None.") {
  if (!rows.length) return empty;
  return [
    `| ${head.join(" | ")} |`,
    `| ${head.map(() => "---").join(" | ")} |`,
    ...rows.map((r) => `| ${r.map((c) => (c === undefined || c === "" ? " " : c)).join(" | ")} |`),
  ].join("\n");
}

/** A page: Starlight front matter and its body, ending in one newline. */
export function page({ title, description, order, label }, body) {
  const fm = [`title: ${JSON.stringify(title)}`];
  if (description) fm.push(`description: ${JSON.stringify(inline(description))}`);
  if (order !== undefined || label) {
    fm.push("sidebar:");
    if (label) fm.push(`  label: ${JSON.stringify(label)}`);
    if (order !== undefined) fm.push(`  order: ${order}`);
  }
  fm.push("editUrl: false");
  return `---\n${fm.join("\n")}\n---\n\n${body.trim()}\n`;
}

/** The first sentence of a description, for a list or a summary. */
export function firstSentence(text) {
  const t = inline(text);
  const m = t.match(/^(.+?[.!?])(\s|$)/);
  return m ? m[1] : t;
}

/** The leading `//` comment block of a source file, as one paragraph of text. */
export function headerComment(source) {
  const lines = [];
  for (const line of source.split("\n")) {
    const m = line.match(/^\s*\/\/\s?(.*)$/);
    if (!m) break;
    lines.push(m[1]);
  }
  return lines.join(" ").replace(/\s+/g, " ").trim();
}
