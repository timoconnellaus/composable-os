# Stage 78: General packs

Read first: [`AGENTS.md`](../../AGENTS.md), [`docs/architecture.md`](../architecture.md) (Packs,
blocks and client apps; the Bookings, Memberships, Programs and Courses paragraphs),
[`CONTEXT.md`](../../CONTEXT.md) (Pack, General pack and domain pack, Class type, Behaviour), ADRs
[0980](../adr/0980-general-and-domain-packs.md), [0478](../adr/0478-the-courses-pack.md),
[0812](../adr/0812-an-automation-that-runs-only-with-another-pack.md),
[0504](../adr/0504-the-bookings-pack.md), [0505](../adr/0505-window-numbers-through-two-relations-and-settings.md),
[0511](../adr/0511-the-memberships-pack-and-passes.md) and
[0611](../adr/0611-one-host-a-database-per-client.md); issue #545; code: `packs/*/index.ts`
(`requires`, `fields`, relations), `packages/sdk/src/manifest.ts` (`validateManifest`),
`packages/core/src/extensions/install.ts` (`requires` at install),
`packages/create-composable-os/src/client-repo.ts` (`requiredPacks`).

Status: **steps 1 and 2 spec agreed (the owner's decisions of 2026-11-27); steps 3 to 12
proposed**, each to be settled before it is built.

## Goal

The general packs (Bookings, Memberships, Courses, Rostering, Daily checks, Equipment, Forms,
Content, Shop, Offers, Deals, Leads, Ticketing, Knowledge) install in a business that is not a gym,
without the gym's own pack, Programs (the exercise bank and training), and without gym words. A
gym is general packs, plus Programs, plus gym wording. This is the first step towards a second
kind of business reusing the same packs.

## What exists today (from the code, before step 2)

- **Bookings required Programs** (`packs/bookings/index.ts`), only because the class type was
  Programs' object (`programs.classtype`); Bookings added its rules to it as fields on another
  pack's object (`fields: { "programs.classtype": … }`, ADR 0505).
- **Memberships required Programs and Bookings**: `classTypes` related to `programs.classtype`,
  `services` to `bookings.service`, and its holders are spent by Bookings' bookings and
  appointments.
- **Courses requires Programs and Content**: Programs for the session lesson (a variant of its
  outline document, `x.programs.assign`, grants on Programs' objects), Content for the rich text
  blocks its player draws. Video and text lessons need neither.
- **Leads names Deals' objects** without declaring `requires`; both are general.
- **Nothing else requires another pack.** Rostering reads classes through core's `staffing.*`
  (the `staffed` behaviour), not through Bookings; Offers names other packs' objects as strings
  checked only against packs installed beside it.
- **`cos deploy` installs a listed pack's requirements silently** (ADR 0478, amended), followed to
  the end, from the release's `roles.json`.
- **An optional part exists for automations only** (`onlyWith`, ADR 0812). A field, relation,
  permission, tool, view or document variant that exists only with another pack has no
  mechanism; naming an object of a pack that is not installed refuses the install.
- **Nothing moves an object between packs.** `renamedFrom` on an object is local to its extension.
- **No label overrides.** Editable select options aside (ADR 0246), every word is in the release:
  object and field labels, tool descriptions, routine mail, blocks. Gym words are also in
  identifiers (`bookings.coach`, `bookings.class`, role `bookings.coach`, tools `classList`,
  `coachDay`).
- **No host holds data in these packs.** The first client has nothing in staging or live (stage
  46, decision 21); stage 66 step 9 (the first client) is not built; the site says Bookings,
  Memberships and Programs are "built, not yet live" (`apps/marketing/SITE.md`).

## Decided by the owner (2026-11-27)

| # | Decision |
| --- | --- |
| 1 | **Two tiers.** Packs are general or domain. A domain pack may require a general pack; a general pack never requires a domain pack. Where two packs work together, the extra parts exist only when the other pack is installed (later platform work). Wording becomes configuration, settable per client on a host of many clients (later platform work). Rules stay in behaviours |
| 2 | **Class types live in Bookings.** A gym gets Bookings installed from day one, unused except for class types until it books classes on the platform. Programs requires Bookings |
| 3 | **The class type moves before any client holds data in these packs.** None does, so it is a plain move with no data migration. The ADR says so, and what a host holding data would need |
| 4 | **Identifiers such as `bookings.coach` are not renamed in step 2.** Renaming is step 3, with its open question |

## The design in one page

- **The tier test:** would a business of a different kind install this pack unchanged? Words do
  not decide it (they become configuration); objects and rules do. Programs is the one domain pack
  today. Every other pack on `main` is general.
- **The rule:** domain → general is allowed; general → domain never; general → general only where
  it is the pack's purpose (Memberships pays for Bookings' bookings; Leads converts into Deals).
- **No parent pack:** the host's behaviours and the base records are the shared layer (ADR 0980,
  decision 3).
