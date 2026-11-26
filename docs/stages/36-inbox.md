# Stage 36: Shared inbox, Messaging and Help desk

Read first: [`AGENTS.md`](../../AGENTS.md), [`CONTEXT.md`](../../CONTEXT.md) (Activity,
Notification, Gatekeeper, Connection, Outbound action, Host mail, Routine mail, Value mark,
Customer, Audience, Guardian and Dependant, Pack role, Permission grant, Erase),
[`docs/architecture.md`](../architecture.md); ADRs
[0051](../adr/0051-outbound-approvals.md), [0111](../adr/0111-outbound-actions-in-the-approval-queue.md),
[0112](../adr/0112-email-calendar-sync-service.md), [0132](../adr/0132-notifications.md),
[0172](../adr/0172-notification-delivery.md), [0238](../adr/0238-outbound-message-placement.md),
[0242](../adr/0242-email-sending-and-sequences.md) (proposed),
[0243](../adr/0243-email-open-and-click-tracking.md) (proposed),
[0244](../adr/0244-visibility-enforced-at-one-seam.md),
[0246](../adr/0246-leads-as-an-extension-and-assignment-rules-in-core.md),
[0320](../adr/0320-erase-reaches-every-store.md), [0402](../adr/0402-staff-and-customers.md),
[0449](../adr/0449-permissions-granted-one-by-one.md),
[0456](../adr/0456-the-hosts-sign-in-mail.md), [0540](../adr/0540-the-family-link.md),
[0570](../adr/0570-date-relative-triggers-in-minutes.md),
[0572](../adr/0572-bookings-messages-the-dashboard-and-the-coachs-app-screen.md) and
[0590](../adr/0590-routine-mail.md); stages [13](13-email.md) (proposed),
[15](15-leads.md) (assignment rules) and [47](47-pack-screens.md) (pack screens); stage 48 (My
account, spec on PR #311, branch `docs/stage-48-my-account`).

Status: **spec agreed** (2026-11-24). The interview was not needed: every question in it was
decided at its recommended answer under the owner's standing rule that best-practice answers are
decided, not asked (decisions 1 to 10 below; any of them may be overridden). Roadmap stage 36,
issue [#104](https://github.com/timoconnellaus/composable-os/issues/104). **36a** (the inbox: email
and chat, steps 1 to 6, 9 and 10) may start now. **36b** (campaigns and texts, steps 7 and 8) waits
for stage 30, Notifications (not yet specced), for what is listed under "What this stage needs from
stage 30".

## Status

- **Step 1** — built — PR #381 — Conversations and messages (branch `feat/stage-36-conversations`; migrations 1050
  and 1430, ADR 0740): `core_conversation` with its version guard; `core_activity` rebuilt with the type
  `chat` and `conversation_id`, its links, triggers and views kept, and private conversations left
  out of search and the `rec_*` views; `packages/core/src/inbox/` (the private-conversation rule
  every read path takes, the host's message writer `messageStatements` for steps 2 and 4, erase);
  the operations `inbox.list`, `conversation.get`, `.take`, `.assign`, `.setStatus`, `.setAbout`,
  `.setPrivate`, `.linkPerson` and `message.note`; permissions `inbox:read`, `inbox:work`,
  `inbox:manage`; notice types `inbox.assigned`, `inbox.reply`, `inbox.mention`, `inbox.due`;
  embeddings and summaries skip private conversations; erase and the Trash purge delete a Person's
  conversations, a merge moves them. Left to later steps: `message.send` and `conversation.start`
  (steps 2 and 4), `.setCategory` with Settings → Inbox (step 3), `.snooze` (step 5), migration
  1051 (saved replies and drafts, steps 3 and 6), "make a Person" inside `linkPerson` (a
  `person.create` first, for now).
  After review (PR #381): a private mark deletes the summaries built from the conversation;
  notices name the Person and the channel only; runtime extensions may not declare inbox
  operations; erase also takes unknown-sender conversations from the Person's addresses; the list
  walks a sort index; a note is version-guarded. The "due soon" view waits for reply targets
  (step 5).
  After merging stage 56's note levels (migrations 1230 and 1232, which also change
  `core_activity`): the rebuild moved out of 1050 into migration 1430, outside block BI, so it
  sorts after them and carries their columns, triggers and `level = 'staff'` tests forward. A
  rebuild numbered 1050 lost the private rule on a fresh database and a note's level on a host
  that already had 1230. Migration 1061, reserved for 36b's `text` rebuild, can no longer be used
  for it: that rebuild sorts after 1430.

- **Step 2** — not built — needs: step 1 — Email in and out: the inbound hook, sender checks,
  threading, unknown senders, replies via email-send, auto-acknowledgement

- **Step 3** — built — PR #494 — The web inbox screens, saved replies, Settings → Inbox (migration
  1051, ADR 0749): `/inbox` (mine, unassigned, all; status, channel and category filters),
  `/inbox/<id>` (messages and notes as text, the reply and note boxes, take, assign, status,
  category, private, link or make a Person, about, other conversations), `/inbox/saved-replies`,
  `/settings/inbox` (the categories) and a Person's Conversations tab; `core_saved_reply` and
  `savedReply.list`, `.create`, `.update`, `.archive`, `.fill` (own or shared, fixed slots the
  host fills, written by a person only), `inbox.settings.get` and `.update`, `inbox.categories`,
  `conversation.setCategory`; the stale guards are conflicts. Left: Send waits for `message.send`
  (steps 2 and 4), "due soon" and the other settings for steps 2, 4 and 5, "Draft with AI" and
  drafts for step 6 (its own migration, not 1051), choosing "about" for step 9.
  After review (PR #501): the conversation page keys its thread, reply box and person panel by
  the conversation (nothing typed or read on one shows on the next); "make a Person" is one host
  write (`conversation.linkPerson` with `newPerson`); an AI caller's `conversation.setCategory`
  always waits for a person; the screens follow the host's `inbox:read` and `inbox:work`, with a
  plain no-access page; the e2e checks the full email as text.

- **Step 4** — not built — needs: step 1 — Chat for customers: `chat.*`, web and native blocks,
  the Messages section and `message_unread`

- **Step 5** — not built — needs: step 1 — Reply targets, opening hours, snooze, assignment rules
  for conversations

- **Step 6** — not built — needs: step 1 — AI: the `compose` role, drafts, summaries, suggestions,
  judge warnings

- **Step 7** — not built — needs: step 2, stage 30 step 5 — 36b Campaigns: records, preview, the
  send Workflow, `email.campaign`, report

- **Step 8** — not built — needs: stage 30 step 3, stage 30 step 5 — 36b Texts: inbound and
  outbound on conversations, STOP (decided 2026-11-25: this step builds inbound texts on stage 30's text gatekeeper;
  stage 30 left two-way texting to this stage)

- **Step 9** — not built — needs: step 3 — The staff native inbox; "about" declared by Bookings,
  Memberships and Leads

- **Step 10** — not built — needs: step 2, step 3, step 4, step 5, step 6, step 9 — E2E journeys,
  the site and `SITE.md` (last for 36a; again after 36b)

## Goal

A business answers everyone who writes to it from one place. Email to its own address and chat
from its signed-in members (on its website and in its app) arrive in one shared inbox, one
conversation per person and topic, on that person's timeline. Staff take a conversation, hand it
to a colleague, leave notes only staff see, reply with saved replies or with a draft an AI wrote
when asked and a person checked, and close it. Each conversation has a status and a reply target
counted in opening hours, so nothing is forgotten over a weekend. Once the inbox is in use, the
business can send one message to a filtered list of people (a campaign), email first and texts
later, only to people who agreed to hear news and offers, each with a working unsubscribe, and their
replies land back in the inbox. Text messages join the inbox as a channel at the same time. An AI
drafts, summarises and suggests; a person sends.

## Who it is for

**Gyms and studios first.** Members ask about bookings, freezes, cancellations, payments and
injuries by email and, once the app has it, chat. Parents write about their children. Several
people cover the front desk in shifts, so a conversation must be visible to whoever is on, with who
took it and what was said. Campaigns cover a timetable change, a closure, a new class or an offer
to past members. What is specific: members are signed-in customers, so chat is available in the
app; a guardian writes about a dependant (ADR 0540); health details can appear in a message.

**Trades and services next.** Texts matter more than chat: customers text a mobile number, send
photos of the job, and expect "on my way" texts. A first message is often an enquiry from someone
not yet in the records, which becomes a lead (stage 15) and later a job or a quote (stages 39 and
35), so a conversation links to the record it is about. Out-of-hours enquiries are common, so the
auto-acknowledgement and reply targets counted in opening hours matter. Texts arrive with 36b.

## What exists today (from the code, checked 2026-11-24)

- **Activities.** `core_activity` (migration `0004_activities_tasks.sql`) has a `type` column
  checked to `note`, `email`, `call`, `meeting`, `system` (`ACTIVITY_TYPES` in
  `packages/core/src/operations/activity.ts`). Adding `text` and `chat` means remaking the table's
  check (SQLite cannot alter a check), with the search triggers and the `rec_*` views that read it
  (migrations `0111_email_calendar_sync.sql`, `0380_rec_views.sql`). `private_to` (migration 0111)
  hides one activity from everyone but one user: it is left out of search and the `rec_*` views.
  Email activities carry `external_key` (`email:<Message-ID>`, unique), `thread_key` and
  `body_ref` (the body in R2).
- **Email by sync.** `sync.ingest` (`packages/core/src/sync/ingest.ts`) writes email activities
  from a connected mailbox: people matched by address, dedupe across mailboxes, threading from
  References and In-Reply-To, sharing levels, bodies in R2, automated senders ignored
  (`isAutomatedAddress`, `packages/core/src/sync/signals.ts`), an erased address suppressed. The
  sync service reads mailboxes in alarm chains (`apps/runner/src/integrations/sync.ts`): minutes
  late, not a live inbox.
- **Inbound email gatekeeper.** `packages/gatekeeper-email` (`cos-gatekeeper-email`, vendored,
  `UPSTREAM.md`): an Email Worker that Email Routing delivers to; it parses the message and calls
  the hook bound to the address's local part (`EmailHook.receiveEmail`,
  `packages/gatekeeper-email/src/email.ts`). **Nothing in the host binds a hook to it today**, and
  it reads no sender-authentication results. It cannot send.
