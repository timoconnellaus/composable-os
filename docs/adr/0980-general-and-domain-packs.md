# ADR 0980: General and domain packs, and the class type in Bookings

Status: accepted, 2026-11-27 (the owner's decisions of that day, issue #545; stage
[78](../stages/78-general-packs.md), steps 1 and 2). Builds on ADRs
[0401](0401-platform-packs-screens.md) (packs),
[0404](0404-behaviours-are-the-vocabulary.md) (behaviours are the vocabulary),
[0478](0478-the-courses-pack.md) (`requires`, and `cos deploy` bringing a required pack) and
[0812](0812-an-automation-that-runs-only-with-another-pack.md) (`onlyWith`). Amends ADRs
[0448](0448-programs-the-layout-assignments-and-the-log.md),
[0504](0504-the-bookings-pack.md), [0505](0505-window-numbers-through-two-relations-and-settings.md)
and [0511](0511-the-memberships-pack-and-passes.md), each with a dated note.

## Context

The packs were written for a gym, the first client. Most of them describe things any business
has (a timetable and bookings, memberships and passes, a roster, forms, a shop, procedures), but
the dependencies did not let them go anywhere else:

- **Bookings required Programs**, the gym's exercise bank and training, only because the class
  type was Programs' object (`programs.classtype`, ADR 0504). Bookings added its booking rules to
  it as fields on another pack's object (ADR 0505).
- **Memberships required Programs and Bookings**: a plan's `classTypes` pointed at
  `programs.classtype` (ADR 0511).
- **Courses requires Programs** for one kind of lesson (a training session) and Content for its
  rich text blocks (ADR 0478, amended).
- `cos deploy` installs whatever a listed pack requires, silently (ADR 0478, amended), so a
  business listing only Bookings got a gym's exercise bank.

The owner's goal (issue #545): Bookings, Memberships, Courses and the other general packs can go
into a business that is not a gym, without Programs and without gym words. A gym is general packs,
plus Programs, plus gym wording.

No host holds class types, classes or memberships today. The first client has nothing in staging
or live (stage 46, decision 21); stage 66's step 9, "The first client, staging then live", is not
built; the site says Bookings, Memberships and Programs are "built, not yet live"
(`apps/marketing/SITE.md`, rows 5 and G4); and the first client's own repository lists only
Ticketing. Nothing in the repository moves an object from one pack to another: `renamedFrom` on
an object renames it inside its own extension (`packages/core/src/extensions/reconciler.ts`).

## Decision

