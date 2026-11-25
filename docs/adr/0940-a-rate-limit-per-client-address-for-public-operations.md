# ADR 0940: Rate limits for public operations: per address for floods, per caller where it counts

Status: accepted, 2026-11-25 (platform work, `feat/public-rate-limit`; reworked the same day after
the review of PR #459). Amends [ADR 0415](0415-the-http-surface-as-built.md) ("public calls are not
limited by the host") and [ADR 0421](0421-the-client-app-binding-and-customer-sign-in.md) (what a
bound Worker is trusted to say). Builds on [ADR 0091](0091-rate-limiting-binding.md) (the Workers
Rate Limiting binding, and its fail-open), [ADR 0402](0402-staff-and-customers.md) (audiences) and
[ADR 0722](0722-abuse-checks-turnstile-honeypot-fill-time-caps.md) (the intake caps, which stay).

## Context
A caller with no account could call any operation open to `public` as fast as the Worker and D1
allow. The host limited sign-in per client address and a signed-in customer per account; for the
public it pointed at a Cloudflare edge rule a deployment has to add by hand, that a `workers.dev`
host cannot have, and that never sees calls a client app's web site makes over its service binding
(the visitor's address was not passed on). Promo codes (stage 34) could not ship to a guessable
door like that (ADR 0693). A per-address limit alone is wrong too: many people share one address
(a venue's wifi at an on-sale, a gym's network, a carrier's NAT, a campus).

## Decision
**One choke point.** The pipeline (`invokeOutside`, `packages/core/src/public-limits.ts`) counts
every call from outside the org (a customer, a practitioner or the public; never an enrolled
device, which is limited per device) to an operation open to `public`, before the input is parsed
or any work is done. The adapters that build such a context (`outsideContext` in
`apps/app/src/server/http/api.ts`, used by the HTTP surface, the binding and the desk; the runner's
outside path for a pack tool's calls) all pass the limiter and the caller's address; a test fails
when a new file builds one, or a builder stops passing them (`apps/app/test/outside-contexts.test.ts`).

**The store is the Workers Rate Limiting binding**: no D1 statement, one in-memory count per
Cloudflare location, windows of 60 seconds (the binding allows 10 or 60). Counts are approximate,
which is right for floods.

**Per client address: floods only, set high.** Counted once per outside call, at the door, per
address (an IPv6 address by its /64, an IPv4-mapped one by its IPv4 address) and operation:

| Tier | Binding | Per address a minute | Operations |
| --- | --- | --- | --- |
| `read` | `PUBLIC_RATE_LIMIT` | 600 | every public read (the default) |
| `write` | `PUBLIC_WRITE_RATE_LIMIT` | 120 | every public write (the default) |
| `asset` | `PUBLIC_ASSET_RATE_LIMIT` | 1,200 | `media.serve`, `media.play` |
| shared | `PUBLIC_SHARED_RATE_LIMIT` | 6,000 per client app | a bound Worker that names no visitor |

**Per caller: the tight limits** (`perCaller`, `PUBLIC_CALLER_RATE_LIMIT`, 10 a minute per caller
and group), at the door and inside a pack's tool (cos-runner binds it in the same namespace):

| Operations (group) | A signed-in caller | A guest |
| --- | --- | --- |
| `order.start`, `order.startHeld` (`order.start`) | the account | nothing identifies them: a new order has no token yet. Per address only |
| `order.checkout` | the account | the order (`id`; its token is checked by the handler) |
| `subscription.start` | the account | nothing: per address only |
| `discount.check`, `order.applyCode` (`code`) | the account | `applyCode`: the order (`id`); `discount.check`: nothing, per address only |
| `intake.submit` | the account | the personal link (`link`) when given; else nothing, per address only, beside the caps per deployment and per form (ADR 0722) |

No guest has a session on this platform: a guest is identified only by an order or a personal link
their call names. A practitioner is counted by their account, as a customer is.

**`contact.stop` is not counted per call.** One-click unsubscribes (RFC 8058) come from a mail
provider's few servers, so a newsletter's stops pass any per-address limit at once. Only tokens
that are not valid count against the address, at the flood level (`addressCounts: "invalid"`); a
valid token always stops. The template's stop route reports "done" only when the host said yes;
otherwise the page shows an error and keeps its button, and a one-click POST gets the host's status.

**Wrong promo codes** (`packages/core/src/guesses.ts`, `core_wrong_guess`, migration 1450), in D1
because the binding cannot be read without counting:
- Counted per caller: an account (20); a guest's order (20); a guest naming no order, per address
  (50, a higher ceiling for the shared case). In fixed quarter-hour windows; the 21st (51st) locks
  that account, order or address out of codes for 15 minutes from then, right or wrong, so the
  refusals never tell which code was right. A shared bucket is never locked.
- A check reserves its guess before the code is looked up, in one statement (`wrong = wrong + 1 ...
  RETURNING`), so parallel guesses cannot overshoot; a right code gives it back. One write per code
  check, a second per wrong code.
- Host-wide backstop: 2,000 wrong codes in an hour (many addresses at once) and code checks for
  everyone pass a host-wide 30 every 10 seconds (`PUBLIC_CODE_SURGE_RATE_LIMIT`) until the hour
  ends: valid codes still work, slower; the admins are told once.
- A wrong code to `order.start`, `order.startHeld` or `order.quote` counts too. Staff are not
  counted. A call priced again after a race on an automatic discount (ADR 0693) is not counted
  twice.

**When the limiter is unavailable** (a binding missing from a deploy, or failing), calls go through,
for every tier (ADR 0091's fail-open): a deploy that left a binding out must not take checkout down.
Every such call is logged with `console.error` (at most once a minute per isolate), the admins get a
notice once a day while it lasts, and the status page's "Rate limits" line names missing bindings and
the last day a count could not be made. The wrong-code counts are D1's and hold in that state.

**The address.**
- On the public HTTP surface: the connection's, `cf-connecting-ip`, which Cloudflare sets and a
  client cannot. `cos-visitor-address` is never read there.
- Over the client-app binding: a forwarded `cf-connecting-ip` first (Cloudflare's edge sets it on
  the browser's request; a browser cannot, so a Worker that forwards the browser's request headers
  as they came still names the real visitor), then `cos-visitor-address`, which the typed client's
  `visitorAddress`/`forVisitor` set from `cf-connecting-ip` and which every route of the template's
  `src/host.ts` sends. A bound Worker must never pass on a `cos-visitor-address` the browser sent.
- A malformed or over-long value is no address. A bound Worker naming none is one shared bucket for
  the client app, at the shared flood level, never locked out of codes; the admins are told once a
  day, with the fix (`forVisitor`).
- Every server-to-server caller of the public surface (a Worker in another account) shares
  Cloudflare's address for it, so one bucket. Cloudflare's "Pseudo IPv4: overwrite headers" must be
  left off: it gives each IPv6 address its own IPv4 address and so defeats the /64.

**What is kept.** The adapter turns an address into a key at once: an HMAC-SHA256 of its bucket
under `clientAddressSecret` (derived from `BETTER_AUTH_SECRET`, else `CUSTOMER_AUTH_SECRET`; a host
with neither gets a random key per isolate, logged, never an empty one). The pipeline sees only the
key. A wrong-code row holds a SHA-256 of who (the key or an account id), the order and the group;
the daily maintenance run deletes rows whose window and lock have passed, looping until none is
left (so a row lives at most about a day). No address or key reaches the audit log, an event or a
reply.

**The refusal** is `rate_limited` (HTTP 429, `Retry-After`) with the standard error shape, the same
whatever the call asked about. The per-address and per-caller counts come before the handler, so
a refused call changes nothing, is not queued for review, and writes no audit row.

**Sign-in.** Code requests and sign-in attempts are one count per address across staff, customer
and practitioner sign-in (`CUSTOMER_CODE_ADDRESS_RATE_LIMIT`, 60 a minute, which a gym's own network
does not reach); the per-mailbox limit does the real work. Over the binding they use the visitor's
address as above.

**Every operation open to `public` has a limit**: its `publicLimit`, or its risk class's default
(read: `read`, write: `write`). A registry walk over core and every shipped pack's tools fails when
one has none or a declared one changed; `open-operations.json` lists each (`perAddress`).

**Who may change it.** The limits are code and deploy configuration: no setting, operation or
record loosens them, so no AI can. A human changes a binding's `simple.limit` in `wrangler.jsonc`
and redeploys (`docs/deploying.md`, Rate limits).

**Promo codes** (amending [ADR 0693](0693-the-discount-behaviour-codes-automatic-prices-one-deal-limits-held-by-the-database.md),
whose gate on shipped packs declaring `discount` is lifted): a code word is kept folded (`foldCode`
in the SDK: NFKC, no white space and no invisible characters such as zero-width spaces or soft
hyphens, upper case, so non-ASCII letters match), at least 6 characters, and unique among the live
records of its own object, by a unique index the reconciler keeps on the column; a guess is looked
up by that index. Before the index is built on an object that has records, the reconciler folds
their words in place and refuses, naming the records, two that fold to one word. A word is unique
within its object only: the same word on one discount's own `code` and on another discount's code
record is still two matches (the better deal is taken). `randomCodes` (SDK) makes single-use codes
of 16 characters from `crypto.getRandomValues` in an alphabet with no 0, 1, I or O (80 bits).

## Decided here, open to the owner's override
- The numbers: 600 reads, 120 writes and 1,200 asset reads a minute per address; 6,000 a minute for a
  client app's shared bucket; 10 a minute per caller; 20 wrong codes per account or order and 50 per
  address in a quarter-hour, a 15-minute lock; 2,000 wrong codes an hour host-wide, then 30 code
  checks every 10 seconds; 60 sign-in code requests a minute per address; a code word of at least 6
  characters; 16 characters for a generated code.
- Calls go through when the limiter is unavailable, for every tier (reported, not refused).
- Fixed quarter-hour windows for counting wrong codes, the lock 15 minutes from the moment of the
  one over.
- A code word is stored in upper case (as folded), not as typed: staff see `JANUARY` for `january`.
- Inside a pack's tool, only per-caller counts are made (the tool's door call was counted per
  address).
- The Cloudflare edge rule is no longer required; it is still worth adding for volume.

## Considered
- **Tight limits per address** (the first version of this ADR): locks out everyone behind one
  address; replaced by per-caller limits and high per-address ones.
- **A D1 counter for every call**: exact and with any window, but a write on every public read.
  Used only for wrong codes, where the read before the check is the point.
- **A Durable Object per address**: exact and global, but a round trip and a request's cost per call.
- **Failing closed when the limiter is unavailable**: a missing binding would turn every checkout
  into "try again shortly" with nobody told; ADR 0091 fails open everywhere else.

## Consequences
- A client app built from an older template, or adopted before this, must send `forVisitor` (the
  template's `src/host.ts`; `cos upgrade` replaces an unedited one) before a host release carrying
  this, or its visitors share one bucket.
- A botnet of many addresses is bounded by the host-wide wrong-code ceiling and the per-address
  flood limits, not stopped; the edge (or Turnstile) is for that.
- Counts in the binding are per Cloudflare location and approximate; the wrong-code counts are exact.
- Nothing here has run on real Cloudflare: the bindings are tested with Miniflare's and the tests'
  in-memory stand-ins. Local development and the e2e suite present `127.0.0.1` (or `::1`), which
  Miniflare sets when a request has no `cf-connecting-ip`.
