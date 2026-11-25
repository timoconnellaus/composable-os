# ADR 0678: Every sender asks the consent register

Status: accepted, 2026-11-26 (stage 30, a follow-up of build step 5: `feat/stage-30-consent-every-sender`,
block BB: migration 0916). Builds on ADRs [0675](0675-consent-to-be-contacted.md) (the register, the
suppression list, `contactDecision`, the stop link), [0051](0051-outbound-approvals.md) (outbound
actions and the gate), [0590](0590-routine-mail.md) (routine mail),
[0672](0672-the-text-gatekeeper.md) (the text gatekeeper), [0459](0459-anyone-starting-a-subscription.md)
(the mailbox an address reaches), [0692](0692-one-person-per-folded-address.md) (one Person per
folded address) and [0428](0428-buying-without-an-account.md) (whose an address is). Amended the
same day after the review of PR #469 (below, folded in).

## Context

Stage 30's spec says every sender asks the consent register at the moment of sending, and a
refusal is final. Step 5 (ADR 0675) built that for routine messages only. The review of PR #451
(finding F1) found that a direct call to the email-send gatekeeper (an automation's or a tool's
`ctx.gatekeeper("email-send")`, the assistant's Code Mode, an MCP client's `integration.call`,
extension code) never asked the register or the suppression list. Under the Autonomous preset the
assistant, MCP and automations get `outbound: auto`, so an automation or an AI could email someone
who had stopped, with no person in between; under the other presets the approver was not told. The
review of this ADR's first build (PR #469) found calendar invitations and connected MCP servers
passing unchecked, and a Gmail spelling with dots getting past a stop.

## Where the check is

**At the integration host's approval queue** (`apps/runner/src/integrations/queue.ts`), which every
caller's outbound action passes, whatever the gatekeeper. The rule is in core:
`packages/core/src/contact/senders.ts` (`checkSend`, `checkSends`, `mintStopLinks`),
`packages/core/src/integrations/sends.ts` (`peopleSendOf`: which kinds send to people, and to whom)
and `packages/core/src/integrations/consent.ts` (`contactAtSubmit`, `contactBlockedMany`,
`contactRefusedAudit`). A gatekeeper holds the queue; no pack, tool, extension or model does, so
none can skip it, and the approval presets do not reach it: `outbound: auto` never means "to
someone who stopped".

1. **Before queueing**, the email-send gatekeeper (and the fake outbox, the same module,
   `gatekeeper-email-send/src/consent.ts`) asks the queue (`contactCheck`) with every recipient and
   the purpose the caller declared. The host answers who may be sent to, which of them get a stop
   link, and how many were dropped; when nobody is left it refuses.
2. **As it is submitted**, the host decides by the gatekeeper's vendor and the action's kind
   whether the action sends to people, and reads its recipients from the description the approver
   sees (`peopleSendOf`). Recipients `contactCheck` allowed in that session keep its purpose; any
   other send is checked here with no purpose. A refusal is thrown, so the gatekeeper's journal
   drops it: never queued, applied or retried. **A sending kind whose recipients the host cannot
   all see is refused for anyone but a person** (fail closed).
3. **When a person approves one that waited**, the host asks again (`contactBlockedMany`, with how
   it was checked kept on the pending action as `contact`); a recipient who stopped meanwhile means
   nothing is sent, the action is skipped and dropped on its facet, and approving cannot override
   it. The inbox shows a human approver how many recipients cannot be contacted
   (`outbound.contactBlocked`), every action on the page read together. A send queued before this
   ADR carries no `contact`: it is checked by who sent it (a person's by the person's rule,
   anyone else's with no purpose), unless it is the host's own (origin `system`, a held routine
   message).

## What sends to people, and where its recipients are read

| Vendor | Kind | Recipients | Shape |
| --- | --- | --- | --- |
| `email-send` | every send but `email.internal` | `To`, `Cc`, `Bcc` | outbox: asks first, takes a purpose and stop links |
| `fake` (tests, development) | `fake.send` and the host's kinds | `To` | outbox, as email-send |
| `google` | Gmail send and draft send (no kind) | `To`, `Cc`, `Bcc` | mailbox: no purpose, no stop link |
| `google` | calendar create (`Send updates` not `none`) | the `Event` JSON's `attendees[].email`; none invited: no send | invitation |
| `google` | calendar update (`Send updates` not `none`) | only attendees it adds are listed; the ones it has are not | invitation, **incomplete**: a machine's is refused |
| `microsoft` | `outlook.send` | `To`, `Cc`, `Bcc` | mailbox |
| `microsoft` | `calendar.invitations` | `Invites`, `Told about the change`, `Told about the cancellation` | invitation |
| `microsoft` | `calendar.responses` | `Organizer` | invitation |
| `mcp` | every tool call submitted as an action | every email address and international number (+…) in its title, description and arguments | scan |

An email's recipients are always listed under `To`, `Cc` or `Bcc` by these gatekeepers: a
description with none of those fields is not one of their sends, and one whose fields hold no
address the host can read is a send it cannot see into, refused for anyone but a person.

**Exempt** (keyed by vendor and kind, never a bare tag): email-send's `email.internal` (the
gatekeeper checks every address is at `INTERNAL_DOMAINS`), the fake's `fake.internal` (every
address at the outbox's own domain), Gmail's `draftCreate`, `draftUpdate`, `draftDelete` and
Outlook's `outlook.drafts` (a draft sends nothing; the person sends it from their own mail app).

