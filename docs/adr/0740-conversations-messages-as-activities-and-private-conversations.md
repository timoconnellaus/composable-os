# ADR 0740: Conversations as core records, messages as activities, private conversations and who reads the inbox

Status: accepted, 2026-11-24 (stage 36, build step 1; decisions 4 and 5 of the stage's spec).
Builds on ADRs [0015](0015-core-data-model.md) (activities linked to records),
[0112](0112-email-calendar-sync-service.md) (private activities, bodies in R2),
[0132](0132-notifications.md) (typed notices), [0244](0244-visibility-enforced-at-one-seam.md)
(the visibility seam), [0320](0320-erase-reaches-every-store.md) (erase reaches every store),
[0402](0402-staff-and-customers.md) (audiences), [0436](0436-pack-roles-and-the-door-role.md) (pack roles) and
[0449](0449-permissions-granted-one-by-one.md) (grants). Migration 1050.

## Context

Stage 36 gives a business one place to answer everyone who writes to it: email to its address
and, later in the stage, chat from its signed-in members. The spec decides that a conversation is
a core record and its messages are activities, so that search, embeddings, summaries, the Trash
and erase, which already work on activities, work on messages; that the inbox is platform, not a
pack (messages arrive through host code and a pack cannot hook writes); that every staff account
reads the inbox except a conversation marked private, which only admins and whoever has it see
(decision 4, a sensitive-access default: health and family matters arrive in messages); and that
pack-role accounts see none of it (decision 5). This ADR records how step 1 builds that.

## Decision

**A conversation is `core_conversation`.** Its Person (null while the sender is unknown), the
unknown sender's address and its SHA-256 (both cleared when staff link the conversation to a
Person), the channel (`email` or `chat`; `text` with stage 36b), the inbox address, subject,
status (`open`, `waiting`, `closed`), assignee, category, what it is about (any record, object and
id), the private mark (who and when), "sender unverified", and its times (opened, last inbound,
last reply, first reply, reply due, snoozed until, closed and by whom). Indexes for the inbox's hot
reads: (status, reply due), (assignee, status), (person, last inbound). Only an email can have no
Person (a `CHECK`): chat is from signed-in customers. The Person's id cascades on a hard delete as
a backstop; erase and the Trash purge delete a Person's conversations with their messages first.

**A write from an older read fails.** Every update sets `version` to the one it read plus one, and
a trigger (`core_conversation_stale`) aborts any other, as for orders and subscriptions. Two staff
opening the same conversation and both pressing "take" commit one take; the other's batch fails and
`conversation.take` answers with who has it. Writes take an optional `version` too, refused early
when the caller's read is already old.

**Messages and notes are activities.** `core_activity` gains the type `chat` and the column
`conversation_id`. SQLite cannot change a `CHECK`, so migration 1050 rebuilds the table with its
rows. D1 enforces foreign keys, so dropping the table would delete every link by cascade: the
links are copied aside and put back. A `DROP TABLE` fires no trigger, so no search row is touched
and no stored body is queued for deletion (tested on D1). The views that read the table are
dropped and made again; `rec_activity` is made again as its base view, which the schema reconciler
extends with extension fields on activities the next time it runs, as after migrations 0111 and
0380 (no shipped pack adds fields to activities).

- A **message** (`email` or `chat`) is on the Person's timeline (linked to them) and carries its
  direction in its payload. Only host code writes one: `messageStatements` (`inbox/index.ts`),
  which the inbound email hook (step 2), the customer's chat (step 4) and staff replies will call.
  It reopens a waiting or closed conversation on an inbound message and tells whoever has it.
  `activity.update` refuses a conversation's activities, and `activity.setPrivate` refuses them
  (a conversation is private as a whole).
- A **note** is a `note` activity on the conversation and nowhere else: not linked to the Person,
  so it is never on their timeline, which is what the customer's own reads (step 4) are built
  from, and never a message. Its mentions are user ids in its payload; each is told. The audit
  records the note, never its words.

**Who reads.** New core permissions: `inbox:read` (admins, members, viewers), `inbox:work`
(admins, members), `inbox:manage` (admins; its operations arrive with Settings → Inbox). None is
grantable, and a pack role holds none (the pipeline refuses a pack-role account every operation
outside its pack), so a coach, the door or a cleaner reads nothing of the inbox. MCP's `read`
scope carries `inbox:read` and `write` carries `inbox:work`: a client sees what its user sees.

