# ADR 0456: The host's sign-in mail, its own outbound kind

Status: accepted, 2026-11-21 (`fix/host-sign-in-mail`). Builds on ADRs
[0051](0051-outbound-approvals.md), [0419](0419-native-sessions-and-customer-sign-in.md),
[0429](0429-payments-gatekeeper-verified-events-and-refunds.md) and
[0455](0455-staff-invites-and-native-sign-in-by-tokens.md). Migration 0491.

## Context
The host sends sign-in codes itself, through the email-send gatekeeper on the connection chosen
for its mail. Email-send's only auto-approvable kind was `email.internal` (every recipient a
colleague), so a code to an outside address (every customer, and a coach with a personal address)
was always reviewed. ADR 0455 deletes a code whose send is queued, because whoever approved it
would read it in the preview. Together: customer sign-in could not work in production, and staff
sign-in only for colleague addresses.

## Decision
- **A separate kind, "Send sign-in codes"** (`email.signin` in email-send, `fake.signin` in the
  fake outbox), auto-approvable, for the host's sign-in code email only.
- **The gatekeeper decides it from two things the caller cannot forge:**
  1. *Who is calling.* The gatekeeper asks the session's approval queue `isHostSignInMail()`. The
     queue is the integration host's (`HostQueue`), made when the host opens the session, and it
     answers true only for a session opened by `callAsHost` with purpose `sign-in`. That RPC is
     reached only by the host's own code (`signInMailCall`, used by cos-app's sign-in routes); the
     `integration.call` operation, extension tools, automations, the assistant, MCP and Code Mode
     go through `call` or `openSession`, whose queues answer false. `callAsHost` with purpose
     `sign-in` takes only the method `send`, only on an org connection, only for the origins
     `system.customer-mail` and `system.staff-mail`, as the system user. Nothing in the request
     is a flag the gatekeeper trusts: the old path (`hostMailCall`, the system user over `call`)
     is an ordinary send.
  2. *What is sent.* The message is exactly the code template (`isSignInCodeMessage`,
     `packages/gatekeeper-email-send/src/sign-in.ts`): one recipient; no cc, bcc, reply-to, HTML
     or related records; subject `Your <product> sign-in code`; body `Your sign-in code for
     <product> is <six digits>.` and the fixed second sentence, word for word; the same product
     name in both. The fake outbox imports the same module, so the two decide identically.
  Anything else is the ordinary kind, decided as before.
- **Turned on by a human admin, never by default.** The kind is made known (auto-approvable, not
  auto-approved) by migration 0491 for email-send, and for any vendor when its connection is
  chosen as the host's mail (`customer.settings.update`), so it can be turned on before a code is
  asked for. Turning it on is `outbound.setAutoApprove` (human admins only, not on MCP, audited),
  from Settings → Users ("Send sign-in codes without review", with a confirmation) or Settings →
  Integrations. ADR 0452's `product.ts` gatekeeper settings are a gatekeeper Worker's vars and
  bindings, not approval policy, so `cos deploy` does not set it and no AI actor can.
- **Ready only when a code would go out at once.** `signInMailState` (core) evaluates the gate for
  the kind as the host's send would be (the policy and the deploy-time floor): customer and staff
  code requests answer `503 sign_in_not_set_up` until it says auto, with a message that names what
  to turn on (the kind, or the Balanced policy, or the floor). `customer.settings.get` returns the
  state as `signInMail`, and Settings → Users shows it with the switch. This is customer sign-in's
  settings screen too: there is no other.
- **A code never waits behind another send.** Email-send never ordered independent actions (its
  README: an auto-approved send must not wait for a reviewed one); the fake outbox did, and now
  treats sign-in mail as independent, as email-send does. The invite notice stays an ordinary send,
  may wait for review, and holds back nothing.

## Why
- The kind must be one a person turns on: loosening approval policy is a human admin's, and an
  outbound send to anyone's inbox is exactly what review is for. Narrowing it to one fixed message
  from one caller is what makes turning it on reasonable.
- Asking the queue, not reading a flag, puts the decision where the trust is: the integration host
  knows how it opened the session; the gatekeeper cannot know who wrote the request.
- ADR 0429's order confirmation is auto with no switch (`hostMessage`); a sign-in code is mail to
  an address someone typed, so it keeps the admin's switch.

## Proof
`packages/gatekeeper-email-send/test/session.test.ts`, `apps/runner/test/sign-in-mail.test.ts`,
`apps/app/test/host-sign-in-mail.test.ts` and the e2e `apps/app/e2e/staff-invite.spec.ts`. Each
check was removed and its test failed:

| Check removed | Test that fails |
| --- | --- |
| The queue's answer (every queue says host sign-in mail) | every other caller sending the same text gets the ordinary kind |
| Email-send asking the queue | an ordinary send from any other queue, whatever the text |
| Email-send's template check; the same product name in both | an ordinary send when the message is not exactly the template |
| The fake's template check | the host itself sending a message that is not the template |
| Whether the kind is turned on, in the readiness check | not ready while the kind is reviewed |
| cos-app's readiness check | a code request answers not set up and makes no code |
| `send` only, and the two origins only, for `callAsHost` sign-in | refused for another method or origin |
| The fake treating sign-in mail as independent | a code does not wait behind a send waiting for review |
| Making the kind known when the connection is chosen | the kind is known, not auto-approved |

The callers checked: a person over `integration.call`, MCP, the assistant, an automation, an
extension (the integration host's ordinary call, which extension tools use), and the system user
claiming customer mail over the ordinary call. An outside address gets its code once the kind is
on; with it reviewed, nothing is sent.

## Consequences
- A deployment that upgrades has customer and staff sign-in by code off until an admin turns the
  kind on; until then the request says what to do.
- Under the Cautious or Autonomous preset the answer follows the preset: Cautious never sends a
  code (sign-in by code is not set up), Autonomous sends every automation's mail anyway.
- The e2e journey no longer needs a same-domain address or an approval: the admin turns sign-in
  mail on, and the invitee is outside.

## Amended 2026-11-23 (ADR 0590)
Routine mail follows the same shape for a shipped pack's member email: the integration host's own
queue (`hostRoutineMail()`, answered only by its `sendRoutineMail` for a row it wrote) and the
message's shape decide email-send's `email.routine` kind; nothing in the request can claim it.

## Amended 2026-11-24 (stage 48: changing the sign-in address)
The sign-in kind covers three fixed templates, not one
([ADR 0712](0712-changing-the-sign-in-address-and-a-recent-sign-in.md)): the sign-in code, the
code sent to a new sign-in address ("Confirm your new … sign-in address", six digits, 15 minutes)
and the notice to the old address ("Your … sign-in address was changed", the new address only as
`<first character>•••@<domain>`). The rest of the rule is unchanged: only the host's sign-in queue,
only the exact words, one recipient, plain text.
