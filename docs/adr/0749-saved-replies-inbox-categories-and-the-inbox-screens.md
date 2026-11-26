# ADR 0749: Saved replies, the inbox's categories and its web screens

Status: accepted, 2026-11-26 (stage 36, build step 3). Builds on ADR
[0740](0740-conversations-messages-as-activities-and-private-conversations.md) (conversations, who
reads the inbox, private conversations) and [0402](0402-staff-and-customers.md) (audiences).
Migration 1051.

## Context

Step 3 of stage 36 builds the admin's web screens for the shared inbox: the inbox list, a
conversation, saved replies and Settings → Inbox. The spec lists `savedReply.list` / `create` /
`update` / `archive` (`inbox:work`; shared ones `inbox:manage`), `conversation.setCategory`
and `inbox.settings.get` / `update` (`inbox:manage`, a human admin, not on MCP), and decides that
saved replies are shared or personal with a few fixed slots and never free merge fields. It does
not say who may change another's personal reply, whether an AI caller may write one, how slots
are written or filled, or how a member (who files conversations) reads the categories when the
settings are an admin's. This ADR records those choices.

## Decision

**A saved reply is `core_saved_reply`** (migration 1051): title, words (plain text), the channels
it fits (`email`, `chat`), its owner (a staff account) or none (shared), the slots it uses, archived
at, and a version guard as for conversations (`core_saved_reply_stale`). A personal reply goes
with its owner's account (`ON DELETE CASCADE`): it never becomes a shared one.

**Who.** Everyone who works the inbox (`inbox:work`: admins and members) lists the shared replies
and their own, fills them into a reply, and keeps their own. Only holders of `inbox:manage`
(admins) add, change or archive a shared one. A personal reply is its owner's alone: nobody else
lists, reads, changes or archives it, an admin included (it is "not found" to them), the
conventional design of shared inboxes. A viewer, who reads the inbox and does not work it, has
no saved replies. Whether a reply is shared is fixed when it is made.

**People only for writes.** `savedReply.create`, `.update` and `.archive` are `actors: ["human"]`
and off MCP. A saved reply is words the business sends in its name, perhaps many times, and an AI
caller reads inbound messages, which are attacker text; a reply an AI wrote must not become the
team's ready text without a person writing it. An AI caller may list saved replies and fill one
(both read-only), which step 6's drafts use as examples. (The spec's "draft a saved reply ...
saved as a draft" for an AI is step 6's to add, as a draft a person saves.)

**Fixed slots, filled by the host.** The words take only `{{person.firstName}}`,
`{{staff.firstName}}` and `{{business.name}}`. Any other `{{…}}`, and a half-written slot, is
refused when the reply is saved. `savedReply.fill` returns the words for one conversation the
caller may read (the private rule applies: a private conversation they may not read is not found),
filled from the conversation's Person's given name (else the first word of their name), the
caller's first name and the business's name (Settings → General); a slot with no value is left
empty and named in `missing`, so the screen tells the person to check the words. Filling at insert
lets the person read and edit the exact words before they send. No other field of any record
reaches a reply this way.

**Categories.** The admin's list (at most 50, each at most 40 characters, kept once each without
regard to case) is in `core_settings` under `inbox`, changed by `inbox.settings.update` (a human
admin, `inbox:manage`, off MCP, audited). `conversation.setCategory` (`inbox:work`) files a
conversation under one of them (stored in the admin's spelling) or none, and is refused for any
other name. A category taken off the list stays on the conversations filed under it until someone
changes them. Members file conversations but may not read the settings, so a new staff read,
**`inbox.categories`** (`inbox:read`), returns the list alone: an addition to the spec's
operations. The other settings the spec lists join the same value with the steps that read them
(step 2: addresses, the reopen window, the auto-acknowledgement; step 4: chat; step 5: reply
targets and opening hours), each with its default.

**The screens** are core admin screens, never pack screens: `/inbox` (mine, unassigned, all;
status, channel and category filters; paged), `/inbox/<id>` (messages and notes in order, as plain
text; the reply box with saved replies and the note box with mentions; take, assign, status,
category, private, link an unknown sender to a Person or make one, what it is about, the person's
other conversations; read again every 15 seconds, and every write carries the version it read),
`/inbox/saved-replies` and `/settings/inbox`, and a "Conversations" tab on a Person. They show only
what the operations return. A write made from an older read fails at commit as a conflict (the
stale guards of migrations 1050 and 1051 are now mapped to `conflict`, not an internal error).

**Every operation here is staff only** (none is open to customers or the public, ADR 0402), and a
runtime extension may not declare any of them (`savedReply.*` joins the inbox's refused names).

**Amended 2026-11-26 (review of PR #494, the follow-up PR):**

- *An AI only suggests a category.* `conversation.setCategory` from an assistant, MCP, an
  automation or an extension always waits for a person in Approvals (`alwaysReview`), whatever
  the preset: the spec's "suggest a category ... a person applies".
- *Making a Person from an unknown sender is one write.* `conversation.linkPerson` takes either
  `personId` or `newPerson` (names; the sender's address becomes their email) and makes the Person
  and the link in one batch, refused whole, so the screen never leaves a Person made and unlinked,
  and pressing again makes no second one.
- *The screens follow the host's permissions.* Whether an account reads or works the inbox is the
  session's `inbox:read` and `inbox:work` as the host decides them (not the role); an account
  without them sees a plain "no access" page. The conversation page's thread, reply box and
  person panel are keyed by the conversation, so nothing typed or read on one shows on the next.
- *The development route.* `/gatekeeper/fake/inbox` (cos-runner) is gated at run time by
  `INTEGRATIONS_FAKE_PROVIDER`, as `/gatekeeper/fake/cron` is; it has no authentication and is not
  compiled out of the bundle: with the flag on (development and e2e only, never a deployment)
  anyone who reaches the server can write conversations through it.

## Consequences

- Sending is not in these screens until `message.send` exists (step 2, and step 4 for chat): the
  reply box holds the words and its Send button is off. "Due soon" waits for reply targets
  (step 5), "Draft with AI" for step 6, choosing what a conversation is about for step 9's
  declarations (the screen shows and clears it).
- Drafts (one per conversation per staff user, step 6) are not in migration 1051, which the
  spec expected to hold them: step 6 takes its own number in block BI.
- The audit log records a saved reply's title, channels, whether it is shared and archived, and
  that its words changed, never its words.