**1. Packs are in two tiers.** A **general pack** is one a business of a different kind would
install unchanged: Bookings, Memberships, Courses, Rostering, Daily checks, Equipment, Forms,
Content, Shop, Offers, Deals, Leads, Lifecycle, Ticketing, Knowledge. A **domain pack** serves one
kind of business: Programs (a gym's exercise bank, programs and training log). The test for a
pack's tier is that question: *would a business of a different kind install it unchanged?* Its
words may be one kind's today (a class, a coach, a member); wording is configuration (decision 5),
so words alone do not make a pack a domain pack. Its objects and rules do.

**2. The dependency rule.** A domain pack may require a general pack. A general pack never requires
a domain pack. Two general packs may require each other only as they do today (Memberships on
Bookings, Leads on Deals), each such link a reviewed choice. Where two packs work together and
neither should require the other, the extra parts exist only when the other pack is installed: an
automation already can (`onlyWith`, ADR 0812); fields, relations, permissions, tools, views and
document variants cannot yet (stage 78 step 5, platform work).

**3. No parent pack.** A gym pack built on top of a "generic booking" parent pack was considered
and rejected. The shared layer already exists and is not a pack: the host's **behaviours**
(`recurring`, `capacity` and `claims`, `allowance`, `staffed`, `occupies`, `sellable`, `states`)
hold every rule, and the **base records** (Person, Organisation, orders, subscriptions,
agreements) hold what every business has. A pack is a composition of behaviours over its own
objects; a second layer of packs would add an inheritance the contract does not have (no pack
extends another's object except by `fields` on it) and a second place for rules to hide. A gym is
a list of packs, not a subclass.

**4. The class type is Bookings'.** `programs.classtype` becomes **`bookings.classtype`**, Bookings'
own object, and the fields Bookings added to Programs' class type (colour, the booking windows,
the waitlist cut-off, the reminder, the drop-in price, staff-only, set-up and pack-down minutes)
are its own fields. Why Bookings: a class type is what a timetable's series and its classes are
of, and everything that reads it as more than a name (the booking windows, the timetable's
horizon, the drop-in price, the coach's qualification and pay minutes) is Bookings'. Programs
only assigns a class program to it. So:
- **Bookings requires nothing.** A gym installs Bookings from day one, used only for its class
  types until it books classes on the platform (the owner's decision).
- **Programs requires Bookings** (domain on general) and its assignments and sessions relate to
  `bookings.classtype`; it reads the class type's name with `permissions.read`.
- **Memberships requires Bookings only**; a plan's and a pass's `classTypes` relate to
  `bookings.classtype`.
- **Courses is unchanged**: it still requires Programs (and Content). That breaks decision 2 and
  is left on purpose until its session lesson can exist only with Programs (stage 78 step 6, after
  step 5's platform work). Until then a product listing Courses gets Programs and Bookings too.
- The staffing kind core stores for a qualification or a pay period (`core_staff_*.kind_object`)
  is the class type's object name read from the staffed object's `kind` relation
  (`packages/core/src/staffing/kinds.ts`); no code names Programs, so it follows the relation. The
  pay minutes are read from the kind's own field or, as before, a field its extension adds to it
  (`packages/core/src/staffing/pay.ts`, `payMinuteFields`).
- `cos programs import` keeps reading `classtypes.csv` from the programs folder and writes Bookings'
  class types: Programs requires Bookings, so they are always there, and a gym's converter does
  not change. A Bookings import (stage 31 step 10) may read the same file later.

**5. Wording is configuration** (later, stage 78 steps 9 and 10): set per client, including on a
host of many clients (ADR 0611), in the client's own database; rules stay in behaviours. This ADR
decides only that words are not a reason for a pack's tier.

**6. A plain move, no migration.** No host holds `programs.classtype` data, so the move is a code
change with no data migration and no rename support: a fresh install makes `x_bookings_classtype`
and never `x_programs_classtype` or Bookings' side table `x_bookings_programs_classtype`. **If a
host did hold data**, this would need: a migration (or a one-off operation) copying
`x_programs_classtype` and Bookings' side table into `x_bookings_classtype` with the same ids;
every relation column that points at a class type kept (ids are unchanged, so relations hold);
every row that names the object as data rewritten (`core_staff_*.kind_object`, object-scoped
grants, audit and approvals, tags, links, search entries, saved views and dashboards); the
reconciler taught that an object may move between extensions (today `renamedFrom` is local); and
Programs' upgrade ordered after it, so that dropping its `classtype` hides nothing still in use.
None of that is built. The move must therefore land before any client holds data in these packs:
before stage 66 step 9.

## What is deliberately left for later

The steps of stage 78 after step 2, each with its own acceptance criteria in the spec:
- **Identifiers are not renamed** (`bookings.coach`, `bookings.class`, roles `bookings.coach` and
  `programs.coach`, permissions such as `bookings:coach`, tools `classList`, `coachDay`). Renaming
  later needs a migration and breaks client apps; whether to rename before the first client is
  the owner's open question (step 3).
- **The tier is not declared or checked**: no `tier` field in the manifest, no check that a general
  pack requires no domain pack, no `tier` in `roles.json` (step 4).
- **Optional parts** beyond automations (`onlyWith` for fields, relations, permissions, tools,
  views, document variants), and re-checking a waiting extension when the other is installed
  (step 5, amending ADR 0812).
- **Courses drops Programs and Content** (step 6); **Offers' list of what a discount covers**
  comes from the installed packs (step 8); **per-client wording** (steps 9 and 10).
- The Jobs pack (PR #505, stage 39) requires nothing and is general by this rule unless the owner
  makes trades a domain; its `lead` relation stays out, as its spec says.

## Consequences

- A product listing only Bookings installs Bookings alone; Memberships brings Bookings; Programs
  brings Bookings; Courses brings Programs, Bookings and Content (`cos deploy`, from the release's
  `roles.json`, tested in `packages/create-composable-os/test/client-repo.test.ts`).
- The host's shipped install makes two passes over the packs in id order, so Bookings is in before
  Programs and Courses in any product.
- Bookings' class type is `navigation: "settings"` in Bookings, read by every signed-in member
  (`signedIn`, name and order), as Programs' was.
- Client apps and screens that named `programs.classtype` (Programs' `useClassTypes` hook, the
  e2e specs, previews) name `bookings.classtype`.
- A rule that a later step adds (the tier check) will find one known breach, Courses on Programs,
  which step 6 removes.

## Proof

- `packs/bookings/test/bookings.test.ts`: Bookings has no `requires`, no fields on another object,
  and the class type with its rules as its own object.
- `packs/programs/test/programs.test.ts`: Programs requires Bookings and relates its assignment to
  `bookings.classtype`; `packs/memberships/test/memberships.test.ts`: Memberships requires Bookings
  only.
- `apps/runner/test/bookings.test.ts`: Programs is refused before Bookings; Bookings installs on
  its own with its class types and none of Programs' objects. `apps/runner/test/memberships.test.ts`:
  Memberships is refused before Bookings, and the refusal names no Programs.
- `packages/create-composable-os/test/client-repo.test.ts`: what `cos deploy` installs for a
  product listing Programs, Bookings, Memberships or Courses.
- `pnpm cos ext check` and `pnpm cos ext test` pass for Bookings, Programs, Memberships, Courses and
  Rostering.
