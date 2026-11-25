# ADR 0678: Every sender asks the consent register

Status: accepted, 2026-11-26 (stage 30, a follow-up of build step 5: `feat/stage-30-consent-every-sender`,
block BB; no migration). Builds on ADRs [0675](0675-consent-to-be-contacted.md) (the register, the
suppression list, `contactDecision`, the stop link), [0051](0051-outbound-approvals.md) (outbound
actions and the gate), [0590](0590-routine-mail.md) (routine mail),
[0672](0672-the-text-gatekeeper.md) (the text gatekeeper), [0692](0692-one-person-per-folded-address.md)
(one Person per folded address) and [0428](0428-buying-without-an-account.md) (whose an address is).

## Context

Stage 30's spec says every sender asks the consent register at the moment of sending, and a
refusal is final. Step 5 (ADR 0675) built that for routine messages only. The review of PR #451
(finding F1) found that a direct call to the email-send gatekeeper (an automation's or a tool's
`ctx.gatekeeper("email-send")`, the assistant's Code Mode, an MCP client's `integration.call`,
extension code) never asked the register or the suppression list. Under the Autonomous preset the
assistant, MCP and automations get `outbound: auto`, so an automation or an AI could email someone
who had stopped, with no person in between; under the other presets the approver was not told.

## Every path a message leaves by

| Path | Who | Asks | Why |
| --- | --- | --- | --- |
| Routine messages, email and text (a pack's `ctx.routineMail.send`, host kinds, Forms' receipt) | the host, for a shipped pack or host code | `contactDecision` at prepare; the register and the suppression list at claim and when a held one is approved (`stopHeldRoutineMessage`, which asks the list even when the kind is gone) | ADR 0675, unchanged |
| A sign-in code (`callAsHost` `sign-in`) | the host | exempt | essential: the person asked for it, and it must never wait or be turned off |
| An agreement's copy (`callAsHost` `agreements`) | the host | exempt | evidence the person is owed, sent exactly once (ADR 0645) |
| An order's confirmation (`callAsHost` `orders`) | the host | exempt | a receipt the service requires |
| A phone check's code (`callAsHost` `phone-check`, text) | the host | exempt | the member's own act, to their own number (ADR 0673) |
| Staff notices by email (notification delivery) and the invite notice | host code on an org connection, origin `system` | exempt | mail to staff accounts about their own work and access, under their own notification preferences, not a contact of a member |
| A person's own email (`integration.call` from the app, actor `human`) | a staff member | **now asks**: the suppression list and a child's own address | their own message to whoever they write to |
| An automation's or a tool's gatekeeper call, the assistant (Code Mode), an MCP client, extension code, on email-send or the fake outbox | anyone else | **now asks**: `purpose` required to email a Person, asked in full, each copy ends with its own stop link | every sender asks |
| The same callers on a gatekeeper that does not ask (the vendored Gmail and Outlook gatekeepers) | anyone | **now asks** at submit: the host reads the send's `To`, `Cc` and `Bcc` and checks them with no purpose, so a machine's email to a Person through a mailbox is refused | the one place every send passes |
| Mail only to colleagues (`email.internal`, `fake.internal`) and drafts (`draftCreate`, `draftUpdate`, `draftDelete`, `outlook.drafts`) | anyone | exempt | colleagues are staff, not contacts; a draft sends nothing |
| A text from any caller's queue | anyone | refused by the text gatekeeper (ADR 0672); the host's check also refuses it | texts have no free path |
| Slack and Google Chat posts and messages | anyone | not asked | staff workspaces, not a channel of the register |
| Push | | not built (step 4) | its claim will ask as the text claim does |
| The control plane's own mail to businesses (`products/crm/apps/control`) | the operator | not asked | outside any business's host |

No shipped pack sends a member email but through routine mail: Bookings, Ticketing and Forms (its
receipt) declare routine kinds and call `ctx.routineMail.send`, never the gatekeeper themselves (the
email-send connection they declare is the one the host sends their routine mail from); Courses,
Memberships, Leads and Deals send no email (Leads and Deals notify staff with `ctx.notify`). The
CRM's email on a timeline logs an activity and sends nothing. So no pack's send changed.

## Decision

**The check lives in the host, at the one place every caller's send passes: the integration
host's approval queue** (`apps/runner/src/integrations/queue.ts`), with the rule in core
(`packages/core/src/contact/senders.ts`: `checkSend`, `withStopLinks`;
`packages/core/src/integrations/outbound.ts`: `contactAtSubmit`, `contactBlocked`). A gatekeeper
holds the queue; no pack, tool, extension or model does, so none can skip it, and the approval
presets do not reach it: `outbound: auto` never means "to someone who stopped".

1. **Before queueing**, the email-send gatekeeper (and the fake outbox, the same module,
   `gatekeeper-email-send/src/consent.ts`) asks the queue (`contactCheck`) with every recipient and
   the purpose the caller declared. The host answers who may be sent to, each with their stop link
   when the message is stoppable, and how many were dropped; when nobody is left it refuses.