- **Outgoing email.** `packages/gatekeeper-email-send` (`cos-gatekeeper-email-send`) sends from
  sender addresses on allowed domains; every send is an outbound action of a kind: `email.send`,
  `email.internal`, `email.signin` (ADR 0456), `email.routine` (ADR 0590) and `email.agreement`.
  Its transport (`src/transport.ts`) carries from, to, cc, bcc, subject, text, html, reply-to and
  attachments: **no In-Reply-To, References or List-Unsubscribe header.**
- **The approval gate** (ADRs 0051, 0111): a human's own send is never queued; an AI's or an
  automation's waits for a person under Balanced. `outbound.message` (ADR 0238) reads a
  model-written message and turns a finding into a review.
- **Routine mail** (ADR 0590, `packages/core/src/routine-mail/`, `packages/sdk/src/routine-mail.ts`)
  and **host mail** (sign-in codes, agreement copies): one-way mail the host sends. No unsubscribe
  and no contact preferences exist anywhere (ADR 0572).
- **Staff notifications** (`packages/core/src/notifications/`, ADRs 0132, 0172, 0206): a closed
  list of types (`types.ts`), in the app's bell and routed to email or a chat connection. Nothing for customers.
- **Model roles** (`packages/core/src/ai/roles.ts`): `summarise`, `extract`, `classify`, `review`
  and others; **no `compose`** (proposed by ADR 0242, stage 13, not built).
