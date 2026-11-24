# ADR 0672: The text gatekeeper: the provider as a swappable connector on the business's own account, queue classes, the pending pool, STOP, START and HELP, the monthly limit

Status: accepted, 2026-11-24 (stage 30, build step 3: `feat/stage-30-text`, block BB: migration
0911). Builds on ADRs [0670](0670-routine-messages-text-and-push-on-the-routine-mail-path.md)
(routine messages, a row per channel), [0590](0590-routine-mail.md) (routine mail),
[0645](0645-the-copy-and-the-signed-pdf-host-mail-and-a-second-attachment.md) (queue classes and
pending pools), [0429](0429-payments-gatekeeper-verified-events-and-refunds.md) and
[0485](0485-recurring-billing-the-provider-runs-the-schedule.md) (the payments gatekeeper's provider
interface, its fake and its verified events), [0452](0452-gatekeeper-settings-in-product-ts.md)
(gatekeeper settings and secrets) and [0676](0676-quiet-hours-and-urgent-messages.md) (quiet hours).
Which number is textable is ADR [0673](0673-which-number-is-textable.md). The stage's decisions 1
to 3 (`docs/stages/30-notifications.md`).

## Context

Step 1 made a routine message a row per recipient and channel and kept every text row
`no_channel`: nothing could send one. A text costs the business money per segment, reaches a
phone that buzzes, and is personal data in transit. Decision 1: each business pays its own text
provider account, as with card payments; we never resell texts. So the provider must be a
connector behind one interface, swappable without host code, with its keys out of the host. A
text has no free path in this stage: only the host's routine messages (and a member's checking
code) send one, and a person or an AI cannot. Every message must end in a status, and the month's
spend must never pass the limit a person set, even with two runs claiming at once.

## Decision

**A gatekeeper of our own, `packages/gatekeeper-text`, shaped as the payments one.**

- **One provider interface** (`TextProvider`: `send`, `startCheck`, `check`, `verifyWebhook`,
  `src/provider.ts`) and a registry of provider modules (`TEXT_PROVIDERS`). The deployment picks one
  by a setting in `product.ts` (`text.TEXT_PROVIDER`), with the business's sender number
  (`TEXT_SENDER_NUMBER`); the provider's keys are the Worker's secrets, set by a person, never
  readable back, never in the host or `product.ts`. A second provider is a second module and one
  setting: a test runs a second fake, with its own wire format, behind the same interface and gets
  the same provider-neutral results.
- **The fake** (`src/fake.ts`) sends nothing anywhere: a ledger keeps what was "sent" and the
  checking codes, and its webhook takes receipts and replies signed with its own secret. As the
  payments fake, it runs off localhost only with `FAKE_WEBHOOK_SECRET` (which `cos deploy` generates
  for an environment marked `live: false`), and `product.ts` and `cos deploy` refuse
  `TEXT_PROVIDER: "fake"` in a live environment. `FakeTextControl` lets tests and local development
  read the fake's phones; nothing in a deployment binds it.
- **One resource**, the sender number (`text://sender`), auto-provisioned, an org connection
  (vendor `text`). The host uses the oldest active org text connection with the sender bound.

**Who may use it: the host's own queues only, each for its own purpose**, read from the queue the
integration host opened (`hostPurpose`), never from the message, as the email gatekeeper's queue
classes:

| Queue | Purpose | What it may do |
| --- | --- | --- |
| `routine` | `routine-mail` | `send` one text row's own words |
| `check` | `phone-check` | `startCheck` and `check` a member's own number (ADR 0673) |
| `events` | `text-events` | `subscribe` the host's hook for receipts and replies |

Every other caller (a person, MCP, the assistant, extension code, an automation's own call, Code
Mode, and the host's other purposes) is **refused, not reviewed**: there is no free path to review.
A test per caller class.

**Kinds.** A text from the routine queue is `text.routine` when the host decided its row routine
(`hostRoutineMail` answers) **and** it has routine shape: one number in international form, plain
words of at most two segments, beginning with the business's name, and every link (a scheme or a
bare domain) on the business's site. The gate applies it by the host's decision, as `email.routine`
(`ROUTINE_MAIL_KINDS`); it is not auto-approvable. Anything else from that queue, a held row's text
included, is `text.send`, which a person reviews in Approvals with the words and the number partly
masked (`+614•••••123`); approving it sends it, and marks what it showed a person's (ADR 0590).

**The pending pool.** At most 500 texts wait for a decision at the gatekeeper. A full pool refuses
the send; the host puts its row back as it was (`ready`, or `held`), gives back its reserved spend,
and the next minute tries again: back-pressure, never a drop. Idempotency keys are the host's
`routine:<row id>`, remembered per class: a retry answers the same send.

