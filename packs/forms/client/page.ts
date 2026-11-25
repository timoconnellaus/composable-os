// The form page (stage 29 step 4, ADR 0728): a form drawn as plain HTML by the server, for a link
// or a QR code (`/f/<slug>`) and for a personal link from an email (`/form?t=<token>`). It is a web
// skin over the headless entry's logic (`../client`), with no framework and no build step: the
// host serves it on its own address (apps/app), and a business's web app serves it on its own
// site by forwarding these two paths to the host over its binding (the client template's
// `formPageRoute`). It works without JavaScript: the form posts to its own address and the answer
// is the next page. The little script it has only takes a personal link's token out of the
// address bar and hides the questions shown only if an earlier answer says so.
//
// It holds no rules. It reaches the host through the typed client only (`x.forms.form`,
// `x.forms.submit`): whether the form is open to the caller, the spam checks, the caps, who may
// answer and once only are the door's; the page shows the host's answer. Before sending, the
// answers are checked with the same `checkAnswers` the host runs, for the words beside each
// question; the host checks them again.
//
// A personal link's page (ADR 0723, the security review of PR #458):
// - is sent with `Referrer-Policy: no-referrer`, so the token never leaves as a referrer;
// - loads no script from anywhere else (no Turnstile: a link skips it at the host), by its
//   Content-Security-Policy too;
// - takes the token out of the address bar once loaded (`history.replaceState`), keeping it only
//   in the page, in the form's hidden field, for the send;
// - and opening it (a GET, a mail scanner's) uses nothing: only the send uses the link.
//
// Every page is never cached, never framed (`frame-ancestors 'none'`), sets no cookie and keeps
// nothing a person typed: what they typed is in the request and, when something needs another
// look, in the page drawn back to them, and nowhere else.
import { createClient, type FetchLike } from "@composable-os/client";
import { PERSONAL_LINK_PARAM, PERSONAL_LINK_PATH } from "@composable-os/sdk";
import {
  answersFrom,
  checkDraft,
  type Draft,
  draftFromFields,
  FORMS_OPERATIONS,
  type FormsOperations,
  fieldName,
  formQuestions,
  HONEYPOT_FIELD,
  isAsked,
  type OpenedForm,
  type QuestionItem,
  type Questions,
  type Refusal,
  ratingLabel,
  ratingValues,
  refusalOf,
} from "./index.ts";

/** Where a form's own page is: `/f/<slug>`. */
export const FORM_PAGE_PREFIX = "/f/";
/** Where a personal link opens (the SDK's PERSONAL_LINK_PATH): `/form?t=<token>`. */
export const LINK_PAGE_PATH = PERSONAL_LINK_PATH;

/** Turnstile's script and frames come from here, on a public form's page only. */
export const TURNSTILE_ORIGIN = "https://challenges.cloudflare.com";
const TURNSTILE_SCRIPT = `${TURNSTILE_ORIGIN}/turnstile/v0/api.js`;

/** Whether `pathname` is one of the form page's: `/form`, or `/f/<one part>`. */
export function isFormPagePath(pathname: string): boolean {
  if (pathname === LINK_PAGE_PATH) return true;
  return pathname.startsWith(FORM_PAGE_PREFIX) && !pathname.slice(3).includes("/");
}

/** The typed client's `call`, for the two operations the page makes. */
export interface FormPageClient {
  call<N extends "x.forms.form" | "x.forms.submit">(
    name: N,
    input: FormsOperations[N]["input"],
    options?: { idempotencyKey?: string },
  ): Promise<FormsOperations[N]["output"]>;
}

/**
 * The page's client over a host: the typed client of the two operations, calling the HTTP surface
 * through `fetch` (the host's own surface in-process, or a binding) with `headers` (the visitor's
 * session cookie, and nothing else). It never retries: a send is the person's to make again.
 */
export function formPageClient(options: {
  fetch: FetchLike;
  headers?: () => Record<string, string>;
}): FormPageClient {
  return createClient<FormsOperations>(FORMS_OPERATIONS, {
    baseUrl: "https://host",
    fetch: options.fetch,
    ...(options.headers ? { headers: options.headers } : {}),
    retries: 0,
  });
}