**The host's own mail, exempt as essential**: sign-in codes (`callAsHost sign-in`: the person asked
for it, it must never wait); an agreement's copy (`agreements`: evidence the person is owed, ADR
0645); an order's confirmation and the cooling-off summary (`orders`, `sendHostEmail` in
`orders/events.ts` and `subscriptions/cooling-off.ts`: receipts the service and the law require);
a phone check's code (`phone-check`: the member's own act, to their own number); staff notices by
email and the invite notice (host code calling with origin `system`: staff accounts about their own
work and access). Routine messages ask on their own path (ADR 0675: at prepare, at claim, at
approval; `stopHeldRoutineMessage` asks the suppression list even when the kind is gone).

**Not covered, and why**:
- **A connected server that addresses people by its own ids** (a contact id, a list, an audience):
  the host cannot see who it reaches. An admin who connects a messaging server (a mail, text or
  campaign provider) accepts that its tools can contact people the register does not see. So can
  a tool its server or an admin marks read-only (it is called as a read, never submitted), and an
  argument cut short in the description (only what is shown is scanned).
- **Webhooks** post to a URL, not a person; a webhook to a provider's API that sends messages is
  the same as such a server.
- **Slack and Google Chat** reach a staff workspace, not a channel of the register.
- **Push** is not built (step 4); its claim will ask as the text claim does.
- **The control plane's mail** (`products/crm/apps/control`) is the operator's to businesses,
  outside any host.

**Texts.** The text gatekeeper sends only the host's routine texts and phone checks (ADR 0672):
every caller's queue is refused there. A number in a connected server's tool call is checked as
above: a number that said STOP is never texted, whoever sends; a machine's naming a number a
Person holds is refused. No caller's text carries a stop link, so none goes with a purpose.

No shipped pack sends a member email but through routine mail: Bookings, Ticketing and Forms (its
receipt) declare routine kinds and call `ctx.routineMail.send`, never the gatekeeper themselves (the
email-send connection they declare is the one the host sends their routine mail from); Courses,
Memberships, Leads and Deals send no email (Leads and Deals notify staff with `ctx.notify`). The
CRM's email on a timeline logs an activity and sends nothing. So no pack's send changed.

## The rule for each sender

Decided as the conventional rule, and open to the owner's override:

- **A person on the staff** (actor `human`), with no purpose: their own message. Only what holds
  for the address whatever the message: the suppression list (a bounce, a complaint, a provider's
  unsubscribe, a STOP for a number). Not the per-kind or per-purpose choices: a member who stopped
  follow-ups still gets their coach's reply. This holds for a person's email to several people too;
  a person may declare a purpose to have it asked in full.
- **Anyone else** (an automation, a tool, the assistant, MCP, extension code): a `follow_up` or
  `news_and_offers` message, asked in full for each Person with the purpose it declares (a stop, an
  "off", no yes to news and offers). Declaring none, a send to any address or number a Person
  holds is refused; `account` is not theirs to declare (messages about a record a person has are
  routine mail). Only an outbox can take a purpose: a mailbox's, an invitation's or a server's
  refusal says what works instead (a draft for the person, one email to one person for them to
  approve, email-send with a purpose), never "add a purpose".
