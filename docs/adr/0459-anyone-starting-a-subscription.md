# ADR 0459: Anyone starting a subscription may sign in as a customer

Status: accepted, 2026-11-22 (`feat/signin-starting-a-subscription`; the owner's decision of
2026-11-22, recorded in ADR [0489](0489-one-free-trial-per-person-per-plan.md) and stage 32's
spec). Builds on ADRs [0402](0402-staff-and-customers.md),
[0455](0455-staff-invites-and-native-sign-in-by-tokens.md),
[0456](0456-the-hosts-sign-in-mail.md), [0458](0458-customer-sign-in-for-buyers.md) and
[0489](0489-one-free-trial-per-person-per-plan.md). No migration.

## Context
A course plan's free trial goes only to a holder who proved who they are (ADR 0489): a signed-in
customer, or staff. A guest who typed an address pays from the start (`noTrial: "sign_in"`), and
the subscribe block offers to sign in for the trial. A brand-new visitor has no account, and with
sign-up `invite_only` or `buyers` they cannot get one, so the trial was out of their reach unless
the business opened sign-up to anyone. The owner decided that a new visitor gets the trial by
confirming their email with a code first, then starting the subscription signed in: a new customer
sign-in setting, "anyone starting a subscription", set by a human admin like the existing modes.

## Decision

### What the setting allows
- **A switch on top of the mode, not a fourth mode.** `customer.settings` gains
  `startingSubscription` (default `false`, stored under `customer_signup_subscribers`). The modes
  nest (`invite_only` within `buyers` within `open`), and this adds to whichever is set, so
  "members plus buyers plus anyone starting a subscription" is `signup: "buyers"` with
  `startingSubscription: true`. With `open` it changes nothing.
- **When it is on and the host has a plan on sale**, an address with no account may get a sign-in
  code (`customerCodeReason` answers `subscription`), and entering it makes a customer account
  linked to its Person exactly as for the other modes (`linkCustomer`: the one Person with the
  address, a new Person when none has it, `needs_merge` when several do).
- **What it amounts to, plainly:** while a plan is on sale, anyone can make a customer account
  with any address they can read mail at. The account is a customer account like any other: it
  reads what the visibility seam gives every signed-in customer (ADR 0447) and their own records,
  and nothing it did not have before as the public, except what "signed in" adds. It is not tied
  to starting the subscription: a person may confirm their address and never subscribe. The
  setting's label in Settings → Users says this ("While a plan is on sale this means anyone can
  make a customer account"), and so does the operation's description. A business that does not
  want that leaves it off; its visitors then pay from the start, or it invites them.
- **"A plan on sale"** is exactly what `subscription.start` would accept from a guest, read with
  the same function (`hasPlanOnSale`, which calls `priceLines` as the public with `plans: true`):
  a live (not in the Trash) record of a recurring sellable object that the public may read, priced
  above nothing in the orders' currency, inside its sale window, with a payments connection to open
  the provider's page with. A plan only staff or customers can read does not count. It is a fact
  about the host, the same for every address. The first 50 public records of each plan object are
  priced; a host with more, none of the first 50 on sale, reads as having none (errs shut). If the
  check fails (the database cannot be read), no new address gets a code.
- **Checked twice, as for the other modes:** when the code is asked for, and again when Better
  Auth creates the account at sign-in. A code sent while a plan was on sale makes no account once
  none is (the sign-in fails with the one "Invalid code" answer). An existing account signs in by
  the `account` rule, whatever the setting says later.
- **Unchanged for every mode:** an erased person's address never gets a code; a disabled account
  never signs in.

### Abuse
The setting lets anyone make the host email a code to any address, which `open` already did and
the other modes did not. What limits it:
- **The limits every code request has** (`docs/deploying.md`), counted before a code is made or
  stored: per address asked for, 3 per 60 s (`CUSTOMER_CODE_RATE_LIMIT`, key `code:<address>`);
  per client address, 10 per 60 s (`CUSTOMER_CODE_ADDRESS_RATE_LIMIT`, a keyed hash of the IP,
  which is never stored). A native app's request carries the client's IP the same way (ADR 0455),
  so it is counted with the browser's. There is no per-device limit: a device has no identity
  before it signs in.
- **New: a host-wide limit on the codes this rule sends**, 20 per 60 s
  (`CUSTOMER_CODE_NEW_RATE_LIMIT`, one key `code-new`, namespace 4107). It counts only codes the
  `subscription` reason sends, the one reason a stranger can bring about for an address with no
  account and no history. Over it, that address gets nothing and the same answer as a sent code; a
  member, an invitee or a buyer still gets theirs, so a flood cannot lock existing customers out.
  The host logs a warning. Like every Workers limit it is per Cloudflare location and approximate.
- **Nothing is written by asking:** no account, Person or invite. Better Auth stores the hashed
  code (and removes it at once when the rule says no, as for every mode); the account and, if
  none had the address, the Person are made only when the right code is entered. (A guest who
  subscribes without signing in already makes a Person for the address they typed, as a guest
  order does, ADR 0428; that is unchanged and is not this setting.)