**A private conversation** is read by admins and its assignee only. The rule is written once, in
`inbox/index.ts`, as SQL over a conversation (`conversationReadable`) and over an activity
(`activityConversationReadable`), and every read path takes it: `inbox.list` and
`conversation.get` (not listed, not found), and every activity read (`activity.get`,
`activity.listForRecord`, `activity.list`, `activity.getBody`, the approval simulation's load),
because they all build on one query. Reassigning moves who sees it. Search, the `rec_*` views (and
so `query.sql`, dashboards and the assistant's SQL), embeddings and summaries leave a private
conversation's messages and notes out for everyone, admins included, as they do a private
activity: they are shared indexes with no reader to filter for. A trigger takes them out of search
when the mark is set and puts the live ones back when it is cleared; marking queues their vectors,
which the drain deletes (and re-embeds on unmarking), and deletes every AI summary of, or built
from, its activities in one statement, because `summary.get` serves a cached summary even when it
is stale. (`activity.setPrivate` now deletes a private activity's summaries the same way.) Anyone working the inbox may mark a
conversation private; only an admin or its assignee may unmark it (only they can read it). Each
mark and unmark is audited with who.

**What only a person may do.** `conversation.setPrivate` and `conversation.linkPerson` are
`actors: ["human"]` and off MCP; `conversation.setStatus` refuses `closed` from any actor but a
person. `conversation.linkPerson` needs `records:write` beside `inbox:work`.

**Operations (step 1).** `inbox.list` (mine, unassigned, all; status, channel, category, person;
newest first, a cursor), `conversation.get` (the conversation, the latest 100 messages and notes
oldest first with a cursor for earlier ones, what it is about with its title, the person's other
conversations), `conversation.take`, `conversation.assign` (only to a human account holding
`inbox:work` with no pack role), `conversation.setStatus`, `conversation.setAbout` (any live record
a timeline can link to), `conversation.setPrivate`, `conversation.linkPerson` (to an existing
Person; "make a Person" is `person.create` first) and `message.note`. All are staff-only. Each list
and read is a fixed number of statements however many conversations and messages there are
(`test/inbox-cost.test.ts`). A page of the inbox walks an index in its order
(`core_conversation_activity_idx`, on the last inbound time or else the opening time, then the
id), testing status row by row, so it reads the page's rows and stops rather than sorting every
open conversation. A note also bumps the conversation's version, so a note checked against a read
that a private mark or a reassignment has overtaken fails rather than tell someone who may no
longer read it.

**Notices.** New host-written types `inbox.assigned`, `inbox.reply`, `inbox.mention` and
`inbox.due` (the last written by reply targets, step 5), routed by the existing preferences and
linking to the conversation (`/inbox/<id>`). Their words name who did what, the Person's name and
the channel: never the subject, a message's words or an unknown sender's address. A notice may go
out by email or Slack, and it outlives a later private mark and the address's clearing on link.

**Extensions.** A runtime extension (one written in the app) may not declare any inbox operation
(`inbox.*`, `conversation.*`, `message.*`): the install check refuses it, as it refuses health
notes (ADR 0643). Only reviewed pack code may read or work the inbox. No shipped pack does yet.

**Erase, purge and merge.** A Person's erase deletes their conversations and every message and
note in them, whatever else a message is linked to, and also any unknown-sender conversation from
one of their addresses that staff never linked to them (found by the address's hash); their bodies in R2 are queued by the existing
trigger, their vectors and summaries go with the erase's existing passes. The Trash purge does the
same for a purged Person: there is nobody left to continue the conversation with. A merge moves
the merged Person's conversations to the survivor. Each delete binds one list, so a long history
is a handful of statements.

## Consequences

- Every activity read now asks one primary-key lookup per conversation activity
  (`NOT EXISTS` on `core_conversation`); a non-conversation activity pays nothing but the
  `conversation_id IS NULL` test.
- An admin does not find a private conversation's messages by search or SQL, as an owner does not
  find their private email there; they read it in the inbox and on the timeline.
- Rebuilding `core_activity` again (for `text` in 36b) follows the same steps; migration 1061 is
  reserved for it.
- An extension's fields on activities leave `rec_activity` from migration 1050 until the
  reconciler next runs on that host.

## Left out (later steps of the stage)

Sending (`message.send`, `conversation.start`) with email in and out (step 2) and chat (step 4);
the web screens, saved replies and Settings → Inbox with its categories (step 3); reply targets,
opening hours, snooze and assignment rules (step 5); drafts and AI (step 6); the "about"
declaration in a pack's manifest (step 9). Until step 9, `conversation.setAbout` accepts any live
record a timeline can link to.
