# ADR 0728: The form page and the form blocks

Status: accepted, 2026-11-25 (stage 29, build step 4: `feat/stage-29-form-page`, block BG; no
migration). Builds on ADRs [0720](0720-the-intake-door-one-public-write.md) (the intake door),
[0722](0722-abuse-checks-turnstile-honeypot-fill-time-caps.md) (the spam checks),
[0723](0723-personal-links-used-once.md) (personal links), [0726](0726-the-forms-pack-forms-submissions-and-who-reads-them.md)
(the Forms pack), [0403](0403-http-surface-and-typed-client.md) (client code
reaches the host through the typed client), [0418](0418-the-typed-client-as-built.md) (headless
entries), [0421](0421-the-client-app-binding-and-customer-sign-in.md) (the client-app binding) and
[0424](0424-blocks-as-built.md) (blocks).

## Context

Stage 29 lets a person fill in a form three ways (decision 9): on the business's own website
built on the platform, in its app, and from a link or a QR code. Step 5 (ADR 0723) emails a
personal link to `<site>/form?t=<token>`, the business's own site; until this step that page did
not exist. The spec names a hosted page on the host, `/f/<slug>`, for a link or a QR code, and the
client web app's personal-link page, with three rules from the security review of PR #458: it is
sent with `Referrer-Policy: no-referrer`, loads no third-party script, and takes the token out of
the address bar once read; and a GET of it never uses the link.

Two things shaped where the page lives. A business with no site of its own has only the host's
address. And the client template is generated per product: a client without Forms has no
`x.forms.*` operation in its typed client, so the template cannot hold code that calls them
(`cos deploy` type-checks it).

## Decision

**One form page, drawn by the Forms pack, served by the host on its address and over the binding.**

- **The page** (`@composable-os/pack-forms/page`, `packs/forms/client/page.ts`) draws a form as plain HTML on the server, with
  every question kind, and posts to its own address: it works with no JavaScript. Its one inline
  script, allowed by its hash alone, takes a personal link's token out of the address bar
  (`history.replaceState`) and hides the questions shown only if an earlier answer holds (without
  it, each says when to answer it, and an answer to a hidden one is not sent). It is a web skin
  over the headless entry's logic, not a second copy: the answers it sends are the entry's
  `answersFrom`, checked first with the SDK's `checkAnswers` for the words beside each question,
  and its words for a refusal are the entry's.
- **Its calls are the typed client's** (`x.forms.form`, `x.forms.submit`), over the HTTP surface
  of the client-app binding's door, in-process on the host: the caller is a customer by their
  verified session cookie or the public, never staff, and each send carries the page's
  Idempotency-Key, so a reload or a second press is one answer. Only the customer's session cookie
  is passed on.
- **Where**: cos-app serves `/f/<slug>` and `/form` on the host's own address (both in the Access
  bypass list, `customers-on-host`), and the `ClientApp` binding serves the same two paths. The
  client template's `formPageRoute` forwards them from the business's site to the binding with the
  customer's cookie and the form's fields only, refuses a post from another site before anything
  reaches the host, and passes back the page with its own headers (no referrer and no cache set
  again there). So a personal link opens on the business's site, a QR code may name either, and
  the template stays free of Forms' operations: with no Forms, both paths are not found.
- **Every page** is never cached, never framed (`frame-ancestors 'none'`, `X-Frame-Options`),
  sends no referrer, sets no cookie and keeps nothing typed: what a person typed is in their
  request and, when something needs another look, in the page drawn back to them.
- **A personal link's page** loads nothing from anywhere else, by its Content-Security-Policy too
  (no origin but its own script's hash): the host skips Turnstile for a link, so the page draws no
  widget even if asked. Opening it calls `x.forms.form { link }`, which uses nothing; only the
  send uses the link, once.
- **The spam checks travel with the send.** The honeypot is a field a person never sees
  (`website`), the time the form was shown is the host's token from opening it (`_shown`), and a
  visitor's Turnstile token is the widget's `cf-turnstile-response`. A public form's page draws
  Turnstile's widget with the host's `TURNSTILE_SITE_KEY` (an optional cos-app secret, though not
  secret, so it stays out of `wrangler.jsonc`), and allows Cloudflare's origin for its script and
  frame on that page only.
- **The blocks** (`forms-form`, web; `forms-native-form`, native) render every question kind from
  the same headless entry (`@composable-os/pack-forms/client`): a form by its address, by a
  personal link's token (`takeLinkToken` reads it once and takes it out of the address), or a
  signed-in member's own link from Needs your attention by its id (`linkedForm`,
  `submitLinked`). A block loads no script of its own: the app passes its Turnstile widget as a
  prop. They hold no rule: the host's answer is the one shown, a refusal staying on the screen with
  the answers as typed.

## Consequences

- The edge rule that counts public calls per address names `/f/` and `/form` on the host's zone
  and, with Forms on, on the web app's (`cos create` and `cos init` print it).
- A business's site shows the host's page, in the host's plain look, at its own address. A site
  that wants the page in its own look uses the web block in a page of its own; it then sets the
  referrer policy on that page itself, and takes the token from the address with `takeLinkToken`.
- Local development and the e2e suite use Cloudflare's documented Turnstile test keys
  (`scripts/dev-setup.mjs`); a real site key on a real hostname is not yet tried.
- Framing the page from listed sites (decision 9's later step) changes its `frame-ancestors`.

## Considered and rejected

- **The page as a TanStack route in cos-app** (as `/buy` is): it would need JavaScript to send,
  and a route's headers and its scripts are the framework's.
- **A `/form` route of the template's own, calling `x.forms.*`**: it does not type-check for a
  client without Forms, and two pages would each have to keep the three rules.
- **Turnstile on a personal link's page**: the host already skips it for a link, and it is the
  third-party script the review rules out.
