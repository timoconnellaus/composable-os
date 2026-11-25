---
title: "Consent to be contacted"
description: "One register of a person's contact choices, one suppression list, the one-tap stop, and one check every email and text passes before it leaves, whoever sends it."
sidebar:
  label: "Overview"
  order: 0
editUrl: false
---

One register of a person's contact choices, one suppression list, the one-tap stop, and one check every email and text passes before it leaves, whoever sends it.


## What it is for

A member who says "no more of these" must stop getting them, from every part of the business, on
every path a message can leave by. The host keeps what each person chose (per channel, and per
kind of message or purpose), the addresses and numbers that must never be sent to again, and the
one-tap stop link in every stoppable email. It asks them itself before a message leaves: no pack,
tool, extension, automation or AI decides it, and no approval preset lets a message through to
someone who stopped.

## Concepts

- **Purpose**: what a message is for. `account` (about something the person has or did: a booking,
  an order), `follow_up` (automatic and not an offer: "we have not seen you"), `news_and_offers`
  (promotional; needs a recorded yes, and never goes to a child).
- **The register**: each person's choices, one row per choice, the latest in force. A **stop** is a
  person's own "no more" (the stop link, a STOP reply), which only they can lift.
- **The suppression list**: hashes of the addresses and numbers that asked to stop (a STOP reply, a
  provider's unsubscribe), kept after erase and tied to nobody.
- **Stop link**: a link on the business's site naming one person, one channel and one scope. The
  host makes it, puts it in the one email it was made for, and keeps only its hash.
- **A person's own message**: an email a staff member writes to whoever they write to (a reply,
  a one-to-one email). It asks only what holds whatever the message: the suppression list, and
  never a child's own address.
- **Anyone else's message**: an automation's, a tool's, the assistant's, an MCP client's or
  extension code's. It declares its purpose (`follow_up` or `news_and_offers`), is asked in full for
  each person, and each copy ends with that person's own stop link.

## How the pieces fit

- `register.ts` holds the choices, `suppression.ts` the list, `stop.ts` the stop links, and
  `decide.ts` the one question for a routine message (`contactDecision`, with `choicesInForce` for
  a batch).
- `senders.ts` is the check for every other email and text (`checkSend`, `withStopLinks`): who
  holds each address (the seam's `peopleAtAddresses`, by the folded address), the list, and the
  holders' choices, in a few statements whatever the number of recipients.
- **Routine messages** ask `contactDecision` when a row is prepared, and the register and the list
  again when it is claimed and when a held one is approved.
- **Every other send** passes the integration host's approval queue: a gatekeeper asks the queue
  (`contactCheck`) before it queues a caller's email, and the queue checks the send's recipients
  again as it is submitted, so a gatekeeper that did not ask cannot get past it. A message that
  waited for a person is asked again when it is shown in the inbox and when it is approved.
- **Texts** have no free path: only the host's routine texts and phone checks reach the text
  gatekeeper. A number that said STOP is never texted, whoever sends.

## Main flows

1. **A member stops a kind.** They tap the stop link in an email, or turn it off in Contact
   preferences (`web-account-contact`, `native-account-contact`); the next one is not sent.
2. **An automation emails people.** Its step calls the email-send gatekeeper with
   `purpose: "follow_up"` (or `"news_and_offers"`): `ctx.gatekeeper("email-send").call(id,
   resource, "send", { to, subject, text, purpose })`. Whoever cannot be contacted is left out
   (the receipt's `dropped` says how many, never who), each of the others gets their own copy with
   their own stop link, and when nobody is left the call is refused with `recipient_stopped`. The
   pack never sees a link. A fixed message about a record a person has is routine mail instead
   (`ctx.routineMail.send`), which the host words, addresses and stops itself.
3. **The assistant or an MCP client sends an email.** The same: without a purpose an email to a
   person the CRM knows is refused with `purpose_required`; with one, it is asked in full. Under any
   preset, Autonomous included.
4. **A staff member replies.** Their own email goes to a person who turned news and offers off, but
   not to an address that bounced or asked to stop, nor to a child's own address.
5. **A person approves a waiting email.** If a recipient stopped while it waited, the inbox says
   how many cannot be contacted, and approving it sends nothing.

## What is built

Stage 30 step 5 and its follow-up, as the code has them: the register, the suppression list, the
stop link and the public `contact.stop`, Contact preferences in My account, staff recording a
choice, merge and erase; `contactDecision` on every routine message; the check of every other
email at the integration host, with the stop links of a stoppable one, the dropped count, the one
plain refusal and the check again at approval. Not in the code: a staff screen for a person's
choices, and consent questions on Forms and checkouts calling `recordFromForm`.


## Reference

Generated from the code:

- [Operations](/capabilities/contact/operations/)
- [Permissions](/capabilities/contact/permissions/)
- [Behaviours](/capabilities/contact/behaviours/)
- [Screens](/capabilities/contact/screens/)
- [Decisions](/capabilities/contact/decisions/)

The specification is stage 30's, [30-notifications.md](https://github.com/timoconnellaus/composable-os/blob/main/docs/stages/30-notifications.md).

This page is [contact/docs/overview.md](https://github.com/timoconnellaus/composable-os/blob/main/packages/core/src/contact/docs/overview.md), written by hand beside the code.