export interface FormPageOptions {
  /** The caller's client: the customer whose session the request carries, or the public. */
  client: FormPageClient;
  /**
   * The Turnstile widget's site key, for a public form's page (TURNSTILE_SITE_KEY on the host).
   * Without one, a form that needs the check says it cannot be sent here.
   */
  turnstileSiteKey?: string | null;
  /**
   * Who checked that a send comes from this page. `page` (the default, the host's own address):
   * this function checks the browser's word (`Sec-Fetch-Site`, else `Origin`). `forwarded`: the
   * page is served over the client-app binding, whose Worker checked its browser's request
   * (the template's `formPageRoute`) and forwards none of those headers.
   */
  sameOrigin?: "page" | "forwarded";
}

/**
 * Whether a browser's POST comes from the page's own origin (ADR 0728, review of PR #461): an
 * allow-list. With `Sec-Fetch-Site`, only `same-origin` (or `none`, a person's own action); a
 * sibling subdomain is `same-site` and is refused, as a customer's cookie still goes with it.
 * Without it (an older browser), `Origin` must be the page's own, or `null` (the page's own
 * no-referrer policy makes a browser send `null`).
 */
export function sameOriginPost(
  headers: { get(name: string): string | null },
  pageOrigin: string,
): boolean {
  const site = headers.get("sec-fetch-site");
  if (site !== null) return site === "same-origin" || site === "none";
  const origin = headers.get("origin");
  return origin === "null" || origin === pageOrigin;
}

/**
 * A request's body as text, read only up to `max` bytes: null when it says (`content-length`) or
 * turns out to be longer, so a large body is never held whole.
 */
export async function cappedText(request: Request, max: number): Promise<string | null> {
  const declared = Number(request.headers.get("content-length") ?? "");
  if (Number.isFinite(declared) && declared > max) return null;
  if (!request.body) return "";
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      await reader.cancel().catch(() => undefined);
      return null;
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let at = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, at);
    at += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

// Each answer is an id in the page, so its label, help and error are tied to it.
const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const TOKEN = /^[A-Za-z0-9_-]{43}$/;
const KEY = /^[A-Za-z0-9._:-]{16,128}$/;
/** The most a posted form may be, in bytes: the answers' 20 KB, URL-encoded, and the page's own fields. */
export const MAX_BODY = 131_072;

/** The one script the page runs, inline and allowed by its hash alone. */
export const PAGE_SCRIPT = `(function () {
  var url = new URL(location.href);
  if (url.searchParams.has("${PERSONAL_LINK_PARAM}")) {
    url.searchParams.delete("${PERSONAL_LINK_PARAM}");
    history.replaceState(null, "", url.pathname + url.search + url.hash);
  }
  var form = document.querySelector("form[data-form]");
  if (!form) return;
  function values(key) {
    var out = [];
    form.querySelectorAll('[name="a.' + key + '"]').forEach(function (field) {
      if (field.type === "radio" || field.type === "checkbox" ? field.checked : field.value !== "")
        out.push(field.value);
    });
    return out;
  }
  function sync() {
    form.querySelectorAll("[data-show-q]").forEach(function (item) {
      var on = values(item.getAttribute("data-show-q")).indexOf(item.getAttribute("data-show-is")) >= 0;
      item.hidden = !on;
      item.querySelectorAll("input, select, textarea").forEach(function (field) {
        field.disabled = !on;
      });
    });
  }
  form.addEventListener("change", sync);
  sync();
  form.addEventListener("submit", function () {
    var button = form.querySelector('button[type="submit"]');
    if (button) setTimeout(function () { button.disabled = true; }, 0);
  });
})();`;

let scriptHash: Promise<string> | null = null;
/** The script's CSP source: `'sha256-…'`. */
export function pageScriptSource(): Promise<string> {
  scriptHash ??= crypto.subtle
    .digest("SHA-256", new TextEncoder().encode(PAGE_SCRIPT))
    .then((digest) => {
      let s = "";
      for (const b of new Uint8Array(digest)) s += String.fromCharCode(b);
      return `'sha256-${btoa(s)}'`;
    });
  return scriptHash;
}