- **An AI's one-to-one email from a person's own mailbox is that person's own message once they
  approve it** (the coordinator's decision, 2026-11-26). The host checks, as it is submitted: the
  sender is the assistant or an MCP client (an automation, even with run-as, never is), the
  gatekeeper a mailbox (Gmail, Outlook), exactly one `To` and no `Cc` or `Bcc`, an address exactly
  one Person holds, no child, not suppressed. Then it **always waits for a person, under every
  preset** (as a held routine message does), and only **the owner of the mailbox it is sent from**
  can approve it; approving asks the suppression list and the child rule again. Anything applied
  without a person, or to more than one recipient, stays refused.
- **A child** (a Person with a live guardian link), as the spec has it: a person's own one-to-one
  message to a child's own address goes (a coach's reply to the member); a machine's message to it
  never; news and offers never; a person's message to several people that includes it leaves it
  out.
- **A send to several recipients with some who cannot be contacted** drops those and sends the
  rest, saying how many were dropped (the coordinator's decision: not the whole send refused).

**Matching an address to a Person**: the live People holding a live address that reaches the same
mailbox, by the key the suppression list hashes addresses by (`mailboxKey`, ADR 0459: case and a
`+tag` folded on every domain, and on gmail.com and googlemail.com the dots), through the seam
(`peopleAtAddresses` in `visibility/guardians.ts`, migration 0916's index over the same
expression); a number by the People holding it (`peopleAtNumbers`). One holder: their choices.
**None: only the suppression list applies**, except that news and offers, which need a yes nobody
could have given, are refused. **Several**: the address is no one's (ADR 0428's one-Person rule), so
a stoppable message to it is refused (no one stop link would stop it for each of them); a person's
own message goes. Open to override.

## What the sender, an AI and staff learn

A send to several leaves out who may not be contacted and goes to the rest; the receipt says only
how many (`dropped`). When none is left the answer is the one plain refusal, the same for a stop,
an "off", no yes, a suppression or a child: `Refused: recipient_stopped. The recipient cannot be
contacted this way; nothing was sent or queued.`

**Refusals are recorded**: each writes an audit row (`contact.refused`) naming who sent it (the
actor, the user, the origin: an automation, a tool, the assistant's thread, an MCP client), through
which connection and vendor, the channel and how many cannot be contacted, never who or why.
`audit.list` shows it to people only, as the adjudicator's verdicts. **An AI cannot read a person's
choices**: `contact.forPerson` is `actors: ["human"]` and not on MCP. The inbox's count is shown to
human approvers only.

## Stop links

A stoppable message (any with a purpose) names, for each recipient a Person holds, that it ends
with their own stop link (ADR 0675: 32 random bytes, only the hash kept, naming the Person, email
and the declared purpose, on the business's site; without a site it is refused before it is
queued). **The links are made when the message goes**: the host mints them as it applies the
action (`mintStopLinks`, one statement per 18) and hands them to the gatekeeper's `applyStoppable`,
which sends one copy per recipient (a stoppable email takes `to` only), each ending with "To stop
getting these emails:" and its own link (inside the HTML body, before `</body>`, when it has one).
A send applied without its links is never sent. If the send then fails, its tokens are deleted
(`dropStopTokens`); a refused, rejected or expired send never makes any. No link is in the
gatekeeper's journal, a pending action's stored input, the approval card, the receipt, `listSent()`
or the audit log. So **a pack automation's email gets its stop link from the host**, by declaring
a purpose: the pack and any model never hold a token. `List-Unsubscribe` stays on the host's
routine mail alone, and only when it equals the link in the body (ADR 0675).

## Cost

A send to any number of recipients reads the suppression list, the holders and their choices in
one statement each per 90 recipients; the inbox reads them once for every action on the page; the
stop links are written in one statement per 18 when it goes. Tests count both.

## Consequences

- Under every preset, an automation, the assistant, MCP and extension code cannot email a person
  who stopped through email-send, a mailbox or a calendar invitation, nor name one in a connected
  server's tool call, and a person approving a waiting email cannot send it to someone who stopped
  while it waited.
- An AI's or an automation's email to a Person the CRM knows says what it is for and is then
  stoppable; through a mailbox an AI writes one email to one person, which waits for that person.
- The gatekeeper interface gains two optional calls the CRM's own gatekeepers answer
  (`contactCheck` on the queue, `applyStoppable` on the facet); a gatekeeper that does not ask is
  still checked at submit.
- The `add-automations-tools-dashboards` skill and the Consent to be contacted overview document
  `purpose` as the way an automation emails people.
