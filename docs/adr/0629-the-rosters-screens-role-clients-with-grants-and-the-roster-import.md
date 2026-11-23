# ADR 0629: The roster's screens, role clients with grants, and the roster import

Status: accepted, 2026-11-24 (stage 45, build step 7). Builds on ADRs
[0418](0418-the-typed-client-as-built.md), [0424](0424-blocks-as-built.md),
[0451](0451-role-clients-staff-in-the-mobile-app-and-browser-calls.md),
[0453](0453-pack-hooks-over-the-clients-operations.md), [0470](0470-the-import-door.md),
[0600](0600-a-pack-role-and-its-grants-add-up.md) and [0620](0620-field-level-exceptions-in-recurring.md)
to [0627](0627-pay-periods-the-basis-the-totals-the-lock-and-the-export.md). Amends ADR 0451 (a role's
client may carry grants). ADR 0628 is the calendar feed's (step 5), whose screen is built here.

## Context
Steps 1 to 6 built the roster's rules in the host and the Rostering pack's tools. Step 7 is the
screens (the week grid, assign, patterns, qualifications, everyone's time off and pay on the web; my
shifts, offers, my availability and the roster on the web and in the app) and the move of duties
(`cos rostering import`). Building them showed what a screen needed that no tool answered:

- **What the viewer may do.** A member holds every pack tool that is not restricted, so a client
  holding the rosterers' hooks says nothing about whether the viewer rosters; and pay is a person's
  only. A screen deciding that itself would be a permission check in a block (ADR 0424).
- **Who could be put on a shift**, eligible first and the rest with their warnings: `check` answers
  one person at a time, and a pack cannot list staff accounts.
- **The people and the kinds of work** for the qualifications grid; **the regular week** across
  class series and duty series, and changing a pattern's person from a date (a coach granted
  `rostering:manage` holds no core permission, so `recurring.change` is out of their reach); **"back
  to the pattern"** for a shift (`recurring.follow`, a core operation, the same).
- **Each day's length in the business's zone**, so a clock-change week is drawn from the host's
  times, never from the device's zone.
- **Everyone for pay**: `payBases` listed only people with a basis set, so nobody new could be
  counted from the pay screen.
- **A coach's app** reaches Rostering by grant, and a role client (ADR 0451) held only the role's
  operations: a coach's client could not type the roster.