/** The headers of every page: never cached, framed or sent on; Turnstile only where asked. */
async function pageHeaders(turnstile: boolean): Promise<Headers> {
  const script = await pageScriptSource();
  const policy = [
    "default-src 'none'",
    `script-src ${script}${turnstile ? ` ${TURNSTILE_ORIGIN}` : ""}`,
    ...(turnstile ? [`frame-src ${TURNSTILE_ORIGIN}`, `connect-src ${TURNSTILE_ORIGIN}`] : []),
    "style-src 'unsafe-inline'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    "base-uri 'none'",
  ].join("; ");
  return new Headers({
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store",
    "referrer-policy": "no-referrer",
    "x-frame-options": "DENY",
    "x-content-type-options": "nosniff",
    "content-security-policy": policy,
    "permissions-policy": "camera=(), microphone=(), geolocation=()",
  });
}

const esc = (text: string) =>
  text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");

const STYLE = `
:root { color-scheme: light dark; --fg: #18181b; --muted: #52525b; --bg: #ffffff; --line: #a1a1aa;
  --accent: #1d4ed8; --danger: #b91c1c; --surface: #f4f4f5; }
@media (prefers-color-scheme: dark) { :root { --fg: #f4f4f5; --muted: #d4d4d8; --bg: #18181b;
  --line: #71717a; --accent: #93c5fd; --danger: #fca5a5; --surface: #27272a; } }
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--fg); font: 16px/1.5 system-ui, sans-serif; }
main { max-width: 40rem; margin: 0 auto; padding: 2rem 1rem 4rem; }
h1 { font-size: 1.75rem; line-height: 1.25; margin: 0 0 1.5rem; }
h2 { font-size: 1.25rem; margin: 1.5rem 0 0.5rem; }
.q { margin: 0 0 1.5rem; border: 0; padding: 0; min-width: 0; }
.q > label, .q > legend { display: block; font-weight: 600; margin-bottom: 0.25rem; padding: 0; }
.req { font-weight: 400; color: var(--muted); }
.help, .when { color: var(--muted); margin: 0 0 0.5rem; }
.when { font-size: 0.875rem; }
.error { color: var(--danger); font-weight: 600; margin: 0 0 0.5rem; }
input[type=text], input[type=email], input[type=tel], input[type=number], input[type=date],
textarea, select { display: block; width: 100%; min-height: 2.75rem; padding: 0.5rem 0.75rem;
  font: inherit; color: inherit; background: var(--bg); border: 1px solid var(--line);
  border-radius: 0.375rem; }
textarea { min-height: 8rem; resize: vertical; }
[aria-invalid=true] { border-color: var(--danger); border-width: 2px; }
.option { display: flex; align-items: flex-start; gap: 0.5rem; min-height: 2.75rem; padding: 0.5rem 0; }
.option input { width: 1.25rem; height: 1.25rem; margin: 0.125rem 0 0; flex: none; }
.scale { display: flex; flex-wrap: wrap; gap: 0.5rem; }
.scale .option { border: 1px solid var(--line); border-radius: 0.375rem; padding: 0.5rem 0.75rem; }
:focus-visible { outline: 3px solid var(--accent); outline-offset: 2px; }
button { min-height: 2.75rem; padding: 0.5rem 1.25rem; font: inherit; font-weight: 600;
  color: var(--bg); background: var(--fg); border: 0; border-radius: 0.375rem; cursor: pointer; }
button[disabled] { opacity: 0.6; }
.summary { border: 2px solid var(--danger); border-radius: 0.375rem; padding: 0.75rem 1rem;
  margin: 0 0 1.5rem; }
.summary h2 { margin-top: 0; font-size: 1.125rem; }
.summary a { color: var(--danger); }
.note { background: var(--surface); border-radius: 0.375rem; padding: 0.75rem 1rem; margin: 0 0 1.5rem; }
.hp { position: absolute; left: -10000px; top: auto; width: 1px; height: 1px; overflow: hidden; }
`;

