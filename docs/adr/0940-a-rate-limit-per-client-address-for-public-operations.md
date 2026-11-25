# ADR 0940: A rate limit per client address for public operations

Status: accepted, 2026-11-25 (platform work, `feat/public-rate-limit`). Amends
[ADR 0415](0415-the-http-surface-as-built.md) ("public calls are not limited by the host") and
[ADR 0421](0421-the-client-app-binding-and-customer-sign-in.md) (what a bound Worker is trusted to say). Builds on
[ADR 0091](0091-rate-limiting-binding.md) (the Workers Rate Limiting
binding), [ADR 0402](0402-staff-and-customers.md) (audiences) and
[ADR 0722](0722-abuse-checks-turnstile-honeypot-fill-time-caps.md) (the intake caps, which stay).

## Context
Four reviews found the same gap: a caller with no account can call any operation open to `public`
as fast as the Worker and D1 allow. The host limited sign-in per client address and a signed-in
customer per account and operation; for the public it pointed at a Cloudflare edge rule that a
deployment has to add by hand, that a `workers.dev` host cannot have, and that never sees calls a
client app's web site makes over its service binding (they all come from the web app, and the
visitor's address was not passed on). Promo codes (stage 34) cannot ship to a guessable public
door like that (ADR 0693).

## Decision
**The pipeline limits every call from outside the org to an operation open to `public`, per client
address**, before the input is parsed or any work is done (`packages/core/src/public-limits.ts`,
called from `invokeOutside` beside the per-account check). A customer or a practitioner calling such
an operation is counted per address too, and keeps the per-account limit. An enrolled device is
not (it is limited per device, ADR 0781, and the desk origin per address).

- **The store is the Workers Rate Limiting binding**, as for sign-in, MCP and the feeds: no D1
  statement, no write per call, one in-memory count at the Cloudflare location. Its windows are
  fixed (60 seconds) and its counts approximate, which is right for floods. Four bindings, one per
  tier, in `apps/app/wrangler.jsonc` and `apps/runner/wrangler.jsonc` (same namespaces, so the two
  Workers share counts):

  | Tier | Binding | Limit | Key |
  | --- | --- | --- | --- |
  | `standard` | `PUBLIC_RATE_LIMIT` | 120 a minute | address and operation |
  | `low` | `PUBLIC_WRITE_RATE_LIMIT` | 30 a minute | address and operation |
  | `strict` | `PUBLIC_STRICT_RATE_LIMIT` | 10 a minute | address and group |
  | (no address) | `PUBLIC_SHARED_RATE_LIMIT` | 1,200 a minute | the client app and group |

- **Every operation open to `public` has a limit**: its own `publicLimit` declaration, or the
  default for its risk class (`read`: `standard`; `write`: `low`). A test walks the registry,
  shipped packs' tools included, and fails when one has none or when a named operation lost its
  declared one. Declared, tighter:

  | Operations | Tier, group |
  | --- | --- |
  | `order.start`, `order.startHeld` | `strict`, one group `order.start` |
  | `contact.stop` | `strict` |
  | `intake.submit` | `strict` (beside its caps, ADR 0722) |
  | `discount.check`, `order.applyCode` | `strict`, one group `code`, and wrong guesses counted |
  | `order.quote`, `intake.open` | `low` |

- **A `strict` operation is counted wherever it is called**: at the door, and inside a pack's tool
  (the runner applies it to the tool's own calls with the caller's address, which the host hands
  the run). Other tiers count the outside call once, at the door, as today: a tool's own reads are
  part of the call that started it.
- **Wrong guesses** (`packages/core/src/guesses.ts`): an operation that checks a code reads, before
  it checks, how many wrong codes this address gave in the current hour, and refuses at 20; a wrong
  code adds one. The binding cannot be read without counting, and a guess limit that counts only
  wrong ones must refuse the right code too once it is reached, or it tells the guesser which one
  was right. So the count is a D1 row: one indexed read per code check, one upsert per wrong code
  (the honest buyer rarely pays it). The 21st try in the hour from that address is refused, right
  or wrong; another address is not affected.
- **The address.** On the public HTTP surface it is the connection's, `cf-connecting-ip`, which
  Cloudflare sets and a client cannot; any `cos-visitor-address` header there is ignored. Over the
  client-app binding (`ClientApp`) the bound Worker passes its visitor's in `cos-visitor-address`
  (the typed client's `visitorAddress`, used by every route in the template's `src/host.ts`), and
  only there is it read. A bound Worker that passes none (an older template) is counted in one
  shared bucket for the client app (`PUBLIC_SHARED_RATE_LIMIT`, and 200 wrong guesses an hour):
  never unlimited, and its visitors share it until it is updated.
- **What is kept.** An IPv6 address is limited by its /64. The adapter turns the address into a
  key at once, a SHA-256 keyed with the host's sign-in secret (`addressKey`), and the pipeline sees
  only that key. The binding holds it for its minute. A wrong-guess row holds a second hash, of the
  key with the hour and the group, so rows of different hours cannot be joined; it is deleted by
  the daily maintenance run once its hour has ended (it lives at most about 25 hours). No address
  or key is written to the audit log, an event or a reply.
- **The refusal** is `rate_limited` (HTTP 429, `Retry-After`) with the standard error shape and the
  same message whether or not the thing asked about exists. It is decided before the handler runs
  (a wrong-guess refusal, before the code is looked at), so a refused call changes nothing, is not
  queued for review, and writes no audit row.
- **When the store is down** (the binding throws, or is missing from a misconfigured deploy): a
  read on the `standard` or `low` tier is allowed (logged once); every write, and every `strict`
  operation, is refused with "try again shortly". Code guessing and order starts are never
  unlimited. The wrong-guess count is in D1, which the call needs anyway.
- **Sign-in codes**: the per-address count of code requests and sign-in attempts is one count for
  the address across staff, customer and practitioner sign-in (it was one count per kind, each keyed
  with its own secret), and over the binding it uses the visitor's address.
- **Who may change it.** The limits are code and deploy configuration: no setting, operation or
  record loosens them, so no AI can. A human changes a binding's `simple.limit` in
  `wrangler.jsonc` and redeploys (`docs/deploying.md`, Rate limits).

## Decided here, open to the owner's override
- The numbers: 120, 30 and 10 a minute; 1,200 a minute shared; 20 wrong codes an hour per address
  (200 for the shared bucket). A shop's checkout makes a quote on each basket change and one start;
  a person types a code a few times.
- Reads stay open when the binding is down; writes and strict operations close.
- The Cloudflare edge rule (`docs/deploying.md`) is no longer required. It is still worth adding
  for volume, since it stops floods before they reach the Worker.

## Considered
- **A D1 counter for every call**: exact and with any window, but a primary write on every public
  read, contending on D1's one writer. Used only for wrong guesses, where the read-before-check is
  the point and the write is the attacker's.
- **A Durable Object per address**: exact and global, but a round trip and a request's cost per call.
- **Trusting `cf-connecting-ip` over the binding**: it is the template's word either way; a header of
  the platform's own name says what it is, and the public surface can ignore it by name.

## Consequences
- A deployment no longer needs the edge rule to be safe from one patient script; a botnet of many
  addresses is still the edge's (or Turnstile's) to stop.
- Counts are per Cloudflare location and approximate: a client reaching several locations gets
  roughly the limit in each. The wrong-guess count is exact.
- Nothing here has run on real Cloudflare: the bindings are tested with Miniflare's and the tests'
  in-memory stand-ins.
