# ADR 0459: Anyone starting a subscription may sign in as a customer

Status: accepted, 2026-11-22 (`feat/signin-starting-a-subscription`; the owner's decisions of
2026-11-22, recorded in ADR [0489](0489-one-free-trial-per-person-per-plan.md), stage 32's spec,
and below; amended after review the same day, before merging). Builds on ADRs
[0402](0402-staff-and-customers.md), [0419](0419-native-sessions-and-customer-sign-in.md),
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
  `startingSubscription: true`. With `open` it changes nothing now; it is kept, and applies again
  if the mode changes back (Settings → Users says so).
- **When it is on and the host has a plan on sale**, any address with no account may get a
  sign-in code (`customerCodeReason` answers `subscription`), and entering it makes a customer
  account linked to its Person exactly as for the other modes (`linkCustomer`: the one Person
  with the address, a new Person when none has it, `needs_merge` when several do or that Person
  already has another account).
- **Including people already in the records (the owner's decision, 2026-11-22).** An address
  with no account may already belong to a Person with history: a contact staff entered, a past
  guest buyer, someone imported. The switch lets that address in too, and the account links to
  that Person, so after confirming the address its holder sees that Person's own records: their
  orders, tickets and subscriptions (and, when they start a plan, the payer's earlier provider
  customer is reused, as for any signed-in customer, ADR 0487). That is deliberate: existing
  contacts are exactly who should be able to start a trial, and it is what `open` already does.
  The code goes to the address, so only whoever reads its mail signs in.
- **What it amounts to, plainly:** while a plan is on sale, anyone can make a customer account
  with any address they can read mail at, and anyone already in the records can sign in to see
  their own records. The account reads what the visibility seam gives every signed-in customer
  (ADR 0447) and their own records. It is not tied to starting the subscription: a person may
  confirm their address and never subscribe. The settings label, the operation's description and
  this ADR say so. A business that does not want that leaves it off; its visitors then pay from
  the start, or it invites them.
- **"A plan on sale"** is exactly what `subscription.start` would accept from a guest. Both read
  one setup function (`subscriptionSetup`: at least one return origin, the orders' currency, a
  payments connection), so they cannot drift; the plan is read with the same function
  (`priceLines` as the public, `plans: true`): a live (not in the Trash) record of a recurring
  sellable object the public may read, priced above nothing, inside its sale window. A plan only
  staff or customers can read does not count. It is a fact about the host, the same for every
  address. If it cannot be answered, it is no (see "When it cannot be answered").
- **Checked twice, as for the other modes:** when the code is asked for, and again, worked out
  afresh, when Better Auth creates the account at sign-in. A code sent while a plan was on sale
  makes no account once none is (the sign-in fails with the one "Invalid code" answer). An
  existing account signs in by the `account` rule, whatever the setting says later.
- **Unchanged for every mode:** an erased person's address never gets a code; a disabled account
  never signs in.

### A plan going on sale opens sign-up
The switch is a human admin's, but what it does depends on data other writes change: whoever
publishes, prices or restores a plan (staff, an automation, an AI change a person approved, or one
that applies without review where the policy allows it) opens customer sign-up to anyone at that
moment. So:
- **The host remembers what it last saw** (`customer_signup_subscribers_state`: on sale or not,
  which plan, when). Turning the switch on records what is on sale then, so the admin's own act is
  not reported back to them.
- **When it goes from not on sale to on sale while the switch is on**, every admin is told once
  ("Customer sign-up is now open to anyone": which plan went on sale, and who last changed it,
  from the audit log, when known) and an audit row is written (`customer.signupOpened`, actor
  `automation` with origin `system`, the plan and who changed it).
- **Looked at** on every code request the switch could answer, and on the runner's minute tick,
  so it is reported within a minute even before anyone asks.
- **Why this is accepted rather than tied to who made the change:** gating each plan write on the
  switch would make pricing a plan an identity-policy act, which it is not, and it would not stop
  a human doing it. The switch is the policy and only a human admin sets it; what an admin needs
  is to know at once when the condition it waits on becomes true, and to be able to turn it off.
  The settings note does not reassure: it says sign-up opens to anyone the moment a plan goes on
  sale, whoever publishes or prices it.

### Abuse
The setting lets anyone make the host email a code to any address, which `open` already did and
the other modes did not. What limits it:
- **The limits every code request has** (`docs/deploying.md`), counted before a code is made or
  stored:
  - per mailbox asked for, 3 per 60 s (`CUSTOMER_CODE_RATE_LIMIT`, key `code:<mailbox>`). The key
    folds a `+tag` away on every domain, and on Gmail (`gmail.com`, `googlemail.com`) the dots
    too, so `a+1@x.com` and `a+2@x.com` share one allowance. Only the key: the account, the Person
    and the address mailed stay as typed. Staff code requests share this function and so this
    tightening;
  - per client, 10 per 60 s (`CUSTOMER_CODE_ADDRESS_RATE_LIMIT`, a keyed hash, never stored). An
    IPv6 client is now counted by its /64, the block one subscriber is usually given, so stepping
    through one's own addresses does not get round it: a tightening of ADR 0419's limit, for
    every code request (customer and staff) and for the sign-in attempts the same binding counts.
    IPv4 is per address, as before. A native app's request carries the client's IP the same way
    (ADR 0455). There is no per-device limit: a device has no identity before it signs in.
- **A host-wide limit on the codes this rule sends**, 20 per 60 s (`CUSTOMER_CODE_NEW_RATE_LIMIT`,
  one key `code-new`, namespace 4107). It counts only codes the `subscription` reason sends.
  - Over it, that address gets nothing and the same answer as a sent code; a member, an invitee
    or a buyer still gets theirs, so a flood cannot lock existing customers out. Admins are told
    ("New visitors are not getting sign-in codes"), once an hour while it lasts.
  - **Without the binding, no such code is sent** (shut, not open), and a warning is logged;
    every other reason is unaffected. The binding is in `apps/app/wrangler.jsonc`, so it is in the
    release manifest; a fresh install creates it, and an existing host gets it at its next update
    (Settings → Updates or the CLI), which uploads the Worker with the release's bindings. A rate
    limit binding needs no account setup. Like every Workers limit it is per Cloudflare location
    and approximate.
- **Nothing is written by asking:** no account, Person or invite. Better Auth stores the hashed
  code (and removes it at once when the rule says no, as for every mode); the account and, if
  none had the address, the Person are made only when the right code is entered. (A guest who
  subscribes without signing in already makes a Person for the address they typed, as a guest
  order does, ADR 0428; that is unchanged and is not this setting.)
- **No address enumeration:** the browser and native code routes answer every address the same,
  sent or not, on or off, limited or not. The setting reveals only what the business shows anyway
  (that it sells a plan).
- **Sign-in mail is the host's own kind** (`email.signin`, ADR 0456): the fixed code template,
  through the connection a human admin chose, applied without review only once an admin lets it.
- **Known, left as they are:** response timing is not equalised, as for the other modes; and one
  person with many addresses can get many trials (below; plus addresses are the cheap case, and
  the owner has an issue for it).

### What it costs, and when it cannot be answered
- SQL narrows the candidates where the public can read the fields: price above nothing, and
  inside the sale window by day; `priceLines` decides. Rows are taken in id order, at most 50 per
  plan object.
- A code request may reuse the answer worked out in the last 60 seconds, in that isolate. So a
  plan put on sale can take up to a minute to let codes out, and one taken off sale can let a
  code out for up to a minute, which then makes no account: the check when the account is made,
  and every staff read, always work it out again.
- **When it cannot be answered** (more than 50 candidates of a plan object, none of them on sale;
  or the plans cannot be read), it is no: no new address gets a code, and admins are told once a
  day that the switch is doing nothing.

### The trial, unchanged
A customer who signed in this way and starts a plan is a signed-in customer starting their own:
the trial rule (ADR 0489) applies as it is. One trial per Person per plan object; the hold and
the provider's confirmation work as before. So **one trial per confirmed address**, and plainly:
a person who can read mail at a second address gets a second account, a second Person and a
second trial, until staff merge the two People (a merge keeps one trial row per plan object,
ADR 0487). The rule is per Person, and a Person is known by their address; nothing here tells two
addresses of one person apart (plus addresses included: the folding above is for the rate limit
only). The provider may notice a card used twice; the host does not.

### The flow
- **On the plan, on the web.** The subscribe block (`courses-subscribe`) takes an optional
  `signIn`: `requestCode` and `confirm`, the web sign-in block's two calls (`/auth/code` and
  `/auth/sign-in` in a client app; `confirm` gives the `account` the host's answer carries). A
  guest subscribes with their address; told the trial is for signed-in members, they press "Email
  me a code for the free trial", enter the code there, and the block starts the same plan again
  signed in, so they go on to the provider's page with the trial. "Send me a new code" asks again
  after a wrong or expired code, without leaving the plan.
- **When the account waits for staff** (`needs_attention`: several People have the address, or
  its Person already has another account), the session is not a customer's yet. The block does
  not strand the visitor: it says the record needs sorting out before the trial and that the team
  has been told, shows the email field again, and lets them subscribe as a guest and pay from
  today. Staff are told by the existing merge notice ("A customer account needs a merge").
- Without `signIn`, `onSignInForTrial` (now given the plan's id) or `signInUrl` are as before.
  `/blocks` (development) gives the host's own customer sign-in for `"signIn": "customer"`.
- **Native stays read only for billing**: no native block changes.

### Who sets it
`customer.settings.update` (`settings:manage`, `actors: ["human"]`, `mcp.expose: false`, audited
as a settings change), from Settings → Users under "Who can sign in as a customer": "Also anyone
starting a subscription", with whether a plan is on sale now (`customer.settings.get` says
`planOnSale`), and, when the mode is `open`, that the stored switch is kept and applies again.
Not in `product.ts`, not set by a deploy, never by an AI (ADR 0458's reasons).

### Operations whose exposure or behaviour changes
- `customer.settings.update`: new optional input `startingSubscription`. Audience, permission,
  risk and actors unchanged (staff, `settings:manage`, write, human only, not on MCP).
- `customer.settings.get`: new outputs `startingSubscription` and `planOnSale`. Unchanged (staff,
  `records:read`).
- `subscription.start`: unchanged in audience and answers; it now reads the return origins,
  currency and payments connection through `subscriptionSetup`, as "a plan on sale" does.
- No operation is opened to `customer` or `public`. What changes for the public is the customer
  sign-in routes (not operations): `POST /api/customer-auth/email-otp/send-verification-otp`,
  `POST /api/customer-auth/sign-in/email-otp`, `POST /api/v1/auth/customer/code` and
  `POST /api/v1/auth/customer/sign-in` now send a code to, and make an account for, an address
  with no account when the setting is on and a plan is on sale; and their limits are tightened
  (mailbox folding, the IPv6 /64).

## Why
- The emailed code proves the visitor controls the address, which is what the trial rule needs
  (the holder is proved). Signing in first keeps the guest's answer uniform (ADR 0489): no
  stranger learns whether an address had a trial.
- A switch on top keeps the modes as they are and makes every combination the owner named
  expressible, without a mode for each.
- Tying it to a plan on sale keeps it closed on a host that sells nothing to subscribe to, so
  turning it on early does not open sign-up; and admins hear at once when that changes.

## Proof
`packages/core/test/customer-starting-subscription.test.ts` (the rule, the combinations, what is
on sale and its return origins, nothing written, an existing Person linked and seeing their order,
the mailbox key, the memo and the fresh recheck, a plan going on sale reported once and audited,
the unanswerable case, the trial once per Person and again for a new address, human admins only),
`packages/auth/test/client-address.test.ts` (the IPv6 /64), `apps/app/test/subscriber-sign-in.test.ts`
(the real routes, web and native: the same answer on and off, the account made only at sign-in,
a code refused once no plan is on sale, the host-wide limit and its notice, and no code without
its binding), and the e2e `apps/app/e2e/subscriber-sign-in.spec.ts` (with it off the visitor's
address gets no code; an admin turns it on; the visitor subscribes as a guest, gets a wrong code
refused and a new one, confirms on the plan, pays on the fake provider's page with the trial and
holds the courses; the open mode shows the stored switch kept; and a visitor whose account waits
for staff subscribes as a guest while staff get the merge notice). Each check removed, its test
failed:

| Check removed | Test that fails |
| --- | --- |
| The setting's guard (`loadCustomerSignupSubscribers`) | off: a new address gets nothing |
| A plan on sale (`findPlanOnSale`) | on, with none on sale: no new address |
| Priced above nothing | a plan with nothing to pay is not on sale |
| The second check, when the account is made | a code sent while a plan was on sale is refused once none is |
| The host-wide limit on `subscription` codes | over it, a new address gets nothing |

`actors: ["human"]` and `mcp.expose: false` on the setting are the operation's as before; the test
asserts both and that MCP, the assistant, automations and a member are refused. A plan the public
cannot read is held out twice (the public source, and `priceLines` as the public), so removing
one alone fails no test.

## Consequences
- A business selling a plan with a trial turns it on once, on Settings → Users, alongside its mode.
- Not built: a client app's own sign-in page returning a visitor to a plan (`signInUrl` still
  only goes there); an inline code step for other blocks.

## Amended after review (2026-11-22, before merging)
A review found what follows; each is changed above, with a test. The switch's reach to people
already in the records was said ("no account and no history") but not what the code did; it is
now said, and confirmed by the owner. The host-wide limit failed open without its binding and only
logged when it tripped; it now fails shut and tells admins. The per-client limit counts an IPv6
/64, and the per-address limit a folded mailbox. A plan going on sale is reported and audited.
"A plan on sale" filters in SQL, is memoised for code requests only, tells admins when it cannot
be answered, and shares its setup (return origins included) with `subscription.start`. The block
asks for a new code and does not strand a visitor whose account waits for staff. Settings → Users
shows the stored switch when the mode is `open`. A sign-in request now loads the extensions'
objects itself before looking for a plan (it runs outside the pipeline, so in a fresh isolate the
plan objects could be missing and no code would go out).