- **No address enumeration:** the browser and native code routes answer every address the same,
  sent or not, on or off, and the limit's refusal is the same for everyone. The setting reveals
  only what the business shows anyway (that it sells a plan). Response timing is not equalised,
  as it is not for the other modes.
- **Sign-in mail is the host's own kind** (`email.signin`, ADR 0456): the fixed code template,
  through the connection a human admin chose, applied without review only once an admin lets it.

### The trial, unchanged
A customer who signed in this way and starts a plan is a signed-in customer starting their own:
the trial rule (ADR 0489) applies as it is. One trial per Person per plan object; the hold and
the provider's confirmation work as before. So **one trial per confirmed address**, and plainly:
a person who can read mail at a second address gets a second account, a second Person and a
second trial, until staff merge the two People (a merge keeps one trial row per plan object,
ADR 0487). The rule is per Person, and a Person is known by their address; nothing here tells two
addresses of one person apart. The provider may notice a card used twice; the host does not.

### The flow
- **On the plan, on the web.** The subscribe block (`courses-subscribe`) takes an optional
  `signIn` (`requestCode`, `confirm`: the web sign-in block's two calls, `/auth/code` and
  `/auth/sign-in` in a client app). A guest subscribes with their address; told the trial is for
  signed-in members, they press "Email me a code for the free trial", enter the code there, and the
  block starts the same plan again signed in, so they go on to the provider's page with the trial.
  Without `signIn`, `onSignInForTrial` (now given the plan's id) or `signInUrl` are as before.
  `/blocks` (development) gives the host's own customer sign-in for `"signIn": "customer"`.
- **Native stays read only for billing**: no native block changes.

### Who sets it
`customer.settings.update` (`settings:manage`, `actors: ["human"]`, `mcp.expose: false`, audited
as a settings change), from Settings → Users under "Who can sign in as a customer": "Also anyone
starting a subscription", with a note when no plan is on sale (`customer.settings.get` now says
`planOnSale`). Not in `product.ts`, not set by a deploy, never by an AI (ADR 0458's reasons).

### Operations whose exposure or behaviour changes
- `customer.settings.update`: new optional input `startingSubscription`. Audience, permission,
  risk and actors unchanged (staff, `settings:manage`, write, human only, not on MCP).
- `customer.settings.get`: new outputs `startingSubscription` and `planOnSale`. Unchanged (staff,
  `records:read`).
- No operation is opened to `customer` or `public`. What changes for the public is the customer
  sign-in routes (not operations): `POST /api/customer-auth/email-otp/send-verification-otp`,
  `POST /api/customer-auth/sign-in/email-otp`, `POST /api/v1/auth/customer/code` and
  `POST /api/v1/auth/customer/sign-in` now send a code to, and make an account for, a new address
  when the setting is on and a plan is on sale.

## Why
- The emailed code proves the visitor controls the address, which is what the trial rule needs
  (the holder is proved). Signing in first keeps the guest's answer uniform (ADR 0489): no
  stranger learns whether an address had a trial.
- A switch on top keeps the modes as they are and makes every combination the owner named
  expressible, without a mode for each.
- Tying it to a plan on sale keeps it closed on a host that sells nothing to subscribe to, so
  turning it on early does not open sign-up.

## Proof
`packages/core/test/customer-starting-subscription.test.ts` (the rule, the combinations, what is
on sale, nothing written, the trial once per Person and again for a new address, human admins
only), `apps/app/test/subscriber-sign-in.test.ts` (the real routes, web and native: the same
answer on and off, the account made only at sign-in, a code refused once no plan is on sale, the
host-wide limit), and the e2e `apps/app/e2e/subscriber-sign-in.spec.ts` (with it off the
visitor's address gets no code; an admin turns it on in Settings → Users; the visitor subscribes
as a guest, confirms the code on the plan, pays on the fake provider's page with the trial and
holds the courses). Each check removed, its test failed:

| Check removed | Test that fails |
| --- | --- |
| The setting's guard (`loadCustomerSignupSubscribers`) | off: a new address gets nothing |
| A plan on sale (`hasPlanOnSale`) | on, with none on sale: no new address |
| Priced above nothing | a plan with nothing to pay is not on sale |
| The second check, when the account is made | a code sent while a plan was on sale is refused once none is |
| The host-wide limit on `subscription` codes | over it, a new address gets nothing |

`actors: ["human"]` and `mcp.expose: false` on the setting are the operation's as before; the test
asserts both and that MCP, the assistant, automations and a member are refused. A plan the public
cannot read is held out twice (the public source, and `priceLines` as the public), so removing
one alone fails no test.

## Consequences
- A business selling a plan with a trial turns it on once, on Settings → Users, alongside its mode.
- `cos deploy` creates the new rate-limit binding with the others (`apps/app/wrangler.jsonc`); a
  deployment missing it is not limited host-wide and logs a warning, as for every binding.
- Not built: a client app's own sign-in page returning a visitor to a plan (`signInUrl` still
  only goes there); an inline code step for other blocks.