- **People's phones** (`core_person_phones.number_normalised`, indexed, migration 0003): enough
  to match an inbound text later.
- **Assignment rules** (`packages/core/src/assignment/`, ADR 0246): round robin and field rules
  with a fallback owner, used by Leads.
- **Permissions** (`packages/core/src/principals.ts`): roles `admin`, `member`, `viewer`; grantable
  core permissions (ADR 0449), with `agreements:health` as the precedent for sensitive reads.
- **Built and used here:** customers, audiences and the visibility seam (stage 22, ADR 0244), the
  typed client (stage 23), blocks (stage 24), the family link (ADR 0540), date-relative triggers in
  minutes (ADR 0570), rich text (stage 28), saved views of people.
- **Issues:** #104 (this stage), #98 (stage 30, Notifications), #116 (push to client apps), #145
  (chat between a coach and a client, left out of stage 41).

## Decided at the interview (2026-11-24)

No interview was held: each question was decided at its recommended answer under the owner's
standing rule, and is open to override.

| # | Decision |
| --- | --- |
| 1 | **How people get in touch today and who answers** is not asked: the spec's picture (email busiest, the front desk answering in shifts, parents writing about children) stands, to be checked with the business during setup |
| 2 | **The first version takes email to the business's address, and chat from signed-in members** in its app and on its website. Texts come later (with 36b) |
| 3 | **Email reaches the inbox by forwarding**: the business keeps its current mailbox and forwards a copy of everything sent to its main address; replies go out from that same address |
| 4 | **Who reads conversations: everyone on staff who uses the admin**, except a conversation marked **private**, which only admins and whoever has it see. *A sensitive-access default (health and family matters arrive in messages), open to override* |
| 5 | **Coaches do not get handed conversations** in this version: pack-role accounts (a coach, the door, a cleaner) see no part of the inbox. Coaches answering their own clients can follow (issue #145) |
| 6 | **Reply targets are counted only in the business's opening hours** |
| 7 | **Campaigns come after the inbox is in use**, by email first and by text later |
| 8 | **Who may send a campaign: admins, and anyone an admin gives the permission to** |
| 9 | **Consent at joining** is not asked: the business's existing record of who agreed to news and offers is brought in during setup, where it has one; the spec assumes nothing about it |
| 10 | **The AI writes a draft reply only when a staff member presses "Draft with AI"**, never on its own |

## The design in one page

- **A conversation is a core record; its messages are activities.** `core_conversation` holds the
  person, the channel, the subject, the status, who has it, what it is about (any record), whether
  it is private, and its reply times. Each message in or out is an Activity on the person's
  timeline (types `email`, `chat`, later `text`), pointing at its conversation; a staff note is an
  Activity of type `note` on the conversation. Search, embeddings, summaries, the Trash and erase
  already work on activities.
- **The inbox is platform, not a pack.** Messages arrive from gatekeepers through host code; reply
  times are set when a reply is written; a pack cannot hook writes. So the inbox and campaigns are
  core, with core admin screens. Packs only link to it: a pack declares that its records can be
  what a conversation is about (a booking, a membership, a lead).
- **Email (decision 3).** The business forwards a copy of its main address's mail to its inbox
  address on the host's domain, routed to the inbound gatekeeper; it arrives within seconds.
  Replies go out from the business's main address through email-send with threading headers and a
  Reply-To of the inbox address, so the customer's answer comes straight back. Connecting a
  mailbox by sync stays later.
- **Chat (decision 2).** Signed-in customers write on the website and in the app through new
  customer operations. The open chat screen asks for new messages every few seconds; a closed app
  is told by push once stage 30 has it, until then by a contentless email.
- **Threading.** Email by In-Reply-To and References against the Message-IDs the host sent, then a
  reply token in the Reply-To address; else a new conversation. Chat is one open conversation per
  customer at a time.
- **Unknown and unverified senders.** A message from an address that matches no Person makes a
  conversation marked "unknown sender"; staff link it to a Person, make a Person, or (with Leads)
  make a lead. Nothing is created automatically. A message whose sender check fails is matched but
  marked "unverified sender"; a reply still goes only to the Person's own address.
- **Working as a team.** Take, assign to a staff member, new conversations shared out by the
  existing assignment rules, notes with mentions, snooze until a time, waiting on them, close,
  reopen on a new message. Staff are told through new host-written notification types.
- **Who sees (decisions 4 and 5).** Every admin, member and viewer reads the inbox; members and
  admins work it. A private conversation is seen only by admins and its assignee, and its messages
  leave search, the `rec_*` views, embeddings and the assistant for everyone else. Pack-role
  accounts see nothing of it.
- **Saved replies**: shared or personal, with a few fixed slots (the person's first name, the staff
  member's first name, the business's name), never free merge fields.
- **Reply targets (decision 6)**: "first reply within" and "next reply within", set by an admin per
  channel, counted in opening hours; the host keeps each conversation's due time; the inbox sorts
  by it; whoever has it is told before it passes.
- **Auto-acknowledgement**: an optional fixed email "we have your message", host mail, once per
  person per day, never to an automated sender, off until an admin turns it on.
- **AI (decision 10)**: on "Draft with AI" it drafts a reply into the reply box; a person edits and
  sends. It can also summarise a long conversation and suggest a category and who should take it.
  It never sends, schedules, closes, changes consent or picks a campaign's audience.
- **Campaigns (36b; decisions 7 and 8)**: a person with `campaigns:send` writes one email, picks a
  saved view of people, sees how many will get it and how many are left out and why (no consent,
  unsubscribed, no address, bounced), and sends or schedules it. The host sends in a Workflow,
  checks consent again at the moment of each send, adds the unsubscribe link and header, and logs
  each outcome. Replies come back to the inbox. Texts follow.
- **Customers see it in My account** (stage 48): "Messages" is a base section of the account shell,
  and an unread staff reply is the `message_unread` attention kind. No separate customer area.

### Divided from Notifications (stage 30)

Stage 30 is **one-way**: messages the host or a pack composes to a person (reminders,
confirmations, alerts), a person's preferences for them, a text gatekeeper and push. Stage 36 is
**two-way**: conversations a person writes and a person answers, as a team, and campaigns a person
writes. Notifications go out; anything that comes back lands in the inbox. Consent to be contacted
and unsubscribe are **stage 30's** (the shared piece, used by Journeys, Inbox and Reviews); this
stage uses them and does not define them.

### What this stage needs from stage 30

Stage 30 is not yet specced. 36a needs none of it. 36b needs these, specced and built in stage 30
(or as its first steps):

1. **Consent per channel and purpose**: per Person, per channel (email, text), a "news and offers"
   purpose distinct from service messages, with where each consent came from and when, readable by
   the host in one statement per batch of recipients, and a way for staff to record consent given
   on paper or by phone. A campaign is "news and offers"; a reply in a conversation is service.
   Bringing in a business's existing consent records at setup (decision 9).
2. **Unsubscribe**: the public one-tap stop with a signed token, able to turn off "news and offers"
   on a channel (not only a routine kind), and the List-Unsubscribe header's one-click endpoint;
   the suppression list of hashed addresses and numbers kept after erase.
3. **The text gatekeeper, two-way**: sending a person's reply on a conversation (not only routine
   texts), receiving inbound texts as verified events handed to a host hook, STOP and START
   recorded in the consent register, the cost limit applied to inbox and campaign texts.
