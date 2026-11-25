# ADR 0711: Needs your attention: `me.attention`, its eight kinds and the days setting

Status: accepted, 2026-11-24 (stage 48, build step 4; interview decisions 2, 3 and 8). Builds on
ADRs [0402](0402-staff-and-customers.md), [0413](0413-outside-handlers-have-no-raw-database.md),
[0487](0487-the-payer-and-the-holder.md), [0493](0493-the-allowance-behaviour.md),
[0540](0540-the-family-link.md) and [0642](0642-acceptances-a-record-nobody-changes-and-who-may-agree-for-whom.md).

## Context

My account (stage 48) opens with "Needs your attention": what a member, or a child they act for,
has to do now. Before this step only agreements had a host answer (`me.agreements.due`). A failing
card, a payment waiting at the bank, a deposit's balance, an unpaid held order and a pass running
out were each in a different read, and a client working them out from `my.list` calls would put
rules in the client (ADR 0401) and give each app its own cut-offs.

## Decision

- **One customer read, `me.attention`, worked out in core** (`packages/core/src/customers/attention.ts`)
  from core records and behaviours only: agreements, orders, subscriptions and the `allowance`
  behaviour. No pack code runs and no client names a pack. A pack's records reach the list only
  through the behaviours it declares (a pass is any holder of `allowance` with a fixed number of
  uses in all). Open to customers only, `hostInternal` (it reads the host's own subscription,
  order, acceptance and allowance rows for the caller from the principal, never from input),
  read-only, outside MCP and the assistant.
- **Eight kinds, a fixed vocabulary in core** (decision 2):

  | Kind | From | Shown until |
  | --- | --- | --- |
  | `agree` | what `me.agreements.due` answers, for the caller and each live dependant | accepted |
  | `card_failing` | a subscription they pay in `past_due` or `unpaid`, or with `failing_since` | paid or ended |
  | `confirm_payment` | a subscription they pay in `incomplete` | confirmed or ended |
  | `balance_due` | an order of theirs `part_paid` with `balance_due_at` | paid or cancelled |
  | `finish_paying` | an order of theirs `pending`, holding places (a held claim), not yet expired | paid, cancelled or expired |
  | `pass_expiring` | a live holder of N uses in all, theirs or a dependant's, ending within the days, with uses left | lapsed, used up or its end moved |
  | `pass_used_up` | the same kind of holder with no uses left and still valid | lapsed, or a newer holder of the same object with uses left |
  | `trial_ending` | a subscription they pay, `trialing`, whose trial ends within the days and is not set to end | the trial ended or it was cancelled |

  A subscription item is the payer's (ADR 0487); a pass item is its holder's and their live
  guardians'. A membership's per-period limit used up renews by itself and is never
  `pass_used_up`. A subscription the member set to end is not listed for its ending. A child's
  orders stay the child's.
- **An item** carries its kind, whose it is (the caller, or a live dependant by name), the record
  (`agreement`, `subscription`, `order` or the holder's object, its id and a title: the document's,
  the plan's as it was sold, the order's first line, the holder's title field
  read through the seam), the moment it is about (`at`), an amount in minor units with its
  currency where there is money, uses left for a pass, and a stable `key`. Items come soonest
  first; one with no moment last.
- **A dependant's pass only where the object opens to guardians.** Candidate holders are read for
  the caller and their live dependants, then read back through the seam in one statement for
  every holder object (a `UNION ALL` of each object's `visibleSource`), which shows a child's only
  where the object's `customer.guardians` opts in.
- **A pass is listed only where its customer reads what the item says** (the review of PR #359):
  the object's customer field is the holder's Person, and `customer.read` lists its uses field and
  its end field (when it has one). Otherwise none of its passes is listed, so `usesLeft` and `at`
  never tell a member what their own record hides.
- **Agreements as `me.agreements.due` answers them**: the same documents, the same counting
  acceptance, and like it a version whose stored text does not match its hash is never listed.
- **"A newer holder"** is one made after it: ids sort by when they were made (ADR 0015), so a pass
  bought after one was used up takes over from it without a new column.
- **The days setting**: `account.attentionDays`, stored as `account_attention_days` and set
  through `customer.settings.update` as `attentionDays` (the customer account settings, beside the
  erase due days): default 7 (decision 3), 1 to 30, `settings:manage` and human actors only, the
  change audited. It applies to a pass expiring and a trial ending.
- **Bounded**: a fixed number of statements whatever the packs installed, the size of the family
  and the number of documents: the setting, the family, two for the documents, one for the
  caller's agreement facts (a live dependant from the seam's family is a minor out of the Trash,
  with nothing more to read), one for the family's acceptances (the dependants as a subquery,
  never a list of ids), one for the versions in effect, one for subscriptions, three for orders
  (the open ones through the seam, their held places, their first lines), one for holders and one
  through the seam for the passes listed. No statement binds a list of the family or the
  documents; the orders and passes read at most 50 ids each. Tests hold it: the same count after
  another pack is installed, with passes listed in two packs as in one, and for a family of 30 as
  for a family of one.
- **Orders through the seam**: the open orders and their first lines are read with
  `ctx.records.list` on `order` and `orderLine`, so a customer's own only, as `my.list` answers
  them; subscriptions, acceptances and allowance counters are host rows read for the principal.

## Consequences

- Later core primitives add kinds here (`invoice_due`, `quote_waiting`, `message_unread`,
  `form_to_fill`, a visit to confirm); the enum grows and old clients show an unknown kind as
  they choose. A pack never adds a kind except by declaring a behaviour core reads.
- The attention block (stage 48 step 7) renders the answer and links each kind to the section or
  page that fixes it; this step ships no block.
- A subscription in `past_due` whose renewal waits for the bank (an `action_url`) is
  `card_failing`, as the spec's table says; the block can send the payer to the subscription's
  page from there.
- Not yet tried on a live host.

## Amended 2026-11-25, `form_to_fill` (stage 29 step 5, ADR 0723)

The kind the spec named for later is built: a live personal link of the caller's, or of a live
dependant's, whose form still takes answers by link, soonest to expire first and at most ten. Its
record is the form (by its published title), its moment the link's expiry, and its new `link` field
the link's id, which the app sends back as `linkId` to open and answer the form; every other kind's
`link` is null. It reads one statement for the links and two for each one listed.
