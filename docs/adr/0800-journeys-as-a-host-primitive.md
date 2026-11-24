# ADR 0800: Journeys as a host primitive

Status: accepted, 2026-11-24 (stage 53, build step 3; the spec's decisions 2, 3, 5, 8, 9 and 10 and
"Decided by this spec"). Builds on ADRs [0441](0441-publishable-states-schedules-and-versions.md)
and [0480](0480-an-ai-asks-to-publish-a-person-approves.md) (publishing; an AI asks, a person
approves), [0590](0590-routine-mail.md) (routine mail's rules for words and values),
[0540](0540-the-family-link.md) (guardians) and [0640](0640-agreement-documents-versions-nobody-changes-published-by-a-person.md)
(a working copy and versions nobody can change, the same shape). Amends ADR
[0449](0449-permissions-granted-one-by-one.md): two new grantable core permissions,
`journeys:manage` and `journeys:publish`, and a new core permission `journeys:read`. ADR
[0242](0242-email-sending-and-sequences.md) (proposed) is to be amended when stage 13 is
interviewed: its sequences should become journeys (a manual entry and a personal sender), not a
second engine. Migration 1170.

## Context

A business wants messages that go out on their own to one person at a time, because of what that
person did or stopped doing (a welcome series, a nudge after two weeks without a class, a
win-back). Automations cannot carry them (one Workflow per Person per journey asleep for weeks; no
event to say "they replied"; every send reviewed under Balanced; the words would be code), and
routine mail's guarantee is words shipped in code, which a business's own sequence cannot have.
The spec decided a host primitive: data the business edits, run by one engine in the host, whose
wording a person approves once by publishing it.

## Decision

**Journeys are core tables, not records and not a pack** (`packages/core/src/journeys/`,
`operations/journey.ts`, migration 1170). `core_journey` holds the name, the kind (`service` or
`promotional`, fixed when made), the status (`draft`, `live`, `paused`, `archived`), the owner, and
the **working copy**: one JSON document (`draft`) with the entry rule (`signal`, `quiet`,
`birthday`, `manual`), conditions, exit signals, the re-entry rule (once, or not again within N
days), `includeBulk` (default off), the reply-to and the steps (`send`, `wait`, `branch`, `task`,
`end`). `core_journey_version` is a published snapshot; `core_journey_entry` one Person on one
journey (one live entry per Person per journey, a partial unique index; an index on `state,
next_at` for step 4's tick); `core_journey_step_log` what happened at each step, never the words.
No `rec_*` view reads any of them.

**A version is the approval of the wording.** Only a published version runs. `journey.publish`
takes the hash, rev and number `journey.preview` showed (every message rendered for a sample Person,
with what would hold one, and the plain-words summary) and refuses a copy changed since. The
database makes the guarantees, for every writer: a version is never updated or deleted; it is made
only from the working copy as stored at the reviewed rev, numbered next, of a journey not archived,
with `drafted_by` true to whether an AI wrote the copy since the last publish (`draft_ai`), and
`published_by` a `core_user` (the adjudicator is not one); every change of the copy moves its rev
by one; a journey goes live or pauses only with a version, never back to draft; archived is final;
an entry is made only on a live journey on its own version.

**Who publishes.** `journeys:publish`, admins by default and grantable (decision 3). The operation
is `alwaysReview` for every AI actor (`ALWAYS_REVIEWED_PUBLISHERS`, ADR 0480): an AI's call is a
request that waits for a person under every preset and floor, with review source `always`, which
the adjudicator never approves. `approveActions` refuses to apply one unless the approver is a
person holding `journeys:publish` (as a record publish needs `records:publish`); the handler also
refuses an application approved by the adjudicator. The version keeps who published it (the
approver) and, for a request, who asked and through which actor. Going live and resuming are
`actors: ["human"]`; an AI may draft, preview, pause, stop an entry and add people (a `bulk-write`,
reviewed above the gate's bulk threshold).

**What a message may hold** (the publish check, `journeyProblems`): at most 20 steps, 8 messages,
10 branches; every step id once; branches only forward, so a journey never loops, and every step
reached; slots only from the fixed list (`{firstName}`, `{business}`, `{record}`, `{member}` in a
guardian's version, `{site:/path}` and `{unsubscribe}` in a body); `{unsubscribe}` exactly once in
every body; the business's own words pass routine mail's `unroutineText` and `unroutineWords`
line by line (no address, phone number, link or markup typed in: links only to the business's own
site through `{site:}`); a guardian's version only on a service journey (a promotional journey is
never sent about a child); a task to the owner or an active staff account.

**The reply-to** is one of the addresses a human admin allowed in `journey.settings.update`
(`settings:manage`, `actors: ["human"]`, not on MCP): an active staff account's own address, which
stops counting when the account leaves or its address changes. A copy naming another is refused on
save, and a journey whose reply-to is no longer allowed cannot be published, set live or resumed.
The same setting holds "journeys send on their own" (off on deploy) and the weekly cap (3, or
fewer); step 4's send decision reads them.

**Entries.** `journey.enter` adds up to 500 people by hand to a live journey at the newest
version's first step, leaving out (and saying why) anyone not found, in the Trash or merged away, a
minor (a live dependant or a Person staff marked) on a promotional journey, anyone already on it and
anyone the re-entry rule keeps off. The entry records the standing of its cause: `person` for a
person's call or an AI's that a person approved, `ai` otherwise, so step 4 holds that entry's
messages. Every list of ids is one bound JSON value read with `json_each`: 500 people take a
handful of statements. Archiving stops every entry; erase deletes a Person's entries and their log.

**The four starters** (decision 9) are seeded by the migration as drafts: welcome series, "we have
not seen you", win-back after a membership ends, trial ended without joining. None has a reply-to,
so none can be published until a person edits it, and none goes live until a person sets it live.

## Consequences

- Nothing here sends. The minute tick, the daily scan, exits and the send decision are step 4,
  through stage 30's routine messages as a new source.
- Signals are named as `<pack>.<name>` and checked only for their form until step 2's
  `journeySignals` declarations land; going live will then refuse a signal no installed pack
  declares.
- An organisation reply-to address confirmed by a code needs the host to send the code: it comes
  with step 4. Until then only staff accounts' own addresses can be allowed.
- A plan's or class type's name as a slot comes with step 2's declarations (which relation names
  them); until then `{record}` is the signal record's title.
- The approvals inbox shows an AI's publish request by its input (the journey, its hash and the
  version number); the approver reads the messages in the journey's preview.

## Removal checks

Each check was removed, its test seen to fail, and restored (`packages/core/test/journeys.test.ts`):

| Check removed | Test that failed |
| --- | --- |
| `alwaysReview` on `journey.publish` | the AI's publish waits for a person, never the adjudicator |
| The approver holds `journeys:publish` (`approveActions`) | the same test (a member's approval) |

The handler's refusal of an adjudicator's approval is a second wall behind the review source
`always`; no test reaches it, as none can get past the first.
