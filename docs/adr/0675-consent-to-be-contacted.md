# ADR 0675: Consent to be contacted: purposes, the register, `contactDecision`, the stop link and the public `contact.stop`

Status: accepted, 2026-11-25 (stage 30, build step 5: `feat/stage-30-consent`, block BB: migration
0913). Builds on ADRs [0590](0590-routine-mail.md) (routine mail) and
[0670](0670-routine-messages-text-and-push-on-the-routine-mail-path.md) (routine messages: a row
per recipient and channel), [0672](0672-the-text-gatekeeper.md) (STOP, START and HELP),
[0676](0676-quiet-hours-and-urgent-messages.md) (quiet hours) and
[0402](0402-staff-and-customers.md) (audiences: opening an operation to `public` is a reviewed
change). The seam Journeys (stage 53), the shared inbox (stage 36) and Reviews use.

## Context

Until now nothing recorded a person's wish not to be contacted: no opt-out, no unsubscribe, no
record of a yes (ADR 0572: "no customer preferences until stage 30"). Texts may not reach a member
until they can stop them. Journeys' promotional journeys need a recorded yes, every one of their
messages an unsubscribe link, and the inbox's campaigns the same. Each defining its own consent
would let a member who stopped one keep getting the other.

## Decision

**Three purposes**, a fixed core vocabulary: `account` (about something the person has or did),
`follow_up` (automatic, neither about a record they asked for nor an offer: a welcome, a
review's ask), `news_and_offers` (promotional). Only `news_and_offers` needs a yes first, recorded
per channel with the words shown, and never goes to or about a child (a Person with a live
guardian link). What each needs is for the business to confirm with its lawyer.

**One register** (`core_contact_choice`, migration 0913, `packages/core/src/contact/register.ts`):
a row per choice, per Person, channel (`email`, `text`, `push`) and scope (a purpose, or a routine
kind such as `bookings.reminder`), with when, how (`member`, `staff_on_request`,
`staff_from_paper`, `form`, `checkout`, `stop_link`, `stop_reply`, `start_reply`, `import`,
`merge`), by whom, why (staff) and the words shown (a yes). Append-only, by trigger: the latest
row for (Person, channel, scope) is in force. `account` is never a scope of its own: a person turns
off an optional kind (decision 9), never an essential kind's email.

**One suppression list** (`core_contact_suppression`): a salted hash of each address or number
that asked to stop (a STOP reply; a provider's "unsubscribed"), tied to nobody and kept after
erase. Migration 0913 takes in the numbers step 3 kept in `core_text_stop` (ADR 0672) and drops
that table; STOP and START now write here.

**One question**, `contactDecision(db, { person, channel, purpose, kind?, essential?, moment?,
urgent?, at, address? })` (`contact/decide.ts`), answers `{ send: true, to, key, waitUntil? }` or
`{ send: false, reason, detail }` with reasons `no_address`, `not_textable`, `no_device`, `off`,
`no_consent`, `stopped`, `suppressed`, `child`, `expired`. It reads the register (or a batch read
once with `choicesInForce`, one statement per 90 People), the suppression list, the textable
number or the devices, the moment and quiet hours. `stopped` is a stop the person took (a link, a
reply); `off` a choice in their account or recorded by staff. **A refusal is final**: the sender
skips and logs it, never holds it for a person, because nobody may approve around a missing yes or
a stop.

**Every sender asks at the moment of sending.** Routine messages ask it for each recipient and
channel when a row is prepared (a refusal is a `stopped` row with the reason, no words kept), and
ask the register and the suppression list again when an email or a text is claimed to send
(`claimRoutineMail`, `claimRoutineText`), so a stop taken in between stops it. Push's claim (step
4) asks the same; Journeys' engine and the inbox's campaigns ask it per step and per send.

**The stop link** is the host's alone: `stopLink(person, channel, scope)` (`contact/stop.ts`), a
token naming one Person, one channel and one scope, HMAC-SHA-256 signed, no expiry, on the
business's own site (`<site>/stop?t=…`). Every stoppable email (an optional kind's: off for the
kind; a follow-up's: off for `follow_up` on email) ends with it, and when the host decided it
routine carries it in `List-Unsubscribe` and `List-Unsubscribe-Post: List-Unsubscribe=One-Click`
(RFC 8058). The email gatekeeper takes `listUnsubscribe` only from the host's routine mail decided
routine, and only a link to the stop route on the business's site; any other send naming one is
refused. Journeys and the inbox use `stopLink` and make no tokens of their own.

**`contact.stop` is public** (and open to customers): it reads the token and turns that one scope
off on that channel for that Person (news and offers: `no`), `how: stop_link`. It can only turn
something off; an essential kind's email cannot be stopped by any token; a token of someone erased
does nothing. Its answer is `{ done: true }` whatever the token was. Public calls are rate limited
per client address at the edge (stage 23). The client web app's stop route (`stopRoute` in the
template's `src/host.ts`) shows a page with one button on GET, so a mail scanner that opens every
link stops nothing, and calls `contact.stop` on POST: the button, or a mail app's one-click.

**Who writes the register:** the member for themselves and their live dependants
(`me.contact.choices` / `me.contact.setChoices`, customer only, the Contact preferences section of
My account: `web-account-contact`, `native-account-contact`); anyone holding a stop link
(`contact.stop`); the number's owner by STOP and START (the suppression list); a person for a
member who asked by phone or on paper (`person.contact.record`, `actors: ["human"]`, with a
reason); host code for a form's or a checkout's consent question (`recordFromForm`, with the words
shown). **A stop is lifted only by the member** (their account, or START): staff recording a
choice cannot turn back on what the member stopped. No AI actor writes the register.

**Erase** deletes a Person's choices; suppressions stay. **Merge** moves the duplicate's choices to
the survivor: the later wins, except that a stop or a no on either side stays in force (a `merge`
row puts it back on top).

### The stop link's key

The spec asked for a token signed with an env-only host secret. The key is instead made once per
deployment by migration 0913 (`contact_stop_key` in `core_settings`, 32 random bytes) and read only
by `contact/stop.ts`. The runner, which writes a routine email, and the app, which takes the stop,
share no secret today; adding one means the installer, the updater and local development
generating and setting the same value on two Workers, which this step did not take on. What the
key protects is narrow: with it someone could only turn messages off. Tokens are versioned (`v1.`),
so moving the key to an env secret later changes `stopKey()` and accepts both while old links are
still in inboxes.

## Consequences

- A member can stop any optional message, on any channel, with one tap and without signing in, and
  the host enforces it on every send path: nothing in a pack, a block or a client app decides it.
- Texts may now reach members (steps 3 and 5 are both in).
- Without the business's site set (`routineMail.settings` `siteOrigin`), a stoppable email has no
  stop link (there is no stop route to point to); routine emails' links already need the site.
- The register is not a record: no `rec_*` view reads it, so query.sql, exports, search and the
  assistant's bulk reads never see it. `contact.forPerson` shows staff a Person's choices and
  history through the visibility seam.