4. **Push to the business's app** (#116), for a staff reply in chat.
5. **Email-send headers**: In-Reply-To, References, a host-chosen Reply-To and List-Unsubscribe,
   each set only by host code (no extension sets them). 36a step 2 builds the threading headers
   if stage 30 has not; whichever goes first builds them, once.

### What was weighed and rejected

- **A Help desk pack with its own support request object.** A request separate from its
  conversation doubles the work (two things to close) and still needs the host to set reply times.
  The conversation is the support request; its status, category and target are the help desk.
- **Replying through each staff member's own mailbox** (stage 13's path). A shared inbox replies as
  the business, and desk staff often have no mailbox of their own. Stage 13 stays the path for a
  salesperson's own email.
- **Connecting the business's mailbox by sync as the way in.** It reads the whole mailbox
  (personal mail included), needs an account connection and arrives minutes late. Forwarding is
  immediate and carries only what is meant for the inbox.
- **A new address used only for the inbox.** Customers already write to the business's address;
  forwarding changes nothing for them.
- **Realtime chat over a socket.** Realtime is on the platform's "Later" list. Asking every few
  seconds is enough for a desk; revisit with realtime.
- **An AI that drafts every message** or **replies on its own.** Drafting every message costs AI
  usage on one-line answers and a ready draft is easier to send unread; an AI's text going out in
  the business's name is the risk ADR 0238 exists for.
- **Free merge fields in saved replies and campaigns.** Any field of any record in a message is a
  way to leak what a reader should not see; fixed slots cover what is needed.
- **Reply targets around the clock.** A message at 10pm on Saturday should not be late on Sunday
  morning when nobody is in. A business open all hours sets its opening hours to every hour.
- **A second person approving each campaign.** Keeping `campaigns:send` to people an admin trusts
  avoids a second step every time (decision 8).

## Platform work and pack work

