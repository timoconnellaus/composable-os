# ADR 0792: `sellable.finance`: what kind of sale a thing is, and how it is earned

Status: accepted, 2026-11-24 (stage 52, build step 2). Extends
[ADR 0435](0435-sellable-what-may-be-bought-and-what-a-paid-line-grants.md) (`sellable`). Stage
52's spec, "The design in one page" and "Platform work and pack work". The spec's ADR table named
this decision 0793; the coordinator gave this step 0792, so the payout reads (step 4) take 0793.

## Context
Stage 52's finance reports count sales by kind of sale (memberships, passes, drop-ins, tickets,
courses, goods) and show beside them what is not yet earned. The reports are core: orders,
payments and refunds are the host's. But which kind of sale a ticket type or a pass type is, and
when its money is earned, is the pack's knowledge: the host knows only that an object is
`sellable`. The host must not guess it from an object's name, and a pack must not compute it
(a pack composes behaviours and hooks no write).

## Decision
**A sellable object may declare `finance`** (`FinanceSpec`, `packages/sdk/src/sellable.ts`):
- `category: { key, label }`: the kind of sale its order lines are counted under in Sales, Tax,
  Refunds and the book entries' `sales:<key>` and `refunds:<key>` headings (ADR 0791). The key is
  stable (lower case letters, digits and `_`, up to 40); the label is what the reports call it
  until an admin renames it in the finance settings. Objects with the same key are one category.
- `earned`: when its money is earned, for the Unearned report only (the entries count cash as it
  moved, whatever this says):
  - `at_sale`: when it is paid;
  - `over_period`: day by day over the order's period (`core_order.period_start` to `period_end`,
    ADR 0486), so only on a plan (`recurring`);
  - `per_use`: as the uses of what a paid line grants are spent, the rest at its expiry (stage
    52, decision 4), so only when `grants` grants an object that holds uses (`allowance.holds`);
  - `at_date`: on the date `at` names, a date or datetime field of the object or a path through
    up to two relations (`event.startsAt`), read as `sellable.moves`' paths are.
- Left out, or any part left out: category `other` ("Other") and `at_sale`.

It labels; it does nothing else. It prices nothing, grants nothing, moves no money and adds no
operation, no audience and no write. It is additive and optional, so the contract version does
not change. Which way the books treat a sale stays the business's accountant's call; the reports
say so.

**The checks** (`checkFinance`, run by `extension.check` and `cos ext check`): `at_date` names
`at`, and `at` resolves to a single date or datetime field; `at` is only for `at_date`;
`over_period` only on a plan; `per_use` only when the grant holds uses; and one key has one label
across the extension. Two extensions may share a key (a shop's goods and another pack's might);
no manifest check can see that, so which label the reports show until an admin renames it in the
finance settings is the reports' (step 3) to settle.

**The host's copy.** The field registry carries it on `ObjectDefinition.sellable.finance` with
the defaults filled (`sellableFinance`), so every reader of a sellable object gets one answer and
no reader applies defaults of its own. An installed extension adds or changes it by an ordinary
upgrade: nothing is stored on orders, so a renamed category or a changed way of earning applies to
every open period's report, and a closed period keeps what it was closed with (ADR 0790).

**Runtime extensions.** The spec allows a runtime extension to declare it, since it only labels
its own sales. A runtime extension may not declare `sellable` at all (ADR 0435), so in practice
only a shipped pack or the org's own extension does. Nothing more was opened.

**What the packs declare:**

| Object | Category | Earned |
| --- | --- | --- |
| `memberships.plan` | `memberships`, Memberships | `over_period` |
| `memberships.passtype` | `passes`, Class passes | `per_use` |
| `ticketing.tickettype` | `tickets`, Tickets | `at_date`, `event.startsAt` |
| `bookings.booking` (a drop-in) | `drop_ins`, Drop-ins | `at_date`, `class.startsAt` |
| `courses.course`, `courses.bundle` | `courses`, Courses | `at_sale` |
| `courses.plan` | `courses`, Courses | `over_period` |

A course plan is a monthly subscription to every course: it is counted as Courses, as its courses
are, and earned over its paid month as any plan is (the spec's "Courses: `at_sale`" is for a course
bought outright). Shop items declare `at_sale` when stage 37 builds them.

**Stored value.** A line whose object issues stored value or a voucher (stage 34, not built) is
held for customers, not a sale, whatever it declares. Stage 34's gift card type will not need to
declare `finance`; the finance reports read stored value from its own tables.

## Consequences
- The finance reports (stage 52 steps 3 and 5) read one declaration per sellable object and need
  no knowledge of any pack.
- A business sees its own words for a kind of sale by renaming the label in the finance settings,
  not by editing a pack.
- A wrong `earned` only changes the Unearned report, which is flagged for the accountant; the
  money counted is the same either way.