- **The class type is Bookings' own object** (`bookings.classtype`), with what Bookings used to add
  to Programs' as its own fields. Programs and Memberships relate to it.
- **Optional parts and wording are platform work** (steps 5, 9 and 10), additive, after the first
  client if need be.

## Out of scope

- A second solution page on the site, until a business of another kind is real (step 11).
- Data-only export and import (issue #532): noted, not on this path.
- The Jobs pack (PR #505). By the rule it is **general** (it requires nothing, and its `lead`
  relation is already left out so Leads stays optional) unless the owner decides trades is a
  domain; it is not changed here.

## Acceptance criteria

Per step; a step is done when its criteria hold.

**Step 1 (the ADR and this spec).**
1. ADR 0980 states the tiers and their test, the dependency rule, why there is no parent pack, the
   class type in Bookings and why, the plain move and what a host with data would need, and what
   is left for later.
2. ADRs 0448, 0478, 0504, 0505, 0511, 0812 and 0889 carry dated notes; none is rewritten.
3. `CONTEXT.md` defines general and domain packs; the class type entry names `bookings.classtype`.

**Step 2 (the class type moves).**
1. `bookings.classtype` is Bookings' object with name, order, colour and the booking, waitlist,
   reminder, drop-in, staff-only and pay-minute fields; `programs.classtype` and Bookings' fields on
   another object no longer exist.
2. Bookings declares no `requires`; Programs `requires: ["bookings"]`; Memberships
   `requires: ["bookings"]`; Courses is unchanged.
3. Installing Programs before Bookings is refused and names Bookings; Bookings installs alone with
   its class types and none of Programs' objects; Memberships installs beside Bookings with no
   Programs.
4. `cos deploy` for a product listing only Programs installs Programs and Bookings; only Bookings,
   Bookings alone; Memberships, Memberships and Bookings; Courses, Courses, Programs, Bookings and
   Content.
5. Everything that named the old object names the new one: Bookings' tools, automations and
   dashboard SQL, Programs' tools and hooks, Rostering's tool description, `cos programs import`,
   the runner tests, the e2e specs, previews, the staff contract and `roles.json`, the generated
   docs, the pack overviews, `CONTEXT.md` and `docs/architecture.md`.
6. No core migration; core's staffing reads the kind object from the relation, so it follows.
7. `pnpm cos ext check` and `pnpm cos ext test` pass for Bookings, Programs, Memberships, Courses
   and Rostering.

**Step 3 (identifiers).** Decided by the owner first (question 2). If renamed: every renamed
object, field, role, permission and tool, and every client app, block, import and test that names
it, in one change before the first client; if not, `CONTEXT.md` records `class`, `coach` and the
rest as Bookings' generic identifiers.

**Step 4 (the tier, declared and checked).**
1. A manifest declares `tier: "general" | "domain"` (contract version unchanged or bumped, as the
   contract's rules say); a shipped pack without one is refused by the lint.
2. `cos ext check` and the install check refuse a general pack whose `requires` names a domain
   pack, or which names a domain pack's object outside an optional part, with a message naming
   both.
3. `roles.json` carries each pack's tier.
4. Courses is the one known breach until step 6: the check either lands after step 6 or carries
   an explicit, dated exception for it.

**Step 5 (optional parts).**
1. `onlyWith` (or its successor) covers fields on another pack's object, relations and document
   refs, `permissions`, operations granted, tools, views and record tabs, document variants and
   dashboards.
2. Installing the other pack re-checks and reconciles the extensions waiting for it (ADR 0812
   says it does not today); disabling it hides those parts and keeps their data.
3. A test installs a pack with an optional part before and after the other pack, and with it
   disabled.

**Step 6 (Courses).** The session lesson is an optional part with Programs; Courses drops
`requires: ["programs"]`. The rich text renderer is a base block, so Courses and Knowledge drop
Content. A product listing Courses gets neither Programs nor Bookings.

**Step 7 (Programs, optionally).** If a coach-only business appears, Programs' link to Bookings'
class type becomes an optional part and `requires` goes.

**Step 8 (Offers).** What a discount may cover is read from the sellable objects installed, not a
hard-coded list with gym labels.

**Step 9 (wording).** Per-client label overrides (object label and plural, field labels, role
labels, option labels, navigation) stored in the client's database through an operation, applied by
the host's screens, record views, routine mail and Today, read by blocks and client apps; a preset
("gym") chosen at `cos client add` or install that reproduces today's words exactly. Who may change
them follows question 3.

**Step 10 (neutral strings).** General packs' display strings and the host's operation
descriptions lose gym words; the gym preset gives them back. What the assistant reads follows
question 4.

**Step 11 (site and skills).** `SITE.md` and the site's pieces, the docs overviews and the
`start-client-app` skill describe tiers and presets; a second solution only when one is real.

**Step 12 (data-only import, issue #532).** Noted only.

## Dependencies

Step 2 needs step 1. Steps 3 and 4 need step 2. Step 5 needs step 1. Steps 6 and 7 need step 5.
Step 10 needs step 9. Step 11 needs steps 2 and 9. **Steps 1, 2 and (if chosen) 3 must land before
stage 66 step 9**, the first client's install: after that, a moved object or a renamed identifier
needs a migration that does not exist.

## Migrations and numbers

Block CG: migrations 1530–1549, ADRs 0980–0989. ADR 0980 is written (steps 1 and 2). Step 2 used no
migration.

## Suggested build order

| # | Step | Kind |
| --- | --- | --- |
| 1 | The ADR (tiers, the rule, no parent pack, class type in Bookings) and this spec | docs |
| 2 | Move `programs.classtype` to `bookings.classtype`; Bookings requires nothing, Programs and Memberships require Bookings | pack, `cos` import |
| 3 | Identifier renames, if the owner chooses them | pack |
| 4 | The tier in the manifest, checked by `cos ext check`, the install and the lint; in `roles.json` | platform |
| 5 | Optional parts beyond automations, re-checked when the other pack is installed | platform |
| 6 | Courses: the session lesson optional with Programs; the rich text renderer a base block | pack, blocks |
| 7 | Programs: Bookings optional, if a coach-only business appears | pack |
| 8 | Offers: what a discount covers from the installed sellable objects | platform, pack |
| 9 | Wording: per-client labels and presets | platform |
| 10 | General packs' strings and host descriptions neutral; the gym preset gives the words back | pack, core |
| 11 | The site, docs and skills | docs, site |
| 12 | Data-only import (issue #532) | platform, noted |

## Decided by this spec, open to override

- **`cos programs import` keeps class types.** `classtypes.csv` stays in the programs folder and
  writes `bookings.classtype` (Programs requires Bookings, so they are always there; a gym's
  converter does not change). A Bookings import, when stage 31 step 10 is built, may read the same
  file.
- **Bookings' class type keeps Programs' shape**: `navigation: "settings"`, `signedIn` read of name
  and order, the `users` icon; the booking rules stay readable through the class by the host, not
  by members directly.
- **The tier field and its check wait for step 4**: step 2 did not need them, and the check would
  fail on Courses until step 6.
- **The old fallbacks are gone**: tools no longer read `bookings.staffOnly` or
  `bookings.promotionMinutes` as a registry name on another pack's object; core still supports a
  field an extension adds to another's kind object (`payMinuteFields`), unused by shipped packs.

## Questions for the owner

1. **Memberships without Bookings.** A business that sells plans with no timetable (a club, a
   subscription) would want Memberships alone. Today a membership only pays for bookings and its
   `services` and `classTypes` relate to Bookings. Keep `requires: ["bookings"]` until a second
   kind of business asks, or make the class and service limits optional parts (step 5)?
2. **Rename identifiers before the first client, or only relabel?** `bookings.coach`,
   `bookings.class`, roles `bookings.coach` and `programs.coach`, permissions `bookings:coach` and
   `bookings:cancelClasses`, tools `classList`, `cancelClass`, `coachDay`. Renaming later needs
   migrations and breaks client apps; relabelling leaves gym words in what developers and the
   assistant see.
3. **Who may change wording:** an admin only, or the assistant too with a person's approval?
4. **Do the assistant's tool descriptions follow a client's words,** or stay generic with the
   client's words given to the assistant in its instructions?
5. **Jobs (PR #505): general, or a trades domain pack?** By the rule it is general (it requires
   nothing); trade words would then be a preset (step 9).

## Status

Steps 1 and 2 spec agreed (the owner's decisions of 2026-11-27); steps 3 to 12 proposed. Each
build step changes its own line here (CONTRIBUTING.md, Working in parallel).

- **Step 1** — in progress — branch `feat/stage-78-general-packs` — The ADR and this spec: ADR 0980,
  dated notes on ADRs 0448, 0478, 0504, 0505, 0511, 0812 and 0889, `CONTEXT.md`

- **Step 2** — in progress — branch `feat/stage-78-general-packs` — The class type moves to
  Bookings: no migration; the tier field (step 4) not added

- **Step 3** — not built — needs: step 2, an owner decision — Identifier renames

- **Step 4** — not built — needs: step 2 — The tier, declared and checked

- **Step 5** — not built — needs: step 1 — Optional parts beyond automations

- **Step 6** — not built — needs: step 5 — Courses without Programs and Content

- **Step 7** — not built — needs: step 5, an owner decision — Programs without Bookings

- **Step 8** — not built — needs: step 1 — Offers' covered objects from what is installed

- **Step 9** — not built — needs: step 1, an owner decision — Per-client wording

- **Step 10** — not built — needs: step 9 — Neutral strings, the gym preset

- **Step 11** — not built — needs: step 2, step 9 — The site, docs and skills

- **Step 12** — not built — needs: an owner decision — Data-only import (issue #532)