- **The import's clash check** must be the host's (the stage 33 note: "the import runs the same
  check as the reconcile"), before anything is written.

## Decision

**New tool-only operations** (as every staffing operation: a shipped pack's tool run, acting for
the verified caller, `assertShippedToolRun`), each behind one Rostering tool:

| Operation | Tool | Who | What |
| --- | --- | --- | --- |
| `staffing.me` | `me` (team) | anyone on the roster | account, name, `rosters`, `pays` (a person only: an assistant is told `pays: false`), the zone, today's local date there, the cut-off, the uncovered window |
| `staffing.candidates` | `candidates` (manage) | a rosterer | every active account with what putting them on the shift would be made with (`checkShift`, the write's own dry run) and whether they could take it by the take's rule; eligible first, then the warned, then those it would clash with or cannot name; who is on it; its pattern's person and whether it keeps its own |
| `staffing.people` | `people` (manage) | a rosterer | active accounts by name and every kind record of every staffed object (names only) |
| `staffing.patterns` | `patterns` (manage) | a rosterer | every series of a staffed object's `pattern` that has not ended, with its rule and person |
| `staffing.setPattern` | `setPattern` (manage, `personApproves`) | a rosterer | a series' person from a local date (`updateRecord` with `recurringFrom`): refused whole as `double_booked` naming the dates, as any series change |
| `staffing.follow` | `follow` (manage, `personApproves`) | a rosterer | a generated shift's person back to its pattern's (`followSeries` on the person field only) |
| `staffing.planCheck` | `planCheck` (manage, `humanOnly`) | a rosterer, a person | the import's dry run (below) |

and two additions: **`staffing.week` answers `days`** (each local date of the range with its hours
in the zone: 23 or 25 on a clock change), and **`staffing.payBases { everyone: true }`** lists every
active account, `not_counted` where none is set.

**Who sees what is the host's.** Every screen asks `me` first and shows the rosterers' controls only
when `rosters`, the pay screen only when `pays`: no block fetches what the viewer may not see, and
none checks a role or a permission. A team member's week is read only (`warnings` come only to a
rosterer, as before). Notes about time off, why a shift was not worked or a period reopened, and pay
figures are kept in the app's query cache no longer than they are shown (`gcTime: 0`), what was
sent is forgotten after the call (`forgetAfter`, PR #291's pattern), and the web screens hide them on
`pagehide` and read them again when the browser brings the page back from its back-forward cache.
The pay CSV is fetched when asked (the export query run as a mutation, never cached) and handed to
the person as a file.

**My calendar** (over ADR 0628's feed): the screen shows whether a feed exists (`feed`), makes or
replaces the address (`feedRotate`, shown once: the origin of the host the screen's client talks
to, its `baseUrl`, before the path the host gives, as https to copy and webcal to open a calendar
app; never an origin from the page's address or query) and switches it off (`feedRevoke`). The address
lives only in the screen's state: never stored, never in a URL of the app, cleared on leaving and
on a back-forward-cache return (in the app, when it goes to the background, so the app
switcher's snapshot never shows it); the mutation is forgotten after the call. A retried make that the
host answers `idempotency_response_lost` (it never keeps the reply) has its own state: a new
address was made and cannot be shown; make another.

**The headless entry is the pack's** (`@composable-os/pack-rostering/client`), as every pack's
(Bookings', Ticketing's): typed from the tools, hooks over any client that holds them, display
functions (times in the shift's or the roster's zone, a day's clock-change note from the host's
hours), and `rosterRefusal`: one designed state per rule the roster's tools refuse with
(`double_booked` with the dates and the other shift, `nobody_qualified`, `offer_stale`,
`offer_taken` naming who, `offer_closed`, `offer_cutoff`, `unavailable_confirm`, `rostering`,
`pay_period_locked`, `pay_period_held`, `roster_changed`, and the rest), the host's own words kept.

**A role's client may carry grants** (amends ADR 0451). The release's `roles.json` gains `grants`:
each carried pack's grantable permission, whether it is restricted, and the staff tools a grant of
it opens (`packGrantable`). `product.ts`'s `mobile.roles` takes `{ role: "bookings.coach", grants:
["rostering:roster"] }` beside a bare role name; `cos client generate` writes that role's client
(`roles/bookings.coach.ts`, the same factory) holding the role's operations and those the grants
open, and names the grants in its header. A grant of a pack the product does not list, a grant the
release does not have, and a role listed twice are refused. The client only types what such an
account may ask: the host still decides every call (ADR 0600).

**Web staff blocks are not yet shown in the product's admin.** A client web app's binding never
serves staff (ADR 0421), and the host's own app (`apps/app`) has no way to show a pack's blocks as
staff screens: today they mount only on its development page (`/blocks`), as Bookings' desk and
class list do. Showing them in the admin needs a platform mechanism (a pack declaring screens, the
admin loading and navigating to them for whoever may open them), which is its own piece of work;
see the spec's "Built in step 7". The app's screens use the role clients above.

**`cos rostering import <roster.csv>`** (the spec's "The move": duties and their regular people,
which no booking system holds): a CSV of duties as weekly patterns (`weekdays`, `first_date`,
`last_date`) or one-off shifts (`date`), with `time`, `length`, `staff_email`, `zone` and `place`.
- **A dry run by default**; `--apply` writes. Every problem in the file is named with its line
  before anyone signs in.
- **Staff are never made** (ADR 0455): an email with no staff account stops the run, naming the
  line, before anything is written.
- **The host's own clash check, over the whole file in one call**: every row goes to `planCheck`
  together (at most 1,000 rows; a larger file is refused before anyone signs in), so rows are
  checked against each other and the roster as it stands. For each plan's dates (a pattern's from
  today to the horizon, as the host's generation makes them) it applies the writes' own rule (a
  claim overlapping, half-open), reading every person's claims and time off once for the whole
  range and checking dates in memory: a D1 call runs at most 1,000 queries, so it never reads per
  date or per person. It is budgeted by dates (20,000), and refuses more (`too_large`) rather than
  cut the check short. It names the other shift by title and start (an earlier row by its line),
  marks a clash between shifts that have both ended (`ended`: reported, never refused), and lists
  the dates the person said they are away and whether they are not qualified (warnings).
  `planCheck` is a person's (it reads time off). `--apply` writes only after that one check
  answered in the same run; if it fails, nothing is written.
- **Written through operations** (`record.create`, `record.list`, `user.list`), as the person who
  signed in on the import door: a one-off shift that clashes is made with nobody on it; a pattern is
  made with its person, and the host's generation makes each clashing date with nobody on it and
  tells the rosterers (ADR 0621). A one-off shift's instants are the host's (`planCheck`'s `first`),
  never worked out by the command. A re-run makes nothing twice, and never changes what is there:
  a pattern already there (its duty, days, time and first date) whose person, length or last date
  the file now gives differently is left as it is and reported "differs, left as it is", as is a
  one-off shift whose end or person differs; the roster is where it is changed. The terminal names
  rows by their line, never by anyone's address.

## Consequences
- A screen's answer to "may I roster?" is the host's at the moment it asks; a grant revoked while
  the screen is open is refused at the next call (`forbidden`, or `rostering` from the host), and
  the block shows that refusal's state.
- The screens' reads are set-based (`staffing/sets.ts`): `candidates` reads profiles, claims, time
  off and qualifications once for all its people (at most 100, `truncated` beyond), `patterns`
  once per series object, `planCheck` once per hundred people; each stays far under D1's 1,000
  queries a call for its largest input (a test counts them).
- An assistant or MCP acting for a rosterer gets no `unavailable` warning from `week`, `check` or
  `candidates` (a coordinator's decision, amending ADRs 0622 and 0624): it learns clashes and
  qualifications, never who is away; for it, `candidates`' `eligible` ignores time off.
- The kinds' colours on the week grid are the block's (stable per kind), not the duty's `colour`
  field: display only.
- A client generated before this release has no `grants` in its kit's `roles.json`: a role with
  grants is refused, naming the release as too old.

## Tests
`apps/runner/test/rostering-screens.test.ts` (the shipped packs in the real host: `me` for an
admin, a member, a team account, an assistant and a granted member; a 25- and a 23-hour day;
candidates ordered and matching the write's own refusal; a pattern's shift back to its person; a
pattern changed from a date and refused whole on a clash; the people and kinds; the plan check
against a shift and against an earlier plan, a weekly plan's dates, an assistant refused; pay's
everyone); `apps/runner/test/rostering.test.ts` (the team role's walk and the restricted tools
include the new tools); `packs/rostering/test/client.test.ts` (the headless entry: times in the
zone across midnight, a day's shifts by its local date, the clock-change note, every refusal's
state, a team client's hooks, `gcTime: 0` on notes, reasons and figures, the export never cached);
`packages/client-gen/test/generate.test.ts` (a coach's client with `rostering:roster` wires the
native rostering blocks with no cast; the rosterers' and pay hooks do not compile; without the
grant no roster); `packages/create-composable-os/test/client-repo.test.ts` and
`packages/product/test/product.test.ts` (role clients with grants, and their refusals);
`packages/create-composable-os/test/rostering-import.test.ts` (the file's problems by line, staff
never made, one dry run for every row, nothing written without `--apply`, a clashing one-off shift
with nobody on it, a re-run that makes nothing twice); `apps/app/e2e/rostering-blocks.spec.ts`
(one test per journey).
