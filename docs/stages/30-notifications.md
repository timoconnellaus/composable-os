# Stage 30: Notifications

Read first: [`AGENTS.md`](../../AGENTS.md), [`docs/architecture.md`](../architecture.md) ("What is
not decided": push to client apps), [`CONTEXT.md`](../../CONTEXT.md) (Notification, Notification
preference, Gatekeeper, Host mail, Sign-in mail, Routine mail, Routine mail kind, Value mark),
ADRs [0051](../adr/0051-outbound-approvals.md) (outbound approvals),
[0172](../adr/0172-notification-delivery.md) (staff notice delivery),
[0402](../adr/0402-staff-and-customers.md) (audiences),
[0429](../adr/0429-payments-gatekeeper-verified-events-and-refunds.md) (the payments gatekeeper and
the host's own message), [0452](../adr/0452-gatekeeper-settings-in-product-ts.md) (gatekeeper
settings and secrets), [0456](../adr/0456-the-hosts-sign-in-mail.md) (sign-in mail),
[0485](../adr/0485-recurring-billing-the-provider-runs-the-schedule.md) and
[0487](../adr/0487-the-payer-and-the-holder.md) (subscriptions, the payer),
[0540](../adr/0540-the-family-link.md) (guardians),
[0571](../adr/0571-a-calendar-file-made-by-the-email-gatekeeper.md),
[0572](../adr/0572-bookings-messages-the-dashboard-and-the-coachs-app-screen.md) (booking emails),
[0574](../adr/0574-an-idempotency-key-on-an-email-send.md) (idempotency keys),
[0590](../adr/0590-routine-mail.md) (routine mail, with all five amendments: this stage grows it),
[0624](../adr/0624-the-rosters-notices-uncovered-shifts-and-leaving.md) (the roster's notices),
[0643](../adr/0643-health-answers-read-by-a-person-with-the-permission-every-read-audited.md)
(`humanOnly` notices) and
[0645](../adr/0645-the-copy-and-the-signed-pdf-host-mail-and-a-second-attachment.md) (queue
classes and the two pending pools, in its amendments). The code: `packages/gatekeeper-email-send/src/`
(`queue-class.ts`, `routine.ts`, `worker.ts`), `packages/gatekeeper-payments/src/provider.ts` (the
provider interface this stage copies), `packages/core/src/routine-mail/`,
`packages/sdk/src/routine-mail.ts`, `packages/core/src/notifications/`. Issues #98 (this stage),
#215 (failed-payment and expiring-card emails), #116 (push to client apps), #238 (an email when the
coach is swapped), #259 (automation email hardening), #302 (a former address now another Person's).
Specs this one must fit: [`47-pack-screens.md`](47-pack-screens.md), `48-my-account.md` (PR #311),
[`34-offers.md`](34-offers.md), [`37-shop.md`](37-shop.md).

Status: **spec agreed** (owner interviewed 2026-11-24: decision 1; decisions 2 to 11 by the
coordinator as best practice the same day). Build may start.

## Status

- **Step 1** — built — PR #339 — Routine messages (`feat/stage-30-routine-messages`). Text and push
  words in a kind's declaration, checked to fit; a row per recipient and channel, held for what
  its own words show (`held`); quiet hours and urgent kinds, released by the minute cron; the
  host kinds' send path; Bookings' and Ticketing's text and push words. Migration 0910, ADRs 0670
  and 0676 (ADR 0590 amended). The name a text begins with and the zone of quiet hours are human
  admins' routine settings (`senderName`, `quietZone`). Left: nothing reaches a phone until steps
  3 to 5; step 2 takes migration 0915 for the subscription's card expiry and sent markers.

- **Step 2** — not built — needs: step 1 — Subscriptions' host kinds and the card's expiry (#215),
  email first.

- **Step 3** — built — PR #435 — Texts (`feat/stage-30-text`). `packages/gatekeeper-text`: one provider interface,
  the fake (refused in a live environment), the business's sender number; only the host's queues
  (`routine-mail`, `phone-check`, `text-events`), every caller's refused; `text.routine` or a held
  text reviewed with the number masked; one pool of 500; verified receipts, STOP, START and HELP.
  Marks on phone numbers, the textable number, `me.phone.startCheck` / `me.phone.check`, the
  month's limit counted at claim with the 80% and limit notices, five texts a day per number, the
  routine settings `textLimitMinor`, `textSegmentPriceMinor`, `textCountries`, `messages.textSpend`.
  Migration 0911 (`core_text_spend`, `core_phone_check`, `core_text_stop`), ADRs 0672 and 0673.
  Not built: a real provider module (with the first business's account, step 8); STOP is kept in
  `core_text_stop`, which step 5's suppression list reads for texts.

- **Step 4** — not built — needs: step 1 — Push gatekeeper (prove the Worker reaches both push
  services first), devices, the template's app, staff push.

- **Step 5** — in progress — branch `feat/stage-30-consent` — The consent register,
  `contactDecision`, `stopLink`, `contact.stop`, the List-Unsubscribe headers, contact preferences
  blocks.

- **Step 6** — not built — needs: step 1 — The business's wording, versions, preview.

- **Step 7** — not built — needs: step 1, step 2, step 3, step 4, step 5, step 6 — Delivery
  status, the Person's Messages card, the log screen, the coach swap kind (#238), e2e, the site.

- **Step 8** — not built — needs: step 3, step 4, the first client's provider accounts — The first
  client: their own text provider account and sender number, push credentials, a real phone, the
  limit, quiet hours, wording, the provider's failed-payment emails off.

## Goal

A business reaches its members and staff on the channel that suits each message: email, a text
message, or a push notification on the business's own app. Its booking confirmations, class
changes and reminders, waiting list news, tickets and membership payment problems go out on their
own, in words the business can rewrite, on the channels it switches on. A member chooses which
optional messages they get and how, and can stop any of them with one tap. Texts and pushes do not
buzz a phone overnight. Texts never cost more in a month than the limit a person set, and they are
paid for by the business, from its own account with a text message provider. Staff get their roster
and approval notices as a push on the same app. Every message sent is logged with what became of
it. Nothing an AI wrote reaches a member without a person's approval, on any channel.

This stage also owns **consent to be contacted, a person's contact preferences and unsubscribe**
for the whole platform. Journeys, the shared inbox (stage 36) and Reviews use what is built here and
do not define their own (the seam is under "Consent to be contacted").

## Who it is for

- **Gyms and studios (first).** Class reminders and short-notice cancellations are worth a push or
  a text, because email is read too late (stage 31: "Promotion close to a class is only as good as
  email; push is stage 30's"). A place free on the waiting list an hour before class. Membership
  payments that failed and cards about to expire (issue #215), so access does not stop by surprise.
  Coaches told of a shift change on their phone, not in an inbox.
- **Trades and services (next).** Customers rarely install a tradesperson's app, so the text is
  the main channel: "booked for Tuesday 8 to 10am", "on the way", "quote sent", "invoice due". The
  "on the way" text starts from a staff member tapping a button on a job (a record change), so it
  is still a declared message about a record, never free text. Quiet hours run the other way (trades
  start early), so the business sets its own. Quotes and invoices (stage 35) and jobs (stage 39)
  declare their own kinds on what this stage builds.
- **What differs:** gyms lean on push (members have the app) with text as the fallback; trades lean
  on text. Both need a cost limit; gyms send many short-lived messages (a reminder is useless after
  the class starts), trades fewer, longer-lived ones.

## What exists today (from the code, checked 2026-11-24)

There are already **three ways a message leaves the host**, and this stage keeps them three.

- **Staff notices** (`packages/core/src/notifications/`). A notice is a row in `core_notifications`
  for one staff user, written in an operation's batch (`send.ts`), typed (`types.ts`:
  `NOTIFICATION_TYPES`; channels `NOTIFICATION_CHANNELS = ["inApp", "email", "slack"]`). The
  runner's minute cron (`delivery.ts`) sends each to email or Slack as the person chose per type
  (`preferences.ts`) through the org connection an admin picked (`channels.ts`). Approval notices
  escalate; a daily digest (`digest.ts`). A notice may be `humanOnly` (ADR 0643: no AI actor lists
  it). Members never get these. The roster (ADR 0624) and subscriptions' staff warnings
  (`tellStaff` in `subscriptions/events.ts` and `subscriptions/grants.ts`) use them.
- **Host mail.** Mail the host composes as itself through `callAsHost` with a purpose
  (`apps/runner/src/integrations/host.ts`: `orders`, `sign-in`, `agreements`): sign-in codes
  (`customers/sign-in-mail.ts`, ADR 0456), an order's confirmation (`orders/gateway.ts`,
  `sendHostEmail`, ADR 0429), an agreement's copy with its PDF (`agreements/copy.ts`, ADR 0645), the
  invite notice (`apps/app/src/server/host-mail.ts`). Fixed words, no preferences, at once.
- **Routine mail** (`packages/core/src/routine-mail/`, `packages/sdk/src/routine-mail.ts`,
  `packages/core/src/operations/routine-mail.ts`, ADR 0590). A shipped pack declares kinds
  (`routineMail` in its manifest) with fixed words and slots the host fills; its automation asks with
  `ctx.routineMail.send({ kind, record })`; the host picks the recipient from the record, checks every
  value (`unroutineText`) and every value's mark (`core_value_mark`, `marks.ts`: a person's or a
  default's, never an AI's), caps 20 a day per mailbox (`ROUTINE_DAILY_CAP`) and 2,000 a rolling day
  per organisation (`ROUTINE_ORG_DAILY_CAP`), counted in the one statement that claims the row
  (`claimRoutineMail`), logs each row in `core_routine_mail` (migration 0750) for 12 months, and
  sends through email-send's `email.routine` kind, applied without approval under Balanced. Settings
  live in `core_settings` key `routine_mail` (`packs`, `kinds`, `siteOrigin`, `orgDailyCap`,
  `retentionMonths`), changed only by a human admin (`routineMail.settings.update`). Each pack is off
  until a human admin turns it on. Bookings (`packs/bookings/routine-mail.ts`) and Ticketing
  (`packs/ticketing/routine-mail.ts`) declare kinds; Offers (stage 34) and Shop (stage 37) will.
- **Everything else** (an automation's own `email-send` call, the assistant, MCP, a person's
  `integration.call`) is an ordinary outbound action a person approves.
- **The email gatekeeper** (`packages/gatekeeper-email-send/`), which the new gatekeepers copy:
  - **Queue classes** (`queue-class.ts`): the class of a caller is read from the approval queue the
    integration host opened (`hostPurpose`), never from the message: `agreements`, `sign-in`,
    `routine`, `orders`, or `caller`. Idempotency keys are remembered per class
    (`idemc:<class>:<key>`); the host's private classes' sends are listed only to the same class.
  - **The routine shape** (`routine.ts`): the `email.routine` kind only when the host's queue says
    the row was decided routine (`hostRoutineMail`) **and** the message has routine shape (one
    recipient, plain text, no cc, bcc, reply-to or HTML, every link on the business's site).
  - **The pending allowance** (`worker.ts`): sends waiting for a decision are held to two pools,
    callers' with the host's routine and orders mail at most 500 (`MAX_PENDING_SENDS`), and the
    host's independent mail at most 100 (`MAX_PENDING_HOST_SENDS`), so a flood of one never blocks
    the other. A full pool refuses the send ("Too many pending actions"); a routine row waits and is
    tried again (back-pressure), never dropped.
  - "Sent" means Email Service accepted the message; nothing records a bounce.
- **The payments gatekeeper** (`packages/gatekeeper-payments/src/provider.ts`): one
  provider-neutral interface (`PaymentProvider`), a fake (`fake.ts`), one real provider module, the
  provider's keys only in the gatekeeper Worker's secrets (ADR 0452: secrets never in `product.ts`),
  verified webhooks. The business's own account with the provider is the one money moves through.
  This is the shape the text gatekeeper takes.
- **Subscriptions** (`packages/core/src/subscriptions/`): a failed renewal (`invoice_payment_failed`,
  `events.ts`) and the lapse 30 days after a payment first failed (`PAST_DUE_GRACE_DAYS`,
  `sweep.ts`; `access.ts`) tell admins only. The member is emailed by the payment provider in its own
  branding (left out at the stage 32 interview, recorded in #215: "host templates through the email
  connection could follow"). The payer is a Person (`payer_person_id`, migration 0530; ADR 0487).
  `openPortal` (`subscriptions.ts`) opens the provider's page where a member updates their card.
  Nothing reads a card's expiry.
- **Phones and devices.** A Person has phone numbers (`core_person_phones`, migration 0003: number,
  normalised number, label, primary), writable by staff and AI like any field and **not marked**
  (only addresses are, `emails:<address>` in `marks.ts`). A native app signs in to a device session
  (`core_device_session`, migration 0411, staff or customer; `operations/device-session.ts`);
  nothing stores a push token. No text or push gatekeeper exists.
- **No consent or unsubscribe exists**: no opt-out, no unsubscribe route, no record of a yes
  (ADR 0572: "no customer preferences until stage 30").

## Decided at the interview (2026-11-24)

| # | Decision |
| --- | --- |
| 1 | **Each business pays the text message provider from its own account with that provider, as with card payments.** We never resell texts or bill for them. The provider is a connector behind one interface, so it can be swapped; this spec names none (the owner named a likely one privately, to be chosen at the build) |

### Decided by the coordinator as best practice (2026-11-24, not asked)

| # | Decision |
| --- | --- |
| 2 | **Besides email, a member's phone is reached by a push on the business's own app, and by a text only for members who do not have the app** ("text only without the app", on by default) |
| 3 | **The first client's monthly text limit is 50** in its own currency (whole units). At 80% admins are told; at the limit texts stop until the month turns and emails carry on. A limit of 0 sends no texts |
| 4 | **Quiet hours 9pm to 7am**, in the business's time zone: texts and pushes wait until 7am; emails always go at once |
| 5 | **A class cancelled at short notice still texts and pushes during quiet hours** (it is urgent) |
| 6 | **The host tells a member their membership payment failed**, in the business's own words, by email and on their phone, logged on their record; the payment provider's own emails are turned off |
| 7 | **A member hears about a failed payment three times:** as soon as it fails; a few days before their access would stop; and when it stops. Not on each retry |
| 8 | **A card about to expire is told once, 14 days before the end of its expiry month**, and only if the membership renews after that date |
| 9 | **A member may turn off: class reminders, waiting list news, event and ticket reminders.** Everything else about what they booked or pay (confirmations, a class cancelled or changed, a failed payment) is essential: its email cannot be turned off |
| 10 | **How the gym reaches members today** was not asked: the draft's assumptions stand (members notice the app and texts; email is read late), to be checked with the business during setup (step 8) |
| 11 | **The first client's day-one list** is text messages and push, and emails for failed payments and cards about to expire. The build order puts those first |

## The design in one page

**Three paths stay three, and routine mail grows into routine messages.**

| Path | What | Who words it | Preferences, quiet hours | Approval |
| --- | --- | --- | --- | --- |
| **Host mail** | Sign-in codes, invite notices, order confirmations, agreement copies | Fixed by the platform | None: must always arrive, at once | Applied at once (deploy floor only) |
| **Routine messages** (routine mail, grown) | A pack's or the host's declared messages to the person a record belongs to, on email, text and push | The declaration, or the business's own published words | Yes | None under Balanced; held when anything about it is not routine (ADR 0590) |
| **Staff notices** | Notices to staff users, in the app, by email, Slack and now push | The host or the automation that wrote it | The staff member's own | As today (system outbound) |

Everything that is none of these (a person's or an AI's own email) stays an approved outbound
action. In this stage a text or a push has **no** free path: only routine messages and staff notices
send them. The shared inbox (stage 36) adds a person's reviewed text later.

- **Routine mail becomes routine messages.** Each declared message gains optional **text** words
  (one short message) and **push** words (a title and one line), with the same slots, the same value
  checks and the same marks. The pipeline, the caps, the switch per kind and the log are ADR 0590's;
  a row is now per recipient **and channel**. A pack that declares only email behaves exactly as
  today.
- **The host declares kinds of its own** (host kinds). Subscriptions' messages to the payer (a
  payment failed, access stops soon, access stopped, a card expires soon) are routine message kinds
  declared in core and asked for by host code, not an automation. They answer issue #215.
- **The business words them.** For each kind, message and channel, a person may publish the
  business's own words using only the slots the declaration offers, checked by the same rules as a
  pack's words. An AI may draft; only a person publishes. "Use the standard words" goes back.
- **Channels per kind, then per person.** A human admin switches each channel on or off for each
  kind (within what the kind declares). A person gets every switched-on channel they can receive and
  have not turned off; a text is skipped when a push reached them (decision 2).
- **Consent to be contacted** is one register in core, with one question every sender asks at the
  moment of sending (`contactDecision`). It covers routine messages here and Journeys', the inbox's
  and Reviews' messages there. A one-tap stop in every stoppable email, and STOP by text.
- **Quiet hours** hold texts and pushes (never email) until they end. An urgent message goes anyway
  when waiting would make it late; one whose moment has passed when they end is dropped and logged,
  its email having gone.
- **A text gatekeeper** (`gatekeeper-text`), shaped as the payments gatekeeper: one provider
  interface, a fake and one real provider module; the business's own account and sender number; the
  provider's keys only in the Worker's secrets. It sends only the host's routine texts, reads delivery
  receipts and STOP, START and HELP replies as verified events, and checks a mobile by a code.
- **A monthly text limit**, counted at the moment a text is claimed, in the same statement.
- **A push gatekeeper** (`gatekeeper-push`) and the business's app: the app registers a device for
  push after the person allows it, tied to its device session; signing out deletes it. A push opens a
  declared screen of the app for a record, never a web address.
- **Staff get push too**, as a fourth channel of staff notices, per type, with their own quiet hours.
- **Every row ends in a status** (sent, delivered where the channel reports it, failed, stopped,
  waiting, expired, over the limit, held, off). Staff see a Person's messages (kind, channel, when,
  status, never the words) on their record.

### What was weighed and rejected

- **A separate notification service for members, beside routine mail.** A second path would need
  its own AI hold, caps, switches and log; ADR 0590's guarantees took five security reviews. Grow it.
- **Moving sign-in codes, agreement copies or order confirmations into routine messages.** A
  sign-in code must never wait or be turned off; a copy is evidence sent exactly once; order
  confirmations work and touch `orders/`. They stay host mail.
- **Free-form templates with any merge field.** A field holding a link or an address would turn
  routine messages into a way to send anything. Only declared slots.
- **Leaving failed-payment emails to the payment provider** (stage 32's choice). It works, but in
  the provider's words, not logged on the Person, no text or push, and it cannot say what happens to
  the member's bookings. Decision 6 replaces it.
- **Our own account with a text provider, resold to each business.** Simpler for the business,
  but it makes the platform a reseller with billing per client. Decision 1.
- **Texting only numbers confirmed by a code** (the draft). Safe, but most members would never
  confirm, so the text fallback would reach almost nobody. A number is treated as an address is
  today (ADR 0590's marks): textable when a person, the member, or a code put it there; never an AI.
- **Texts and pushes by an AI or a person through the gatekeeper,** reviewed like email. Useful for
  conversations, but not before the shared inbox designs replies (stage 36).
- **Quiet hours on email too.** Email does not buzz a phone on its own; holding it would make a 6am
  class's reminder arrive after the class.
- **Each of Journeys, the inbox and Reviews keeping its own consent and unsubscribe tables** (as
  their drafts proposed). A member who unsubscribes once must be unsubscribed everywhere; one
  register, one token, one question.

## Platform work and pack work

| Piece | Kind | Notes |
| --- | --- | --- |
| Routine messages: text and push words in the declaration, a row per channel, the checks for a text's length and a push's bounds, quiet hours in the send path | **Platform** (amends ADR 0590) | `packages/sdk/src/routine-mail.ts`, `packages/core/src/routine-mail/` |
| Host kinds and their send path from host code | **Platform, new** | First user: subscriptions |
| Subscriptions' payer messages and a card's expiry | **Platform** | `subscriptions/`, `gatekeeper-payments` |
| Marks on phone numbers (`phones:<number>`), as on addresses | **Platform** | `routine-mail/marks.ts` |
| Text gatekeeper (`packages/gatekeeper-text`), checking a mobile by code, the monthly limit, receipts and STOP | **Platform, new gatekeeper** | Provider interface, fake, one real module |
| Push gatekeeper (`packages/gatekeeper-push`), device registration, the template's app | **Platform, new gatekeeper** | `templates/client/apps/mobile`, device operations |
| Push for staff notices, staff quiet hours | **Platform** | `notifications/types.ts`, `channels.ts`, `preferences.ts`, `delivery.ts` |
| The consent register, `contactDecision`, the one-tap stop (a **public** operation), preferences | **Platform, new** (`packages/core/src/contact/`) | Opening `contact.stop` to `public` is a reviewed change (ADR 0402) |
| The business's wording, versions, publishing, preview | **Platform, new** | A core settings screen |
| Delivery status, the Person's Messages card, the log | **Platform** | |
| Contact preferences section and the mobile check (web and native) | **Base-layer blocks** | A section in My account (stage 48), over one headless hook |
| Bookings and Ticketing: text and push words, essential and optional, urgent, which screen a push opens | **Pack** | Declarations only |
| Bookings: a coach swap message (issue #238), off by default | **Pack** | A new optional kind |
| Memberships: nothing | | Subscriptions' kinds are the host's |

## The model

### Words

- **Routine message**: a declared message to the person a record belongs to, on email, text or
  push. Replaces "Routine mail" in `CONTEXT.md` (kept as the former name; the code keeps `routineMail`).
- **Host kind**: a routine message kind the host declares itself (`subscription.paymentFailed`).
- **Wording**: the business's own words for one kind, message and channel, published by a person.
- **Essential / optional**: whether a person can turn a kind's email off. Text and push of any kind
  can be turned off.
- **Urgent**: a kind whose messages may go during quiet hours when waiting would make them late.
- **Quiet hours**: when texts and pushes wait.
- **Textable number**: a mobile number the host may text for a Person (below).
- **App device**: one phone or tablet registered for push, tied to one device session.
- **Text limit**: the month's spending limit on texts.
- **Purpose**: what a message is for, as far as consent goes: `account`, `follow_up`,
  `news_and_offers`.
- **Consent register**: the record of a person's contact choices: per channel and purpose (and per
  kind for routine messages), with when, how and by whom.
- **Stop**: a person's own "no more of these", by the one-tap link, by replying STOP, or in their
  account.
- "Notification" keeps its meaning: a staff notice.

### The declaration (SDK)

Each `routineMail` kind (the manifest key keeps its name) gains:

```ts
reminder: {
  about: "booking",
  essential: false,            // a person may turn its email off (decision 9)
  purpose: "account",          // or "follow_up" (Reviews' ask); never "news_and_offers"
  urgent: false,               // waits for quiet hours on text and push
  until: "class.startsAt",     // its moment: a text or push not sent by then is dropped
  channels: ["email", "text", "push"],
  open: { screen: "booking" }, // the app screen a push opens, with the record's id
  messages: {
    default: {
      subject: "...", body: "...",       // as today
      text: "Reminder: {class} at {time}.",
      push: { title: "{class} at {time}", body: "See you soon." },
    },
  },
}
```

Contract checks, added: text and push words use only declared slots; a text after filling (with
the business's name the host puts first and "Reply STOP to stop" it puts last) must fit two segments
(306 plain characters, 134 when a character forces the longer encoding), so the check fills each
slot at its maximum; a push's title at most 60 and body at most 140 characters; push words may not
use a slot marked private (health, pay, a note: a push shows on a locked screen); `until` is a
datetime path of the kind's object; `open.screen` is a screen the pack's native blocks declare;
`essential: true` with `purpose: "follow_up"` is refused (a follow-up is always optional); a runtime
extension still may not declare any of it (`outsideDeclarations`). A pack that declares no text or
push words sends email only, as today.

### Records (block BB: migrations 0910 to 0929, ADRs 0670 to 0679)

- `core_routine_mail` gains `channel` (`email`, `text`, `push`), the new `status` values, `segments`
  and `cost_minor` (texts), `provider_ref`, `delivered_at`, `wait_until` (quiet hours). Idempotency
  keys gain the channel. Kept 12 months as today.
- `core_message_wording`: kind, message, channel, version, words, state (`draft`, `published`,
  `retired`), who wrote, who published, when. A published version is never changed.
- Settings (in `core_settings`, key `routine_mail`, grown): per kind the channels switched on;
  "text only without the app"; quiet hours (start, end; the zone is the business's); the text limit
  (minor units a month), the price per segment the admin enters, the countries texts may go to
  (default: the business's own); the staff push switch.
- `core_contact_choice`: the consent register. Person, channel (`email`, `text`, `push`), scope (a
  purpose, or a routine kind), `on` or `off` (for `news_and_offers`: `yes` or `no`), when, how
  (`member`, `staff_on_request`, `staff_from_paper`, `form`, `checkout`, `stop_link`, `stop_reply`,
  `start_reply`, `import`), who, the wording shown when a yes was given. Append-only: the latest row
  for (Person, channel, scope) is in force, the earlier ones are its history.
- `core_contact_suppression`: a salted hash of each address and number that asked to stop (a STOP
  reply, a provider's "unsubscribed"), kept after erase so a re-entered number is not texted (for
  the business to confirm with its lawyer).
- `core_phone_check`: a Person's number (international form), checked at, how (a code by text);
  the code itself is the gatekeeper's, never stored in the host.
- `core_push_device`: device session id, platform, token (encrypted at rest), app id, created, last
  success; deleted with its session and on a "token no longer valid" answer.
- `core_text_spend`: month, segments, estimated and reported minor units; counted in the statement
  that claims a text row, as the daily caps are.
- `core_subscription` gains the card's expiry month and year (no other card detail) and the
  messages already sent for the current failure and expiry (so each is sent once).

### Which number is textable

As an address is today (ADR 0590's third amendment), one number by one:

- Phone numbers are marked one by one (`phones:<number>`, `phones:$primary`), with the standing of
  whoever added the number. A number is textable for a Person when it is a mobile in an allowed
  country, and its mark is a person's or a default's, or it is the customer's own and they checked it
  by code, or it was checked by code at all (`core_phone_check`). An AI's number is never textable;
  nor is one on the suppression list, nor one checked by another Person (issue #302's rule, for
  numbers: a number checked by one Person is never texted for another).
- A Person's primary mobile is the one texted; one text per recipient.
- A member can check their number by code in their account (`me.phone.startCheck` / `me.phone.check`,
  at most 3 codes a day per Person and per number).

### States of one row

`prepared` → `held` (a person decides, as today) | `waiting` (quiet hours, a full pending pool, or a
pending approval) | `claimed` → `sent` → `delivered` | `failed`; or `off` (the kind or channel
switched off), `stopped` (the person's choice or a STOP), `expired` (its moment passed while
waiting), `over_limit`, `no_channel` (no address, no textable number, no device), `denied` (the
deploy floor).

### Consent to be contacted: the seam Journeys, the inbox and Reviews use

This stage owns it. Nobody else writes the register or reads it except through the question below.

**Three purposes** (a fixed core vocabulary):

| Purpose | What | Needs a yes first | How it is stopped |
| --- | --- | --- | --- |
| `account` | Routine messages about something the person has or did: a booking, a ticket, a payment | No | Per kind, optional kinds only (decision 9); an essential kind's email cannot be stopped |
| `follow_up` | Automatic messages that are neither about a record the person asked for nor offers: Journeys' non-promotional journeys (a welcome, "we have not seen you", a trial ended), Reviews' ask | No | Every one carries the one-tap stop; stopping turns `follow_up` off on that channel |
| `news_and_offers` | Promotional: Journeys' promotional journeys, the inbox's campaigns | **Yes**, recorded per channel with when, how and the wording shown; never to or about a child | The one-tap stop, STOP, or their account |

Whether a purpose needs a yes, and what each message must contain, is for the business to confirm
with its lawyer; the defaults above are Journeys' recorded decision ("only promotional journeys need
a yes first; the others go to every member, always with an unsubscribe link").

**The one question:** `contactDecision(db, { person, channel, purpose, kind?, moment?, at })`
(`packages/core/src/contact/decide.ts`) answers `{ send: true, to, waitUntil? }` or `{ send: false,
reason }`, with reasons `no_address`, `not_textable`, `no_device`, `off`, `no_consent`, `stopped`,
`suppressed`, `child`, `expired`. It reads the register, the suppression list, the textable number
or the devices, and quiet hours, in a bounded number of statements. Every sender asks it at the
moment of sending, not only when the message is prepared:

- routine messages (this stage), and through them Reviews' ask (a routine kind with
  `purpose: "follow_up"`);
- Journeys' engine, for each step's message (`follow_up` or `news_and_offers`);
- the inbox's campaigns (`news_and_offers`); a reply a person writes in a conversation is not a
  purpose, and asks only `stopped` and `suppressed` (a STOP'd number is never texted).

A `false` is final for that message: it is skipped and logged, never held for a person, because
nobody may approve around a missing consent or a stop.

**Writes to the register:**

| Who | How | Operation |
| --- | --- | --- |
| The member, for themselves and their live dependants | Their account's Contact preferences section | `me.contact.choices` / `me.contact.setChoices` |
| Anyone holding a stop link | The one-tap link in an email, or the List-Unsubscribe header | `contact.stop` (**public**) |
| The number's owner | A reply of STOP (all texts off), START (back on), HELP (a fixed answer) | The text gatekeeper's verified event |
| A staff member, for a member who asked by phone or on paper | A Person's record, with a reason | `person.contact.record` (human only) |
| A form or a checkout with a consent question (stage 29, orders) | The question is never ticked in advance; its wording is kept | `contact.recordFromForm`, called by host code only |
| An import a person ran (stage 33) | Each row's choice with its source | The import's own operation, human only |

**The stop link** is built by the host only (`stopLink(person, channel, scope)`): a token signed
with a host secret (env-only), naming one Person, one channel and one scope, with no expiry, on the
business's own site (the client web app's stop route, a base-layer block calling `contact.stop`
over the typed client). It can only turn something off, answers the same whether the token is good
or not, and is rate limited. Every stoppable email also carries `List-Unsubscribe` and
`List-Unsubscribe-Post` headers to the same route, which only the host's routine queue (and later
Journeys' and the inbox's host queues) may set at the email gatekeeper. Journeys and the inbox use
`stopLink`; they make no tokens of their own.

**Quiet hours** are one business setting (decision 4) that Journeys uses too. Per-person caps stay
each sender's own (routine messages' daily caps here, Journeys' weekly cap there), but the **text
limit is one** across everything that texts.

### Operations

| Operation | Audience | Who may | Risk |
| --- | --- | --- | --- |
| `routineMail.settings` / `routineMail.settings.update` (grown: channels per kind, text only without the app, quiet hours, text limit, price per segment, countries, staff push) | staff | human admin, `settings:manage`, `actors: ["human"]`, not on MCP | bookkeeping; loosening |
| `routineMail.log` / `routineMail.get` (grown: channel and status) | staff | `audit:read` | read |
| `messages.forPerson` (kind, channel, when, status; no words) | staff | through the visibility seam, `records:read` | read |
| `messages.textSpend` | staff | admins | read |
| `messages.wording.list` / `.get` / `.preview` | staff | `settings:manage` | read |
| `messages.wording.draft` | staff | `settings:manage`; an AI may call | write |
| `messages.wording.publish` / `.reset` | staff | `settings:manage`, `actors: ["human"]` | write, shown as a diff |
| `me.contact.choices` / `me.contact.setChoices` | customer | the signed-in member, for themselves and their live dependants | write (their own) |
| `contact.stop` | **public** | anyone holding the token; turns off only | write; **opening to public is a reviewed change** |
| `me.phone.startCheck` / `me.phone.check` | customer | the member; 3 codes a day | write |
| `person.contact.record` (a member asked by phone, or on paper) | staff | a person, `records:write`, `actors: ["human"]`, records why | write, audited |
| `contact.forPerson` (the register's current choices and history) | staff | who reads the Person | read |
| `me.devices.registerPush` / `me.devices.unregisterPush` | customer and staff (each for their own session) | the session's own account | write |
| `notification.setPreferences` (gains `push` and quiet hours) | staff | the person themselves, human only (as today) | bookkeeping |

All customer operations are `mcp: { expose: false }` and rate limited. No operation sends a
message: the host sends, for an automation run of a shipped pack (as today) or host code for a host
kind.

### Host kinds: subscriptions (issue #215; decisions 6 to 8)

Declared in core, about `core_subscription`, to the **payer** (ADR 0487), essential, `account`,
on email, text and push:

- **A payment failed**: on the first failed renewal of a run of failures (not each retry): the
  plan, the amount, the next try's date when the provider gives one, and "update your card when you
  sign in". The link is the business's own site, never the provider's page: the member signs in and
  opens `openPortal` from there (My account shows it as `card_failing`, stage 48).
- **Access stops soon**: 3 days before `PAST_DUE_GRACE_DAYS` runs out, if still unpaid.
- **Access stopped**: the lapse, or the subscription ended for failed payments.
- **A card expires soon**: the payments gatekeeper reads the expiry month and year of each running
  subscription's payment method (from the provider's event, or a read of the payment method), and
  the host stores only those. Sent once, 14 days before the last day of that month, only when the
  subscription's next renewal is after that day.

Their values (amount, dates) come from the provider's verified events and are written by the host:
the marks rule gains "a value a verified provider event wrote" as standing for host kinds' own
columns only, as `ROUTINE_ORDER_FIELDS` reads an order's own columns. The plan's title keeps its
mark. Staff warnings (`tellStaff`) stay. The kinds are off until a human admin turns them on, and
the settings card says to turn the provider's own failed-payment emails off first (the runbook does
it for the first client), so members do not get two.

### Sending

1. A row per recipient is prepared as today; then per channel, `contactDecision` answers: the
   channel switched on for the kind, the person has not turned it off, not stopped or suppressed,
   and they can receive it (an address; a textable number in an allowed country; a registered
   device). Push first; the text is skipped when "text only without the app" is on and a push was
   accepted.
2. Texts and pushes inside quiet hours wait until they end, unless the kind is urgent and its moment
   is before quiet hours end (a 6am class cancelled at 5am goes now; a class next week waits). At
   the end of quiet hours a waiting row past its moment is `expired`.
3. A text is claimed with the spend in one statement: over the month's limit it is `over_limit`
   (admins told once a day; at 80% once a month). Per-recipient caps, counted at the same claim: 5
   texts and 20 pushes a day (the email caps stay).
4. The integration host sends each claimed row through its gatekeeper with the row's own words,
   through a host queue of purpose `routine-mail` (as email today).
5. Receipts arrive as verified events (texts: delivered, failed, STOP, START; push: token no longer
   valid; email: bounces only if Email Service reports them).

### The gatekeepers

Both copy the email gatekeeper's queue classes and pending allowance.

- **Text** (`packages/gatekeeper-text`):
  - **One provider interface** (`TextProvider`: `send`, `startCheck`, `check`, `verifyWebhook`), a
    fake (`fake.ts`, refused in a live environment as `PAYMENTS_FAKE_PROVIDER` is) and one real
    provider module, chosen at the build. The provider is a setting in `product.ts` (ADR 0452); its
    keys are the gatekeeper Worker's secrets, set by a person, never readable back, never in the
    host. A second provider is a second module, nothing else changes. The business's sender number
    is a setting.
  - **Who may send**: only the host's classes, read from the queue as `queueClassOf` does:
    `routine` (routine messages, the kind `text.routine` when the host decided the row routine and
    the text has routine shape: one number, plain words, no link except the business's site) and,
    for the code, `check`. A caller's queue (a person, an extension, an automation's own call, the
    assistant, MCP, Code Mode) is refused, not reviewed. A held routine text is reviewed by a person
    as a held email is, with its words and the number partly masked.
  - **The pending allowance**: one pool, at most 500 texts waiting; a full pool is back-pressure
    (the row stays ready and is tried again), never a drop. Idempotency keys per class, as email.
  - **Replies**: STOP, START and HELP (and the usual synonyms) are handled at the gatekeeper and
    reported to the host as verified events; HELP gets a fixed answer with the business's name.
    Other replies are not read or stored until the shared inbox (stage 36) adds a receiver.
- **Push** (`packages/gatekeeper-push`): the app's credentials as secrets, set by a person; `send`
  to one device token with a title, a body and `{ screen, id }`. Classes: `routine` and
  `staff-notices` (the host's notice delivery), nothing else. The same pending allowance. Whether a
  Worker can reach both phone platforms' push services directly is proved first in step 4 (see
  Risks).

### Staff notices

Push is a fourth channel (`NOTIFICATION_CHANNELS` gains `push`; `EXTERNAL_CHANNELS` too), sent to
each of the staff member's registered devices. A staff member's own quiet hours hold pushes (not
in-app, email or Slack). A `humanOnly` notice (ADR 0643) goes by push with its title only ("You
have a new notice"), never its body. Staff notices never go by text. Members still never get staff
notices.

### Screens

- **Web admin** (core settings; stage 47 shell): Settings, Routine messages: each kind with its
  channels, wording (edit, preview with sample values, publish, reset), quiet hours, the text limit
  and this month's spend, countries, the text provider's status; the log. A Person's record: a
  Messages card (status only), their textable number and how it got there, their contact choices and
  history. Settings, Notification delivery gains push for staff.
- **Customer (My account, stage 48)**: a base section, **Contact preferences**: each optional kind
  with its channels, essential ones shown as always emailed, follow-ups and news and offers per
  channel; for a parent, their children's. Checking a mobile is in Your details. A device's push on
  or off is in Sign-in and devices. Web and native skins over one headless hook. This stage adds no
  separate customer area. The stop route on the business's site is a base-layer block page.
- **Native (the business's app)**: the permission prompt after the member's first booking (or the
  staff member's first sign-in), asked once; device registration; opening a pushed screen.

### What an AI may do

- May **not** send a text, a push or an email to a member on its own say-so, on any path. A
  routine message about anything an AI wrote or changed that no person approved is held (ADR 0590's
  marks, unchanged, on every channel). A number an AI added is never textable.
- May draft wording; may not publish or reset it, or change channels, quiet hours, the text limit,
  countries, the provider or push credentials (all human admin only: loosening policy).
- May not change anyone's contact choices, record a yes, check a phone, or lift a stop. A stop is
  lifted only by the member themselves (their account, or START).
- May read the log's statuses (kind, channel, when, status) where its person may; never the words,
  the number or the push token.
- May write staff notices as today; their push follows the staff member's preferences.

### Privacy and erase

- Words are cleared from a row once decided (as today), on every channel. The log keeps kind,
  channel, status and cost, never the number or token (a hash for the caps).
- A push shows on a locked screen: no private slot in push words (the contract check).
- A Person's erase deletes their rows, contact choices, phone checks and devices; suppressions are
  kept as salted hashes. Merge moves choices (the later choice wins; a stop always survives).
- Consent to texts, what a stop must cover and how long logs are kept: for the business to confirm
  with its lawyer.

## Out of scope

- Broadcasts, newsletters and campaigns; two-way texting and a shared inbox (stage 36).
- Journeys' engine and its steps (Journeys uses this stage's register, quiet hours and channels).
- Free texts or pushes written by a person or an AI.
- Moving order confirmations, sign-in codes or agreement copies onto routine messages.
- Badges, rich pushes with pictures, in-app inboxes for members.
- Messaging apps other than text, and voice calls.
- Per-member quiet hours; reselling texts.
- Staff notices by text.

## Acceptance criteria

1. A Bookings reminder with text and push words declared, all three channels switched on: a member
   with the app gets a push and an email and no text; a member without the app with a textable
   mobile gets a text and an email; one with neither gets an email. Each is a row with its status.
2. A pack declaring only email behaves exactly as today (ADR 0590's tests pass unchanged).
3. A class title an AI changed holds the email, text and push alike until a person approves.
4. A number an AI added to a Person is never texted; one a person added, the member's own checked
   one, or one checked by code is; a number checked by another Person is not.
5. The contract check refuses text words that could exceed two segments, push words over the
   bounds, a slot not declared, a private slot in push words, an essential follow-up, and any of it
   from a runtime extension.
6. A failed renewal emails, pushes or texts the payer once (not on the retry) in the business's
   words with the amount and next try, linking only to the business's site; 3 days before access
   would stop, and when it stops, they are told again; a card expiring is told once 14 days before
   the end of its month, and not when the subscription ends before then; with the kinds off nothing
   goes and admins are still told.
7. The text gatekeeper refuses every caller's queue (a person, MCP, the assistant, an extension, an
   automation's own call, Code Mode); only the host's routine queue sends a text. The same for push,
   with the host's staff-notice queue as well. A test per caller class.
8. The fake text provider is refused in a live environment; swapping the provider changes one
   setting and one module and no host code (a test with two fakes).
9. A text reply of STOP stops all texts to that number; the next text is `stopped`; START lifts it;
   the number re-entered on another Person is not texted.
10. A reminder due at 11pm with quiet hours 9pm to 7am waits until 7am; one whose class starts at
    6:30am is `expired` and its email went at 11pm. An urgent cancellation of a 6am class texts at
    once; a cancellation of next week's class waits until 7am.
11. The text limit: with the month's spend at the limit the next text is `over_limit`, the email
    goes, admins are told once that day; two runs claiming at once cannot pass it; at 80% admins are
    told once.
12. A full pending pool at either new gatekeeper leaves rows waiting, each sent once there is room.
13. A device registers for push after sign-in; signing out or ending the session deletes it; a token
    the push service rejects is deleted.
14. A staff member who chose push for roster notices gets a push for a shift change; a `humanOnly`
    notice's push carries no body; staff quiet hours hold it.
15. A member turns off class reminders by text in their account; the next reminder comes by push or
    email only. They cannot turn off a cancellation's email.
16. The one-tap stop and the List-Unsubscribe header turn that scope off for that recipient without
    signing in; the token cannot turn anything on, works for one Person, channel and scope, and
    answers a bad token the same as a good one.
17. `contactDecision`: `news_and_offers` with no recorded yes is `no_consent`; for a child is `child`;
    a `follow_up` stopped by email is still sent by text; a refusal is never held for a person
    (tests the Journeys and inbox builds reuse).
18. A human admin publishes the business's words; the next message uses them; a draft an AI wrote
    is not used until a person publishes it; words with a link, an address or a phone number are
    refused; "reset" goes back to the declaration's.
19. Erase: a Person's rows, choices, phone checks and devices go; the suppression hash stays.
20. No AI actor can call `routineMail.settings.update`, `messages.wording.publish`,
    `person.contact.record`, record a yes or lift a stop (tests for the assistant and MCP).
21. Cost: preparing one message for one recipient reads a bounded number of statements across all
    channels (a statement-count test).
22. E2E, one per journey: a member sets their contact preferences and checks a mobile on the
    website; an admin rewords a kind and previews it.
23. `CONTEXT.md` (Routine message, Purpose, Consent register, Stop, Textable number, App device,
    Quiet hours, Text limit) and `docs/architecture.md` (push decided) are true; the site and
    `SITE.md` describe texts and pushes once they are built.

## Dependencies

- Built: routine mail (ADR 0590), subscriptions (stages 32a and 32b), staff notice delivery (6b),
  device sessions and the HTTP surface (23), client apps and the template (24).
- Should land first or alongside: issue #259's hardening (deferred runs cleaned up, the debounce)
  before texts cost money per send.
- Stage 48 (My account, PR #311): the shell this stage's customer section sits in. If it has not
  merged when step 5 builds, the section is built as a base-layer block and placed in the shell when
  it lands.
- Stage 47: the admin settings screens use the core settings pages; nothing waits for it.
- Needs real things (step 8): the business's own text provider account and sender number, push
  credentials for the first client's app, a real phone of each kind.
- Later stages that build on this: Journeys and stage 36 (the register, `contactDecision`,
  `stopLink`, quiet hours, the text gatekeeper), Reviews (a `follow_up` routine kind), stages 34, 35,
  37 and 39 (their own kinds and words), Forms (stage 29: a consent question records through
  `contact.recordFromForm`).

## Migrations and numbers

Block **BB**: migrations 0910 to 0929, ADRs 0670 to 0679. Expected:

- **0910**: `core_routine_mail` grows (channel, statuses, cost, segments, provider ref, delivered,
  wait until, and `until_at`, the kind's moment, for `expired`; automation and run nullable for host
  kinds). Built in step 1. `core_subscription`'s card expiry and sent markers were left to step 2,
  which owns their design: it takes the block's next free number (0915).
- **0911**: `core_text_spend`, `core_phone_check`.
- **0912**: `core_push_device`.
- **0913**: `core_contact_choice`, `core_contact_suppression`.
- **0914**: `core_message_wording`.

ADRs the build writes:

- **0670**: Routine messages: text and push on the routine mail path, rows per channel, host kinds
  (amends 0590).
- **0671**: Subscriptions' payer messages and the card's expiry (closes #215; replaces the
  provider's emails).
- **0672**: The text gatekeeper: the provider as a swappable connector on the business's own
  account, queue classes, the pending pool, STOP, START and HELP, the monthly limit.
- **0673**: Which number is textable: marks on phone numbers, checking by code.
- **0674**: Push: the push gatekeeper, app devices on device sessions, staff push (closes the
  architecture's "not decided").
- **0675**: Consent to be contacted: purposes, the register, `contactDecision`, the stop link and the
  public `contact.stop` (the seam for Journeys, the inbox and Reviews).
- **0676**: Quiet hours and urgent messages.
- **0677**: The business's wording.

## Suggested build order

The day-one pieces (decision 11) come first: texts, push, and the failed-payment and expiring-card
emails.

| Step | What | Areas | Beside | Collides with |
| --- | --- | --- | --- | --- |
| 1 | Routine messages: text and push words, rows per channel, the checks, quiet hours and urgent in the send path, host kinds' send path; Bookings' and Ticketing's text and push declarations | `packages/sdk/src/routine-mail.ts`, `packages/core/src/routine-mail/`, migration 0910, `apps/runner` integration host, `packs/bookings/routine-mail.ts`, `packs/ticketing/routine-mail.ts` | Steps 3 and 4's gatekeeper packages (not their glue) | Anything in `routine-mail/`, the packs' routine-mail files (Offers and Shop declaring kinds), the email gatekeeper's `routine.ts` |
| 2 | Subscriptions' host kinds and the card's expiry (#215), email first | `subscriptions/events.ts`, `sweep.ts`, `grants.ts`, `gatekeeper-payments` | 3, 4, 5, 6 | Anything in `subscriptions/` or `gatekeeper-payments` (stage 34's shared paid-another-way step, stage 48's `me.attention` reads) |
| 3 | Text gatekeeper (interface, fake, one provider module), textable numbers and marks on phones, checking by code, the monthly limit, receipts, STOP, START and HELP | new `packages/gatekeeper-text`, its glue in the integration host, `routine-mail/marks.ts`, migration 0911, `product.ts` gatekeeper settings | 2, 4, 5, 6 | `apps/runner/src/integrations/queue.ts` and `host.ts` (with step 4); `marks.ts` (any routine-mail work) |
| 4 | Push gatekeeper (prove the Worker reaches both push services first), devices, the template's app, staff push | new `packages/gatekeeper-push`, device operations, `templates/client/apps/mobile`, `notifications/` | 2, 3, 5, 6 | The integration host (with 3); `notifications/` (any staff notice work); the client template (stage 48 step 1) |
| 5 | The consent register, `contactDecision`, `stopLink`, `contact.stop` (public), the List-Unsubscribe headers, contact preferences blocks | new `packages/core/src/contact/`, migration 0913, `audiences` review, base-layer blocks, the email gatekeeper (headers) | 2, 3, 4, 6 | The audiences review; base-layer blocks in flight (stage 48); Journeys step 1 (which this replaces) |
| 6 | The business's wording, versions, preview | new `packages/core/src/routine-mail/wording.ts`, migration 0914, a settings screen | 2, 3, 4, 5 | Little |
| 7 | Delivery status, the Person's Messages card, the log screen, the coach swap kind (#238), e2e, `CONTEXT.md`, architecture, the site | `apps/app`, `packs/bookings`, `apps/marketing` | after 1 to 6 | Bookings pack work in flight |
| 8 | The first client: their own text provider account and sender number, push credentials, a real phone, the limit of 50, quiet hours, wording, turning the provider's failed-payment emails off, checking how members are reached today (decision 10) | runbook | — | — |

Step 1 is one session, alone. Then steps 2, 3, 4 and 5 can run at once, with 6 beside them; steps 3
and 4 both touch the integration host's queue: build them side by side but merge one before the
other. Texts reach members only once steps 3 and 5 are both in (a member must be able to stop
them); step 2's emails can go live as soon as it merges.

## Size

**Large.** After step 1, four or five sessions at once, then one for step 7.

## Decided by this spec, open to override

- Grow routine mail into routine messages; no second path. Keep the manifest key `routineMail`, the
  table `core_routine_mail` and the `routineMail.*` operations; new pieces get new names.
- Sign-in codes, agreement copies and order confirmations stay host mail.
- Texts and pushes have no free path in this stage (no person or AI sends one directly).
- A number is textable as an address is routine (marks: a person's, a default's, the member's own
  checked, or checked by code), not only after a code (the draft's rule). An AI's number never.
- Every text begins with the business's name and ends "Reply STOP to stop", added by the host and
  counted in its two segments. At most two segments; 5 texts and 20 pushes a day per person;
  countries limited to the business's own by default; a limit of 0 (texts off) until an admin sets
  one.
- STOP stops every text from the business to that number, whatever its purpose; START lifts it;
  HELP gets a fixed answer. Other replies are not read or stored until stage 36.
- "Urgent" lets a message through quiet hours only when its moment is before quiet hours end; the
  cancellation kinds are urgent.
- "A few days before access would stop" is 3 days before the 30-day grace ends.
- A failed payment's message is sent for the first failure of a run, not each retry; a new run of
  failures after a payment succeeded starts again.
- Quiet hours apply to texts and pushes only, business-wide; staff have their own. Journeys uses the
  same setting.
- One consent register with three purposes; a refusal is final and never held for approval; the
  stop link is the host's alone, signed, no expiry, turns off only.
- The provider's keys and the push credentials are Worker secrets set by a person (ADR 0452), as
  the payment provider's are.
- A push opens a declared app screen with a record id, never a web address. The app asks for push
  permission after the first booking, once.
- Staff notices never go by text. Staff see statuses, never the words, on a Person's record.
- Suppressions survive erase as salted hashes; merge keeps a stop.

## Risks

- **Security.** Two new gatekeepers that spend money or reach a phone; each must refuse every
  caller but the host's own queues (a test per caller class, as ADR 0645's amendment). The public
  stop operation is a new public write: signed, single purpose, can only turn off. A code sent to
  any number someone types is a way to text strangers at the business's cost: capped per Person,
  per number and per day, and counted against the limit.
- **Privacy.** Lock-screen pushes; phone numbers are personal data the log must not keep; a number
  reused by another person; health and pay never in a push.
- **Money.** Texts cost per segment and per country; a loop or an abuse must stop at the limit,
  counted at claim. The price per segment is the admin's estimate until the provider reports.
- **Needs real things.** The business's own provider account and sender number (and whatever its
  country asks of a sender, for the business to confirm with its lawyer); push credentials from the
  business's app developer accounts; a real phone of each kind; whether a Worker can reach both
  phone platforms' push services directly (one requires a connection type a Worker's outbound
  request may not offer; the fallback is relaying through the other platform's service, which can
  deliver to both); whether Email Service reports bounces; how the payment provider gives a card's
  expiry for each subscription's payment method.
- **Double messages.** If the provider's failed-payment emails stay on while the host's are on,
  members get two; the settings card says so and the runbook turns the provider's off.

## Questions for the owner

None. Decision 1 was the only real choice; everything else was decided as best practice above and
is open to override.