2. **As it is submitted**, the queue reads the action's `To`, `Cc` and `Bcc` from its description,
   whatever the gatekeeper. Recipients `contactCheck` allowed in that session keep its purpose;
   any other send is checked here with no purpose and refused (thrown, so the gatekeeper's journal
   drops it) when a recipient may not be contacted. A refused send is never queued, applied or
   retried.
3. **When a person approves one that waited**, the host asks again with the purpose it was checked
   with (kept on the pending action as `contact`); a recipient who stopped meanwhile means nothing
   is sent, the action is skipped and dropped on its facet, and approving cannot override it. The
   inbox shows a human approver how many of its recipients cannot be contacted
   (`outbound.contactBlocked`) before they approve.

**The rule for each sender** (decided as the conventional one; open to the owner's override):

- **A person on the staff** (actor `human`), with no purpose: their own message. Only what holds
  for the address whatever the message: the suppression list (a bounce, a complaint, a provider's
  unsubscribe, a STOP for a number) and never a child's own address. Not the per-kind or
  per-purpose choices: a member who stopped follow-ups still gets their coach's reply. This holds
  for a person's email to several people too; a person may declare a purpose to have it asked in
  full.
- **Anyone else** (an automation, a tool, the assistant, MCP, extension code): a `follow_up` or
  `news_and_offers` message, asked in full for each Person with the purpose it declares (a stop, an
  "off", no yes to news and offers). Declaring none, an email to any address a Person holds is
  refused with `purpose_required`; `account` is not theirs to declare (messages about a record a
  person has are routine mail, which the host words, addresses and stops itself).
- **Always allowed** are only the host's own essential mail in the table above. Nothing a caller
  sends is essential.
- **A child** (a Person with a live guardian link): nothing to their own address, whoever sends, as
  only essential messages may reach it and none of these is.
- **Texts**: a number that said STOP is never texted, whoever sends; only a person's own text could
  go at all, and none can today (the text gatekeeper refuses every caller).

**Matching an address to a Person**: the live People holding a live address of the same folded form
(ADR 0692: the `+tag` dropped), read at the seam (`peopleAtAddresses` in
`visibility/guardians.ts`, with whether each is a child), one statement per 90 addresses. One holder:
their choices. **None: only the suppression list applies**, except that news and offers, which need
a yes nobody could have given, are refused. **Several**: the address is no one's (ADR 0428's
one-Person rule), so a stoppable message to it is refused (no one stop link would stop it for each
of them); a person's own message goes unless any holder is a child. Open to override.

**What the sender and an AI learn**: a send to several recipients leaves out those who may not be
contacted and goes to the rest; the receipt says only how many (`dropped`). When none is left the
answer is the one plain refusal, the same for a stop, an "off", no yes, a suppression or a child:
`Refused: recipient_stopped. The recipient cannot be contacted this way; nothing was sent or
queued.` Nothing about a person's choices reaches a tool result, a notification or the audit log
(a refused send writes nothing; an approval skipped for it says only "a recipient cannot be
contacted this way"). The inbox's count is shown to human approvers only.

**Stop links on these messages**: a stoppable message (any with a purpose) gets, for each recipient
a Person holds, a new stop link (ADR 0675: 32 random bytes, only the hash kept; `stopTokens`, one
statement per 18) naming that Person, email and the declared purpose, on the business's site;
without a site set it is refused. The gatekeeper then sends one copy per recipient (a stoppable
email takes `to` only, no `cc` or `bcc`), each ending with "To stop getting these emails:" and its
own link, as routine mail's do. The links go only into the copies: not into the receipt,
`listSent()`, the approval's words or the audit log. So **a pack automation's email gets its stop
link from the host**, by declaring a purpose: the pack and any model never hold a token.
`List-Unsubscribe` stays on the host's routine mail alone, and only when it equals the link in the
body (ADR 0675).

**Cost**: a send to any number of recipients reads the suppression list, the holders and their
choices in one statement each per 90 recipients, and writes its stop links in one statement per 18.

## Consequences

- Under every preset, an automation, the assistant, MCP and extension code cannot email or text a
  person who stopped, and a person approving a waiting email cannot send it to someone who stopped
  while it waited.
- An AI's or an automation's email to a Person the CRM knows must say what it is for, and is then
  stoppable; through a mailbox gatekeeper that cannot add a stop link (Gmail, Outlook) it is
  refused, and the person sends it themselves. Open to override if the owner wants assistant
  drafts a person approves to count as that person's own.
- The gatekeeper interface gains one optional queue method (`contactCheck`); a gatekeeper that
  does not call it is still checked at submit.
- The `add-automations-tools-dashboards` skill and the Consent to be contacted overview document
  `purpose` as the way an automation emails people.