async function page(
  status: number,
  title: string,
  body: string,
  { turnstile = false }: { turnstile?: boolean } = {},
): Promise<Response> {
  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<meta name="referrer" content="no-referrer">
<title>${esc(title)}</title>
<style>${STYLE}</style>
${turnstile ? `<script src="${TURNSTILE_SCRIPT}" async defer></script>` : ""}
</head>
<body>
<main>
${body}
</main>
<script>${PAGE_SCRIPT}</script>
</body>
</html>`;
  return new Response(html, { status, headers: await pageHeaders(turnstile) });
}

/** A page with one heading and one line: not found, used, thanks, try later. */
function notice(status: number, title: string, line: string, role: "status" | "alert" = "status") {
  return page(status, title, `<h1>${esc(title)}</h1>\n<p role="${role}">${esc(line)}</p>`);
}

const notOpen = () =>
  notice(404, "This form is not open", "This form is not taking answers just now.");

// --- Drawing a form ------------------------------------------------------------------------------

/** Rich text's inline runs as HTML: text, bold, italic, code, links of the schemes it allows. */
function inlines(content: unknown): string {
  if (!Array.isArray(content)) return "";
  return content
    .map(
      (run: {
        type?: string;
        text?: string;
        bold?: boolean;
        italic?: boolean;
        code?: boolean;
        href?: string;
      }) => {
        if (run?.type === "break") return "<br>";
        if (run?.type !== "text" || typeof run.text !== "string") return "";
        let html = esc(run.text);
        if (run.code) html = `<code>${html}</code>`;
        if (run.italic) html = `<em>${html}</em>`;
        if (run.bold) html = `<strong>${html}</strong>`;
        if (typeof run.href === "string" && /^(?:https?:|mailto:)/i.test(run.href)) {
          html = `<a href="${esc(run.href)}" rel="noopener noreferrer nofollow">${html}</a>`;
        }
        return html;
      },
    )
    .join("");
}

const id = (prefix: string, key: string) => `${prefix}-${key}`;

/** The `aria-describedby` of a question: its help and its error, where it has them. */
function described(item: { key: string; help?: string }, error: string | undefined): string {
  const ids = [item.help ? id("h", item.key) : null, error ? id("e", item.key) : null].filter(
    Boolean,
  );
  return ids.length ? ` aria-describedby="${ids.join(" ")}"` : "";
}

function helpAndError(item: { key: string; help?: string }, error: string | undefined): string {
  return (
    (item.help ? `<p class="help" id="${id("h", item.key)}">${esc(item.help)}</p>` : "") +
    (error ? `<p class="error" id="${id("e", item.key)}">${esc(error)}</p>` : "")
  );
}

const AUTOCOMPLETE: Record<string, string> = { name: "name", email: "email", phone: "tel" };

/** One item of the form, with what was typed (drawn back after a refusal) and its error. */
function itemHtml(
  item: QuestionItem,
  questions: Questions,
  value: Draft[string] | undefined,
  error: string | undefined,
): string {
  // Shown only if an earlier answer has a value: the script hides it until then; without
  // JavaScript it says when to answer it, and an answer to it is not sent while it does not hold.
  const condition = item.showIf
    ? ` data-show-q="${esc(item.showIf.question)}" data-show-is="${esc(item.showIf.is)}"`
    : "";
  const target = item.showIf ? questions.items.find((q) => q.key === item.showIf?.question) : null;
  const when =
    item.showIf && (target?.kind === "yesNo" || target?.kind === "choice")
      ? `<p class="when">Answer this only if you answered “${esc(
          target.kind === "yesNo" ? (item.showIf.is === "yes" ? "Yes" : "No") : item.showIf.is,
        )}” to “${esc(target.label)}”.</p>`
      : "";
  if (item.kind === "heading") return `<h2${condition}>${esc(item.text)}</h2>`;
  if (item.kind === "paragraph") return `<p${condition}>${inlines(item.content)}</p>`;
  const field = esc(fieldName(item.key));
  const input = esc(id("f", item.key));
  const invalid = error ? ` aria-invalid="true"` : "";
  const required = item.required ? " required" : "";
  const requiredWords = item.required ? ` <span class="req">(required)</span>` : "";
  // A question shown only if another holds is never required by the browser: it may be hidden.
  const native = item.showIf ? "" : required;
  if (item.kind === "consent") {
    const ticked = value === true ? " checked" : "";
    return `<div class="q" id="${esc(id("q", item.key))}"${condition}>${when}${helpAndError(item, error)}
<div class="option"><input type="checkbox" id="${input}" name="${field}" value="yes"${ticked}${native}${invalid}${described(item, error)}>
<label for="${input}">${esc(item.words).replaceAll("\n", "<br>")}${requiredWords}</label></div></div>`;
  }
  const label = `${esc(item.label)}${requiredWords}`;
  const options = (choices: { value: string; label: string; checked: boolean }[], type: string) =>
    choices
      .map(
        (c, i) =>
          `<div class="option"><input type="${type}" id="${input}-${i}" name="${field}" value="${esc(c.value)}"${c.checked ? " checked" : ""}${type === "radio" ? native : ""}${invalid}><label for="${input}-${i}">${esc(c.label)}</label></div>`,
      )
      .join("\n");
  const group = (inner: string, scale = false) =>
    `<fieldset class="q" id="${esc(id("q", item.key))}"${condition}${described(item, error)}><legend>${label}</legend>${when}${helpAndError(item, error)}${scale ? `<div class="scale">${inner}</div>` : inner}</fieldset>`;
  switch (item.kind) {
    case "choice": {
      const chosen = Array.isArray(value) ? value : typeof value === "string" ? [value] : [];
      return group(
        options(
          item.options.map((o) => ({ value: o, label: o, checked: chosen.includes(o) })),
          item.multiple ? "checkbox" : "radio",
        ),
      );
    }
    case "rating":
      return group(
        options(
          ratingValues(item).map((n) => ({
            value: String(n),
            label: ratingLabel(item, n),
            checked: value === n,
          })),
          "radio",
        ),
        true,
      );
    case "yesNo":
      return group(
        options(
          [
            { value: "yes", label: "Yes", checked: value === true },
            { value: "no", label: "No", checked: value === false },
          ],
          "radio",
        ),
        true,
      );
    default: {
      const text = typeof value === "string" ? value : "";
      const auto = item.map?.to === "person" ? AUTOCOMPLETE[item.map.field] : undefined;
      const common = `id="${input}" name="${field}"${native}${invalid}${described(item, error)}${auto ? ` autocomplete="${auto}"` : ""}`;
      let control: string;
      if (item.kind === "text" && item.long) {
        control = `<textarea ${common} rows="6" maxlength="${item.max ?? 5000}">${esc(text)}</textarea>`;
      } else {
        const attrs =
          item.kind === "text"
            ? `type="text" maxlength="${item.max ?? 200}"`
            : item.kind === "email"
              ? `type="email" maxlength="320" inputmode="email"${auto ? "" : ` autocomplete="email"`}`
              : item.kind === "phone"
                ? `type="tel" maxlength="40" inputmode="tel"${auto ? "" : ` autocomplete="tel"`}`
                : item.kind === "number"
                  ? `type="number" inputmode="decimal" step="${item.integer ? "1" : "any"}"${item.min !== undefined ? ` min="${item.min}"` : ""}${item.max !== undefined ? ` max="${item.max}"` : ""}`
                  : `type="date"`;
        control = `<input ${attrs} ${common} value="${esc(text)}">`;
      }
      return `<div class="q" id="${esc(id("q", item.key))}"${condition}><label for="${input}">${label}</label>${when}${helpAndError(item, error)}${control}</div>`;
    }
  }
}

/**
 * What a link's page carries of its questions (`_q`): their keys and kinds, enough to turn the
 * posted fields into the same answers again. Used only when the link cannot be opened again on a
 * send (it was used: a reload after the send), to ask the host for its stored reply.
 */
type Skeleton = { k: string; t: string; m?: 1; l?: 1; s?: [string, string] }[];

function skeletonOf(questions: Questions): Skeleton {
  return questions.items.map((item) => ({
    k: item.key,
    t: item.kind,
    ...(item.kind === "choice" && item.multiple ? { m: 1 as const } : {}),
    ...(item.kind === "text" && item.long ? { l: 1 as const } : {}),
    ...(item.showIf ? { s: [item.showIf.question, item.showIf.is] as [string, string] } : {}),
  }));
}

/** The questions a skeleton stands for, or null when it is not one. */
function questionsOfSkeleton(text: string | null): Questions | null {
  try {
    const parsed: unknown = JSON.parse(text ?? "");
    if (!Array.isArray(parsed) || parsed.length > 60) return null;
    const items = parsed.map((raw) => {
      const r = raw as { k?: unknown; t?: unknown; m?: unknown; l?: unknown; s?: unknown };
      if (typeof r.k !== "string" || typeof r.t !== "string") throw new Error("not a skeleton");
      const show =
        Array.isArray(r.s) && typeof r.s[0] === "string" && typeof r.s[1] === "string"
          ? { showIf: { question: r.s[0], is: r.s[1] } }
          : {};
      return {
        key: r.k,
        kind: r.t,
        label: "",
        options: [],
        ...(r.m ? { multiple: true } : {}),
        ...(r.l ? { long: true } : {}),
        ...show,
      };
    });
    return { items } as unknown as Questions;
  } catch {
    return null;
  }
}

interface Drawn {
  opened: OpenedForm;
  /** The form's own address: where it posts. */
  action: string;
  /** A personal link's token, carried in the form's hidden field for the send. */
  link?: string;
  draft?: Draft;
  errors?: Readonly<Record<string, string>>;
  /** What the host said about the form as a whole. */
  problem?: string | null;
  turnstileSiteKey?: string | null;
}

function formPageOf(d: Drawn): Promise<Response> {
  const questions = formQuestions(d.opened);
  const errors = d.errors ?? {};
  const title = d.opened.title ?? "Form";
  // A personal link skips the spam check at the host: its page loads nothing from anywhere else.
  const turnstile = !d.link && d.opened.turnstile;
  const canCheck = turnstile && Boolean(d.turnstileSiteKey);
  const faults = questions.items.filter((item) => errors[item.key]);
  const summary =
    faults.length || d.problem
      ? `<div class="summary" role="alert" tabindex="-1" autofocus><h2>${faults.length ? "Some answers need another look" : "Your answers were not sent"}</h2>${d.problem ? `<p>${esc(d.problem)}</p>` : ""}${
          faults.length
            ? `<ul>${faults
                .map((item) => {
                  const name = isAsked(item)
                    ? item.kind === "consent"
                      ? item.words
                      : item.label
                    : "";
                  const grouped = ["choice", "rating", "yesNo"].includes(item.kind);
                  const field = `${id("f", item.key)}${grouped ? "-0" : ""}`;
                  return `<li><a href="#${esc(field)}">${esc(name.slice(0, 120))}: ${esc(errors[item.key] ?? "")}</a></li>`;
                })
                .join("")}</ul>`
            : ""
        }</div>`
      : "";
  const items = questions.items
    .map((item) =>
      itemHtml(
        item,
        questions,
        d.draft && Object.hasOwn(d.draft, item.key) ? d.draft[item.key] : undefined,
        errors[item.key],
      ),
    )
    .join("\n");
  const hidden = [
    ["_id", d.opened.id],
    ["_version", String(d.opened.version)],
    ...(d.opened.shown && !d.link ? [["_shown", d.opened.shown]] : []),
    // One key for this page's send: a second press, or the browser posting it again, is the
    // same send to the host, which answers it once.
    ["_key", crypto.randomUUID()],
    ...(d.link
      ? [
          ["_link", d.link],
          ["_q", JSON.stringify(skeletonOf(questions))],
        ]
      : []),
  ]
    .map(([name, value]) => `<input type="hidden" name="${name}" value="${esc(value ?? "")}">`)
    .join("\n");
  const cannotCheck =
    turnstile && !canCheck
      ? `<p class="note" role="note">This form cannot be sent from this page just now. Please try again later.</p>`
      : "";
  const body = `<h1>${esc(title)}</h1>
${summary}${cannotCheck}
<form method="post" action="${esc(d.action)}" data-form>
${hidden}
<div class="hp" aria-hidden="true"><label for="f-${HONEYPOT_FIELD}">Leave this empty</label><input type="text" id="f-${HONEYPOT_FIELD}" name="${HONEYPOT_FIELD}" tabindex="-1" autocomplete="off"></div>
${items}
${
  canCheck
    ? `<div class="cf-turnstile" data-sitekey="${esc(d.turnstileSiteKey ?? "")}"></div>
<noscript><p class="note">This form needs JavaScript for its spam check.</p></noscript>`
    : ""
}
<p><button type="submit">Send</button></p>
</form>`;
  return page(d.problem || faults.length ? 422 : 200, title, body, { turnstile: canCheck });
}

// --- The routes ----------------------------------------------------------------------------------

function slugOf(pathname: string): string | null {
  let slug: string;
  try {
    slug = decodeURIComponent(pathname.slice(FORM_PAGE_PREFIX.length));
  } catch {
    return null;
  }
  return slug.length <= 200 && SLUG.test(slug) ? slug : null;
}

/** The status a refusal is answered with. */
function statusOf(refusal: Refusal): number {
  switch (refusal.kind) {
    case "answers":
      return 422;
    case "reload":
      return 409;
    case "later":
      return 429;
    case "offline":
      return 503;
    default:
      return 400;
  }
}

/**
 * Serves one request to the form page: GET (or HEAD) draws the form, POST sends it. A path that is
 * not the page's is not found. Never throws.
 */
export async function formPage(request: Request, options: FormPageOptions): Promise<Response> {
  const url = new URL(request.url);
  const isLink = url.pathname === LINK_PAGE_PATH;
  const slug = isLink ? null : slugOf(url.pathname);
  if (!isLink && !slug) return notOpen();
  if (request.method === "GET" || request.method === "HEAD") {
    const response = await show(url, isLink, slug, options);
    return request.method === "HEAD"
      ? new Response(null, { status: response.status, headers: response.headers })
      : response;
  }
  if (request.method !== "POST") {
    const refused = await notice(405, "Not allowed", "Open this page with its link.");
    refused.headers.set("allow", "GET, HEAD, POST");
    return refused;
  }
  // A send comes from this page: never another site's form, nor a sibling subdomain's.
  if ((options.sameOrigin ?? "page") === "page" && !sameOriginPost(request.headers, url.origin)) {
    return notice(403, "Not sent", "Answers are sent from this page only.", "alert");
  }
  const type = request.headers.get("content-type") ?? "";
  if (!/^application\/x-www-form-urlencoded\b/i.test(type)) {
    return notice(415, "Not sent", "Answers are sent from this page's form.", "alert");
  }
  const text = await cappedText(request, MAX_BODY);
  if (text === null) {
    return notice(413, "Not sent", "The answers are too long to send: shorten them.", "alert");
  }
  return send(new URLSearchParams(text), isLink, slug, options);
}

async function open(
  options: FormPageOptions,
  isLink: boolean,
  slug: string | null,
  link: string | null,
): Promise<OpenedForm | Refusal> {
  try {
    // Opening a form by its link uses nothing: only the send does (ADR 0723).
    return await options.client.call(
      "x.forms.form",
      isLink ? { link: link ?? "" } : { slug: slug ?? "" },
    );
  } catch (error) {
    return refusalOf(error);
  }
}

const isRefusal = (value: OpenedForm | Refusal): value is Refusal => "kind" in value;

async function cannotOpen(refusal: Refusal, isLink: boolean): Promise<Response> {
  if (refusal.kind === "offline" || refusal.kind === "later" || refusal.kind === "other") {
    return notice(503, "Try again shortly", "This form could not be opened just now.", "alert");
  }
  if (isLink) {
    return notice(
      404,
      "This link cannot be used",
      "It may have been used already or have expired. Nothing more is needed from you.",
    );
  }
  return notOpen();
}

async function show(
  url: URL,
  isLink: boolean,
  slug: string | null,
  options: FormPageOptions,
): Promise<Response> {
  const token = isLink ? url.searchParams.get(PERSONAL_LINK_PARAM) : null;
  if (isLink && !(token && TOKEN.test(token))) {
    return notice(
      404,
      "This link is not complete",
      "Open the link from your email again, or copy all of it into the address bar.",
    );
  }
  const opened = await open(options, isLink, slug, token);
  if (isRefusal(opened)) return cannotOpen(opened, isLink);
  return formPageOf({
    opened,
    action: isLink ? LINK_PAGE_PATH : `${FORM_PAGE_PREFIX}${slug}`,
    ...(token ? { link: token } : {}),
    turnstileSiteKey: options.turnstileSiteKey ?? null,
  });
}

/** The thanks for a send the host already took, when the form cannot be opened again. */
const sentAlready = () =>
  page(
    200,
    "Thank you",
    `<h1>Thank you</h1>\n<p role="status">${esc("Thank you. Your answers were sent.")}</p>`,
  );

/**
 * A link's send again (a reload after it went): the same answers, by the page's `_q`, under the
 * page's key, so the host's stored reply answers. Null when it does not (a link used another way,
 * or never by this page): the page then says the link cannot be used.
 */
async function replay(
  posted: URLSearchParams,
  token: string,
  options: FormPageOptions,
): Promise<Response | null> {
  const key = posted.get("_key") ?? "";
  const id = posted.get("_id") ?? "";
  const version = Number(posted.get("_version"));
  const questions = questionsOfSkeleton(posted.get("_q"));
  if (!KEY.test(key) || !id || !Number.isInteger(version) || version < 1 || !questions) return null;
  const answers = answersFrom(
    questions,
    draftFromFields(questions, (name) => posted.getAll(name)),
  );
  const honeypot = posted.get(HONEYPOT_FIELD);
  try {
    await options.client.call(
      "x.forms.submit",
      { id, version, answers, link: token, ...(honeypot ? { honeypot } : {}) },
      { idempotencyKey: key },
    );
    return sentAlready();
  } catch {
    return null;
  }
}

async function send(
  posted: URLSearchParams,
  isLink: boolean,
  slug: string | null,
  options: FormPageOptions,
): Promise<Response> {
  const token = isLink ? posted.get("_link") : null;
  if (isLink && !(token && TOKEN.test(token))) {
    return notice(404, "This link cannot be used", "Open the link from your email again.");
  }
  // The form as it is now, for its questions: the version the person saw is sent with the
  // answers, and the host says "load it again" when it changed.
  const opened = await open(options, isLink, slug, token);
  if (isRefusal(opened)) {
    // A link used by this very page's send (a reload of the thanks): its stored reply answers.
    if (isLink && opened.kind === "gone" && token) {
      const replayed = await replay(posted, token, options);
      if (replayed) return replayed;
    }
    return cannotOpen(opened, isLink);
  }
  const questions = formQuestions(opened);
  const draft = draftFromFields(questions, (name) => posted.getAll(name));
  // The time the person was first shown the form travels with every redraw, so a quick correction
  // is not taken for a bot and silently dropped (review of PR #461). Only a form that changed is
  // shown afresh, with its new time.
  const postedShown = posted.get("_shown");
  const again = (
    problem: string | null,
    errors: Readonly<Record<string, string>> = {},
    status?: number,
    fresh = false,
  ) =>
    formPageOf({
      opened: fresh || !postedShown ? opened : { ...opened, shown: postedShown },
      action: isLink ? LINK_PAGE_PATH : `${FORM_PAGE_PREFIX}${slug}`,
      ...(token ? { link: token } : {}),
      draft,
      errors,
      problem,
      turnstileSiteKey: options.turnstileSiteKey ?? null,
    }).then((response) =>
      status ? new Response(response.body, { status, headers: response.headers }) : response,
    );
  const checked = checkDraft(questions, draft);
  if (!checked.ok) return again(checked.general, checked.byKey);
  const version = Number(posted.get("_version"));
  const key = posted.get("_key") ?? "";
  const turnstileToken = posted.get("cf-turnstile-response");
  const shown = posted.get("_shown");
  const honeypot = posted.get(HONEYPOT_FIELD);
  try {
    await options.client.call(
      "x.forms.submit",
      {
        id: opened.id,
        version: Number.isInteger(version) && version > 0 ? version : opened.version,
        answers: checked.answers,
        ...(token ? { link: token } : { via: "page" as const }),
        ...(!token && shown ? { shown } : {}),
        ...(!token && turnstileToken ? { turnstileToken } : {}),
        ...(honeypot ? { honeypot } : {}),
      },
      KEY.test(key) ? { idempotencyKey: key } : {},
    );
  } catch (error) {
    const refusal = refusalOf(error, questions);
    if (refusal.kind === "gone") return cannotOpen(refusal, isLink);
    return again(
      refusal.kind === "answers"
        ? null
        : refusal.kind === "reload"
          ? "This form changed since you opened it: check your answers and send them again."
          : refusal.message,
      refusal.kind === "answers" ? refusal.byKey : {},
      statusOf(refusal),
      refusal.kind === "reload",
    );
  }
  const title = opened.title ?? "Form";
  return page(
    200,
    title,
    `<h1>${esc(title)}</h1>\n<p role="status">${esc(opened.thanks ?? "Thank you. Your answers were sent.")}</p>`,
  );
}