| Piece | Kind | Notes |
| --- | --- | --- |
| `core_conversation`, activity types `chat` (and `text` in 36b), the conversation link on activities | **Platform** (migration) | Remakes `core_activity`'s type check with its triggers and views |
| Inbox operations, notes, private conversations, saved replies, drafts | **Platform** | `packages/core/src/inbox/` |
| Inbound email hook bound to the host; sender checks | **Platform** (gatekeeper wiring) | Local change to the vendored gatekeeper noted in `UPSTREAMS.md` |
| Email-send threading and Reply-To headers | **Platform** (gatekeeper) | Shared with stage 30; built once |
| Reply targets, opening hours, snooze | **Platform** | The runner's minute tick moves due and snoozed conversations |
| Assignment rules for conversations | **Platform** | Extends `assignment/` beyond Leads (ADR 0246) |
| New staff notification types | **Platform** | `notifications/types.ts`, host-written |
| Customer chat operations | **Platform**, reviewed change | ADR 0402 |
| The Messages section and the `message_unread` attention kind | **Platform** (stage 48's shell) | A base section, as Orders is |
| `compose` model role; drafts with value marks | **Platform** | Shared with stage 13; built once |
| "About" declaration in a pack's manifest | **Platform** (manifest key) | Packs opt in |
| Inbox, conversation, saved replies, campaign and settings screens | **Platform** (core admin screens) | Not pack screens |
| Chat blocks (web and native) and the staff native inbox | **Base-layer blocks** in `blocks/` | Over a headless hook and the typed client |
| Campaigns and their send Workflow, `email.campaign` | **Platform** (36b) | Needs stage 30's consent and unsubscribe |
| Texts on conversations | **Platform** (36b) | Needs stage 30's two-way text gatekeeper |
| Bookings, Memberships and Leads declaring "about" | **Pack work**, one line each | After the key exists |

## The model

### Words

- **Inbox**: the shared list of conversations. (Leads' list of new leads is "the leads list" in this
  spec, to keep the words apart.)
- **Conversation**: one exchange with one person on one channel, with its status and who has it.
- **Message**: one email, chat message or text in a conversation, in or out.
- **Note**: a staff-only message on a conversation, never sent.
- **Private conversation**: one only admins and its assignee see.
- **Reply target**: how long, in opening hours, the business means to take to reply.
- **Campaign**: one message a person sends to a saved view of people.

### Records

- **Conversation** (`core_conversation`): person (nullable while unknown), the unknown sender's
  address (hashed and cleared once linked), channel (`email`, `chat`; `text` in 36b), the inbox
  address it came to, subject, status, assignee, category (an admin's list), about (object and id,
  nullable), private (with who marked it and when), sender unverified, opened at, last inbound at,
  last reply at, first reply at, reply due at, snoozed until, closed at, closed by. Indexes for the
  inbox's hot queries: (status, reply due at), (assignee, status), (person, last inbound at).
- **Message**: an Activity with `conversation_id`, direction, channel, author (a staff user, the
  customer, or the host for an auto-acknowledgement), `external_key` (`email:<Message-ID>`,
  `chat:<id>`; `text:<provider id>` in 36b), delivery status (queued, sent, delivered, failed,
  bounced), attachments (R2, size and type capped). The body in R2 as synced mail at full sharing;
  a snippet in D1.
- **Draft**: one per conversation per staff user, with its text's value mark (a person or an AI),
  so an AI-written draft is shown as such until a person edits it.
- **Saved reply** (`core_saved_reply`): title, body, which channels it fits, owner (personal) or
  shared, slots used, archived.
- **Inbox settings** (`core_settings`, key `inbox`): the inbox address and the address replies go
  from, categories, reply targets per channel, opening hours, closed dates and the time zone (the
  business's), the reopen window, auto-acknowledgement on or off and its words (fixed slots only),
  chat on or off.
- **Campaign** (36b, `core_campaign`): name, channel, subject, body (rich text, fixed slots),
  audience (a saved view of people), status, scheduled at, sent by, sent at, counts. **Campaign
  recipient** (`core_campaign_recipient`): campaign, person, address used, outcome (sent, skipped
  and why, failed, bounced, unsubscribed), message id; unique per person per campaign.

### States

- Conversation: `open` → `waiting` (on them) → `open` on their reply; `open` or `waiting` →
  `closed`; `closed` → `open` on a new inbound message or by staff. `snoozed until` hides it from
  the open list until the time, then the minute tick brings it back (a host move). A new inbound
  message on a conversation closed longer than the reopen window (default 14 days) starts a new
  conversation.
- Campaign: `draft` → `scheduled` → `sending` → `sent`; `draft` or `scheduled` → `cancelled`;
  `sending` → `stopped` by a person (what was sent stays sent).

### Operations

| Operation | Audience | Who may | Risk |
| --- | --- | --- | --- |
| `inbox.list` (mine, unassigned, all, due soon; channel, status, category) | staff | `inbox:read` | read |
| `conversation.get` (messages, notes, about, the person's other conversations) | staff | `inbox:read` | read |
| `conversation.take`, `conversation.assign` | staff | `inbox:work` | write |
| `conversation.setStatus`, `.snooze`, `.setCategory`, `.setAbout` | staff | `inbox:work` | write |
| `conversation.setPrivate` (mark private; unmark: admins and the assignee) | staff | `inbox:work`, a person only | write |
| `conversation.linkPerson` (an unknown sender to a Person, or a new one) | staff | `inbox:work` + `records:write`, a person only | write |
| `conversation.start` (a new conversation to a Person on a channel) | staff | `inbox:work`, a person only | outbound |
| `message.send` (reply on the conversation's channel) | staff | `inbox:work`, a person only | outbound |
| `message.note` (with mentions) | staff | `inbox:work` | write |
| `draft.save`, `draft.get` | staff | `inbox:work`; an AI may save | write |
| `draft.compose` ("Draft with AI") | staff | `inbox:work` | write (AI) |
| `savedReply.list` / `create` / `update` / `archive` | staff | `inbox:work`; shared ones `inbox:manage` | write |
| `inbox.settings.get` / `update` | staff | `inbox:manage`, human admin only, not on MCP | write |
| `chat.mine` (my chat conversations and messages) | **customer** | own records only | read |
| `chat.send` (write in my open chat, or start one) | **customer** | own records only, rate-limited | write |
| `chat.markRead` | **customer** | own records only | write |
| `inbound.email`, `delivery.update` | host-internal | the integration host | write |
| `campaign.create` / `update` / `preview` / `get` / `list` / `report` (36b) | staff | `campaigns:write` | write / read |
| `campaign.send`, `.schedule`, `.stop` (36b) | staff | `campaigns:send`, a person only, not on MCP | outbound |
| `inbound.text` (36b) | host-internal | the integration host | write |

Consent reads and writes are stage 30's operations; the conversation's person panel shows them.

Opening `chat.*` to customers is a reviewed change (ADR 0402). A guardian writes as themselves;
about a dependant they choose the child as what it is about, read through the guardian scope. No
operation is opened to the public in this stage.

**Permissions** (core, in `principals.ts`): `inbox:read` (admin, member, viewer), `inbox:work`
(admin, member), `inbox:manage` (admin), `campaigns:write` (admin; grantable), `campaigns:send`
(admin; grantable, ADR 0449). Pack roles hold none and none is grantable to a pack-role account in
this stage (decision 5).

### Rules the host keeps

- `message.send` goes out on the conversation's channel only, from the inbox's own address, to the
  conversation's Person's address, never to an address typed in the box. A reply to a hard-bounced
  address is refused with the reason shown; a text (36b) to a number that sent STOP is refused.
- A reply's text is the person's: an AI draft not edited is sent only after the person presses send
  on a screen that labels it "drafted by AI". The send is the person's own action (ADR 0111), so it
  is not queued.
- Private: a private conversation and its messages are returned only to admins and its assignee,
  in every read path (lists, the timeline, search, `rec_*` views, embeddings, the assistant, MCP).
  Reassigning it moves who sees it; an audit entry records every mark and unmark.
- Auto-acknowledgement: at most one per Person or address a day, never to an automated sender,
  never in reply to an auto-acknowledgement or bounce, words from settings with fixed slots.
- Every inbound message is untrusted data: shown as text, links not followed by the host,
  attachments served as downloads, never rendered as HTML in the admin.
- Campaigns (36b): consent is checked per recipient at the moment each message goes, not only at
  preview; the unsubscribe link and header are the host's; one message per person per campaign; a
  daily cap per channel set by an admin; the email-send rails apply.

### Tools and AI

- **May:** `draft.compose` with the `compose` role (the conversation, the person's summary facts,
  saved replies as examples, never notes or other conversations); summarise a conversation
  (`summarise`); suggest a category and an assignee (`classify`), shown as suggestions a person
  applies; draft a saved reply or a campaign's text, saved as a draft.
- **Checked:** each AI draft is read by `outbound.message` (ADR 0238) before it is shown, and a
  finding ("promises something nothing supports") is shown as a warning beside the draft.
- **May not:** send or start a conversation, send, schedule or stop a campaign, choose or change a
  campaign's audience, change consent, change inbox settings, close a conversation, mark or unmark
  private, link an unknown sender to a Person. The assistant and MCP act as the user and see only
  what the user may see.
- Inbound text is data to the model, never instructions: the draft prompt marks it as such, and a
  draft holding a link not in a saved reply or the business's site is flagged.

### Screens

- **Web admin (core screens):** Inbox (mine, unassigned, all, due soon; filters), a conversation
  (messages and notes in order, the reply box with channel, saved replies, "Draft with AI", the
  person's panel with their bookings or memberships through "about"), Saved replies, Settings →
  Inbox, and in 36b Campaigns (write, audience and counts, preview, send or schedule, report). A
  Person's timeline shows their messages and a "Conversations" tab.
- **Native, staff:** the inbox and a conversation with reply, for desk staff on a tablet or phone,
  as base-layer native blocks over the same headless logic as the web.
- **Customer web and native (My account, stage 48):** the "Messages" section: the member's chat,
  start a message, choose what it is about (their booking, their child), read state; and the
  `message_unread` attention item. Not their email: that stays in their own mail app.

### Notifications

- **Staff (new host-written types):** `inbox.assigned` (given to you), `inbox.reply` (someone
  replied on a conversation you have), `inbox.mention` (a note mentions you), `inbox.due` (a reply
  target is near and you have it; or nobody has it: the admins), and in 36b `campaign.finished`.
  Routed by the existing preferences.
- **Customer:** a staff reply in chat is pushed to the app once stage 30 has push; until then a
  contentless email "you have a new message, sign in to read it", at most one an hour.

### Privacy and erase

- Who sees: decision 4 and the rule above. Customers see only their own chat conversations'
  messages and staff first names, never notes, categories, private marks or assignees' details.
- Audited: every send, assignment, status change, private mark, settings change, and in 36b every
  campaign send and stop, with who; message bodies are not copied into the audit log.
- Kept: message bodies under the deployment's activity retention; campaign recipient rows for an
  admin-set period (default 2 years), then their counts only.
- Erase: a Person's erase deletes their conversations, messages and their bodies in R2, drafts and
  campaign recipient rows, and keeps only a hash of their addresses in the erase log (ADR 0320), so
  a later campaign never mails them and an inbound message from them starts as "unknown sender".
- What the business must keep, may send and to whom (consent records, sender identification, times
  for texts) is for the business to confirm with its accountant or lawyer.

## Out of scope

- Texts and campaigns in 36a (they are 36b, after stage 30).
- A chat widget for visitors who are not signed in (needs stage 29's public writes); messenger and
  social channels; phone calls and voicemail.
- Coaches or other pack-role accounts in the inbox; chat between a coach and a client (#145).
- An AI that answers customers on its own; chatbots; suggested help articles (stage 38).
- Case tracking across several conversations; satisfaction surveys (stage 29).
- Sequences, drip campaigns, open and click tracking (stage 13, ADR 0243).
- Live typing and presence (realtime, later); staff-to-staff chat; several brands in one inbox.
- Teams as assignees and team visibility (stage 14a).
- Connecting a mailbox by sync as a way in; moving old conversations in from another inbox tool.

## Acceptance criteria

36a:

1. An email forwarded to the inbox address from a known member's address appears in the inbox
   within a minute as an open conversation on that Person, and on their timeline.
2. A reply sent from the conversation reaches the member from the business's main address with
   threading headers; the member's answer joins the same conversation, and reopens it if closed
   within the reopen window; after it, a new conversation starts.
3. An email from an unknown address makes an "unknown sender" conversation and no Person; linking it
   to a Person moves it onto their timeline. A message failing the sender check is marked
   "unverified sender".
4. Two staff open the same conversation; one takes it; the other sees who has it; an assignment
   notifies the assignee in the app.
5. A note is never sent and never appears to the customer in `chat.mine` or in email.
6. A private conversation and its messages are absent for a member who does not have it in every
   read path (list, timeline, search, `rec_*` views, the assistant, MCP), and present for an admin
   and the assignee; a pack-role account reads nothing of the inbox (a test per path).
7. A signed-in member writes in chat on the web and in the app; staff reply; the member sees the
   reply and a `message_unread` item in My account; another customer cannot read or write that
   conversation (a test for each surface).
8. A guardian writes about their child and the conversation shows the child as what it is about; a
   guardian whose link has ended cannot choose the child.
9. `message.send`, `conversation.start`, `conversation.setPrivate` and `conversation.linkPerson`
   refuse an AI caller (assistant, MCP, automation, extension), and `message.send` refuses a
   recipient other than the conversation's Person.
10. "Draft with AI" fills the reply box with a draft labelled as AI-written; no draft is written
    without the press; nothing is sent until a person presses send; a draft with a promise nothing
    supports shows a warning.
11. A reply target of N hours sets the due time counted in opening hours (tested across a weekend
    and a closed date); the assignee is told before it passes; the first reply clears it.
12. Auto-acknowledgement goes once per person per day and never to an automated address or in answer
    to an auto-acknowledgement.
13. A Person's erase removes their conversations, messages, bodies in R2 and drafts; an inbound email
    from their address afterwards is "unknown sender".
14. Inbound HTML is never rendered as HTML in the admin; attachments over the cap are refused and
    noted.
15. Cost: the inbox's lists and a conversation's read are each a bounded number of statements
    (statement-count tests).
16. E2E: one journey each: reply to an email as a team; a member's chat.

36b:

17. A campaign to a saved view shows how many will receive it and how many are left out by reason; a
    person who unsubscribes between preview and send gets nothing; each email carries a working
    unsubscribe link and header; one row per recipient; a retry sends nothing twice; a campaign of
    5,000 runs in a Workflow without hitting a request's limits.
18. An AI caller cannot send, schedule or stop a campaign; a staff account without `campaigns:send`
    cannot either; an admin's grant lets it.
19. A text to the business's number from a known Person joins their open text conversation; STOP
    turns off news and offers by text and refuses further campaign texts.
20. A Person's erase removes their campaign rows; a later campaign skips their address.
21. E2E: a campaign with an unsubscribe.

Both: the site and `SITE.md` describe what is built, and only that.

## Dependencies

- **Stage 30, Notifications (not specced):** for 36b only, everything under "What this stage needs
  from stage 30". 36a does not wait.
- **Stage 48, My account (spec on PR #311):** the shell the Messages section and the
  `message_unread` kind sit in. Until it is built, step 4 ships the chat blocks and the attention
  kind's read, and the section is wired when the shell lands.
- **Stage 47, pack screens (spec agreed):** the inbox's admin screens are core, not pack screens,
  and do not wait for it.
- **Stage 13, Email from the CRM (proposed):** shares the `compose` role and threading headers;
  whichever builds first builds them. Saved replies are not stage 13's templates.
- **Stage 14a, Teams (proposed):** team assignment and team visibility come after it.
- **Built:** Leads (15, "make a lead" from an unknown sender, assignment rules), customers and
  audiences (22), the typed client (23), blocks (24), the family link (ADR 0540), routine mail
  (ADR 0590), staff notifications.

## Migrations and numbers

Block **BI** in [`parallel-work.md`](../parallel-work.md) (the coordinator adds the row):
migrations 1050–1069, ADRs 0740–0749. Expected migrations: 1050, `core_conversation` and the remade
`core_activity` type check (`chat` added) with its triggers and views, the conversation link and
the private-conversation exclusion; 1051, `core_saved_reply` and drafts; 1060, campaigns and their
recipients (36b); 1061, the `text` activity type (36b). No `x_*` table is touched.

ADRs the build writes:

1. Conversations as core records, messages as activities, private conversations and who reads the
   inbox (**ADR 0740**).
2. Email in by forwarding: the inbound hook bound to the host, threading, unknown and unverified
   senders (**ADR 0741**); amends ADR 0112 with a dated note.
3. Replies out from the business's address: threading and Reply-To headers, the auto-acknowledgement
   as host mail (**ADR 0742**); amends ADR 0111.
4. Customer chat: the `chat.*` customer operations, the Messages section and `message_unread`
   (**ADR 0743**); amends ADR 0402 (the reviewed opening).
5. Reply targets in opening hours, snooze and assignment rules for conversations (**ADR 0744**);
   amends ADR 0246.
6. The `compose` role and AI drafts with value marks and warnings (**ADR 0745**); amends ADR 0242
   (the role part) and ADR 0238.
7. The "about" declaration in a pack's manifest (**ADR 0746**).
8. Campaigns: records, the send Workflow, `email.campaign`, consent checked at send (**ADR 0747**,
   36b).
9. Texts on conversations (**ADR 0748**, 36b).

## Suggested build order

| Step | What | Files and areas | Beside |
| --- | --- | --- | --- |
| 1 | Conversations and messages: migration, operations, notes, private conversations, staff notification types, erase | `packages/db` migrations (`core_activity` remake), `packages/core/src/inbox/`, `principals.ts`, `notifications/types.ts`, `ai/embedding.ts`, `records/erase.ts` | First. Collides with anything in `records/erase.ts` (the erase row in `parallel-work.md`) and any migration that remakes or reads `core_activity` |
| 2 | Email in and out: the inbound hook, sender checks, threading, unknown senders, replies via email-send with headers, auto-acknowledgement | `packages/gatekeeper-email` (wiring, `UPSTREAMS.md`), `packages/gatekeeper-email-send`, `apps/runner/src/integrations/host.ts` | After 1. Collides with anything in the email gatekeepers (stage 30, stage 13, agreements' copies) |
| 3 | The web inbox screens, saved replies, Settings → Inbox | `apps/app` routes and components | After 1; beside 2, 4 and 5 |
| 4 | Chat for customers: `chat.*`, web and native blocks, the Messages section and `message_unread`, the contentless email notice | `packages/core` (customer operations, the visibility seam), `blocks/`, the typed client | After 1; beside 2 and 3. Collides with stage 48's build on the account shell and `me.attention` |
| 5 | Reply targets, opening hours, snooze, assignment rules for conversations | `packages/core/src/inbox/`, `packages/core/src/assignment/`, the runner's minute tick | After 1; beside 2 to 4. Collides with Leads work in `assignment/` |
| 6 | AI: the `compose` role, drafts with value marks, summaries, suggestions, judge warnings | `packages/core/src/ai/roles.ts`, `packages/core/src/judge/` | After 1; beside 2 to 5. Collides with stage 13 and any work on model roles |
| 7 | **36b** Campaigns: records, preview, the send Workflow, `email.campaign`, report | `packages/core/src/campaigns/`, `packages/gatekeeper-email-send` (kind, List-Unsubscribe), `apps/runner` | After stage 30's consent and unsubscribe, and after 2. Collides with stage 30 on email-send |
| 8 | **36b** Texts: inbound and outbound on conversations, STOP | `packages/core/src/inbox/`, stage 30's text gatekeeper | After stage 30's two-way text gatekeeper; beside 7 |
| 9 | The staff native inbox; "about" declared by Bookings, Memberships and Leads | `blocks/` (native), `packages/sdk/src/manifest.ts`, `packs/*/index.ts` | After 3. The manifest key collides with any `manifest.ts` change in flight |
| 10 | E2E journeys, the site and `SITE.md` | `apps/app/e2e`, `apps/marketing` | Last for 36a; again after 36b |

None of these touches `orders/`, `subscriptions/`, `pack-roles.ts` or `core_write_guard`.

## Size

**Large.** Split as **36a** (steps 1 to 6, 9 and 10: the inbox, email and chat) and **36b** (steps 7
and 8: campaigns and texts, after stage 30). After step 1, up to four 36a sessions at once (2, 3, 4
and 5, then 6).

## Decided by this spec, open to override

| Choice | Decision |
| --- | --- |
| Where it lives | The inbox and campaigns are platform (core), not a pack |
| A support request | The conversation is the support request; no separate record |
| Messages and notes | Activities on the timeline; notes are `note` activities on the conversation |
| The way in for email | Forwarding to the inbound gatekeeper; sync later (decision 3) |
| Chat | Signed-in customers only; the open screen asks every few seconds (about 5, slower when hidden); no realtime |
| Who sends | A person sends every reply and every campaign; an AI drafts only when asked (decision 10) |
| Saved replies and campaigns | Fixed slots only |
| Readers | Admins, members and viewers read; members and admins work; private for admins and the assignee. **Sensitive-access default** (decision 4) |
| Who marks private | Anyone working the inbox; unmarking by an admin or the assignee |
| Pack roles | No inbox access, and no inbox permission grantable to them (decision 5) |
| Campaign senders | Admins by default, others by grant; no second approver (decision 8) |
| Reply targets | Counted in opening hours with closed dates; "always open" is opening hours of every hour (decision 6) |
| The reopen window | 14 days; later, a new conversation |
| Unverified senders | Matched to the Person, marked "unverified sender"; replies still go only to the Person's own address |
| Service replies and preferences | A reply in a conversation is a service message: refused only to a hard-bounced address (or a number that sent STOP); news and offers consent applies to campaigns only |
| Auto-acknowledgement | Offered, off until an admin turns it on; by email only |
| Campaign channels | Email first; texts after stage 30's text gatekeeper (decision 7) |
| Customer surface | A section and an attention kind in My account (stage 48), not a separate area |

## Questions for the owner

None open. Decisions 1 to 10 were taken at their recommended answers; the owner may override any,
and decision 4 (who reads members' messages) is the one most worth a look.

## Risks

- **Security:** inbound email is attacker-controlled: HTML, links, attachments and text aimed at the
  AI. Rendering as text, download-only attachments, the judge on drafts and no AI send keep the
  damage to a bad draft a person reads. A forged From could plant a message on a member's timeline:
  the inbound gatekeeper reads no sender checks today; step 2 adds them, and forwarding often
  breaks the simplest check, so the build reads what the forwarding mailbox recorded where present.
  The customer chat operations are a new customer write: rate limits and per-surface tests.
- **Privacy:** health details and children's matters arrive in messages; decision 4 lets all admin
  staff read them except private conversations. Private must reach every read path, R2 bodies and
  the search index.
- **Money:** texts (36b) cost the business per message at its provider; stage 30's cost limit and
  the campaign's count before sending. Nothing charges a card.
- **Deliverability:** campaigns from the business's domain need its sender records set; a bad
  campaign can hurt the routine mail sent from the same domain. A separate sending address for
  campaigns may be needed.
- **Needs real verification:** forwarding from a business's existing mailbox on a real domain, push
  on a real phone (36b and stage 30), a campaign to a real list in test mode, and a real desk using
  the inbox for a week.
- **Law:** consent, unsubscribe, sender identification and texting hours are for the business to
  confirm with its accountant or lawyer.