**Receipts and replies are verified events.** The provider's webhook (`/gatekeeper/text/in/<provider>`,
bypassing Access, its signature checked before anything is read) lands in one `TextEvents` Durable
Object: it dedupes the provider's event ids, maps the provider's reference back to the host's key
(so a receipt names its row), and delivers each event to the host's hook through the kit's delivery
queue, retried from its alarm.

- A receipt settles the row `delivered` (with `delivered_at` and the provider's reference) or
  `failed`, and adds what the provider charged to the month's reported spend.
- **STOP** (and the usual synonyms) stops every text to that number from the business, whatever its
  purpose: the gatekeeper keeps a SHA-256 of the number and refuses a text to it even if the host
  asks; the host keeps a salted hash in `core_text_stop`, so the next text is `stopped` at prepare
  or at claim, on any Person the number is on, and survives an erase. **START** lifts both.
- **HELP** gets a fixed answer with the business's name (the name the host's last text began with),
  at most once a day per number, sent by the gatekeeper itself; its segments reach the host and
  count in the month's spend.
- Any other reply is not read further, not stored and not passed on (stage 36 adds a receiver).

**The monthly limit, counted at claim.** A human admin sets the month's limit (`textLimitMinor`,
minor units of the business's currency; 0, the default, sends none), the price of one segment as
the provider lists it (`textSegmentPriceMinor`; no text goes until it is set) and the countries
texts may go to (`textCountries`). `claimRoutineText` (`packages/core/src/routine-mail/texts.ts`)
decides a row again first (its kind and text still on, its moment not passed, its number not
stopped), then reserves its estimated cost (segments × price) in **one statement** on
`core_text_spend` that refuses to pass the limit (`estimated_minor + cost <= limit`), so two runs
claiming at once cannot pass it; over it the row is `over_limit` (its email went when it was
prepared) and admins are told once that day; at or past 80%, once that month. Then the row is
claimed within its number's day: five texts, counted in the claiming statement; over it, the text
is held for a person, as an email over its cap. A checking code reserves one segment the same way.
The month is the business's (quiet hours' zone). A text not handed over, or denied by the floor,
gives its reservation back; one that failed at the provider keeps it (the estimate stays on the
safe side).

**Sending.** A text row goes right after its message is prepared (a pack's automation or a host
kind), and the runner's minute cron hands over every text that may go now (`sendReadyTexts`: ready
ones, held ones not yet put to a person, released ones at the end of quiet hours), at most 50 a
minute, through the integration host's `sendRoutineText`, which claims the row, opens the routine
queue for it and settles it. An idle minute reads one partial index (`core_routine_mail_texts_idx`).

## Consequences

- A text can only be the host's: there is no operation, tool or session call by which a person or
  an AI sends one. The shared inbox (stage 36) adds a person's reviewed text.
- Texts reach members only once the consent register lands (stage 30 step 5): a member must be
  able to stop them in their account. STOP by text works now.
- The real provider module is not in this release: it is written with the first business's own
  account (step 8). Until then a deployment can run the fake only, and only where `live: false`.
- HELP's answer is sent by the gatekeeper without an approval action: it is a fixed text to the
  number that asked, once a day. A checking code is not an action either: the provider makes and
  sends it, the host never sees it, and it is capped per number at the gatekeeper and per Person and
  number at the host.
- The suppression list of stage 30's consent register (step 5) reads `core_text_stop` for texts;
  the spec drew one table for every channel (`core_contact_suppression`, migration 0913). Built
  here first because STOP had to work in this step.
- A held text a person approves during quiet hours goes when approved; a held one is put to a
  person only once its quiet hours are over.

## Amendment, 2026-11-24 (the review of PR #435)

- **The claim takes the row first, then the spend.** Two claims of one row near the limit sent
  nothing and marked it `over_limit`; now one claim wins the row and only it reserves the cost.
- **A limit of 0 is texts off**: a row is `off`, and admins are not told the limit was reached.
- **A text left `sending`** by a host that stopped before it settled it is claimed again after 15
  minutes, with the spend it already reserved; the gatekeeper's key answers it with what the first
  try made. When that answer is an earlier try still waiting for a person, the host records that
  try's pending approval; one turned down since is `failed`. Either way its words and number are
  cleared.
- **A text the gatekeeper refuses** (its shape, a STOP) is `failed`, its spend given back, and not
  tried again every minute; only a full pool or a failure on the way puts it back.
- **The gatekeeper's hashes are salted**: the stops, HELP's once a day and the per-number code
  count use a salt the `TextEvents` object makes once for the deployment, never a bare SHA-256.
- **Events are never lost for want of a hook**: a STOP (or any event) that arrives while no host
  hook is bound is kept (at most 1,000) and delivered once one is.
