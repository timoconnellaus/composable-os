# ADR 0715: The account blocks: signing in again in place, a deliberate deletion and one subscriptions part

Status: accepted, 2026-11-25 (stage 48, build steps 7 and 8). Builds on ADRs
[0710](0710-my-account-the-portal-declaration.md), [0711](0711-needs-your-attention.md),
[0712](0712-changing-the-sign-in-address-and-a-recent-sign-in.md),
[0713](0713-deleting-an-account-the-preview-and-its-consequences.md),
[0714](0714-the-app-shows-money-and-opens-the-website.md), [0424](0424-blocks-as-built.md) and
[0540](0540-the-family-link.md).

## Context

The host's side of My account was built in steps 1 to 6: what needs attention, which sections a
customer has, changing the sign-in address after a recent sign-in, and deleting the account with a
preview. The blocks that show them, and the Memberships, Courses and Bookings sections, were left
for step 7. Three questions had no answer in the spec's words: how a block leads a member "back
through sign-in" when the host says `sign_in_again`; how deliberate the final confirmation of a
deletion is; and what "consolidated" means for the packs' sections.

## Decision

- **Signing in again happens in place.** The account blocks that need a recent sign-in
  (`*-account-email`, `*-account-delete`) take `signIn`, the app's own sign-in by code
  (`AccountSignIn`: `requestCode`, `confirm`; the web template's `/auth/code` and `/auth/sign-in`,
  the mobile app's session). On `sign_in_again` the block asks for a code to the customer's own
  sign-in address, signs them in with it (a new session, so a recent one), and runs what they were
  doing again, keeping what they typed (the new address, the code from the new address). Leaving
  the page for the sign-in route and back would lose it, and put it in the address bar.
  `sensitive()` in the account entry makes the refusal its own outcome, never a failure and never
  done.
- **Deleting is two steps, the second deliberate.** The block first asks the host for the preview
  and shows all of it (each subscription that ends and how, the unpaid orders cancelled, what stays
  for staff, the erase due date). The confirm button is enabled only once the customer types
  DELETE, and it sends the preview's `expect`: `deleteConfirmInput` returns nothing without a
  preview the host gave, so the block has nothing to confirm. A preview that changed meanwhile is
  asked for and shown again; after a fresh sign-in the preview is asked again before anything else.
- **Delete my account is a base section** (`delete`, last, order 99), listed by `me.portal` for
  every customer like the other base sections, so the host's list stays the one list of sections.
- **Needs your attention leads only where the host listed.** `attentionTarget` maps an item to a
  section the shell shows: agreements, Payment method for a failed card, Orders for an order, the
  pack's section for a pass (its object's pack) or a trial (its plan's pack), the provider's page
  for a payment the bank waits on (from the subscription the host listed; in the app, the website
  instead), and the form by its personal link (`onFillForm`). It is a lookup over the host's
  answers, never a rule; an item with nowhere to go is still listed.
- **One subscriptions part.** `web-account-subscriptions` and `native-account-subscriptions` take
  any hooks over `subscription.list`, `.cancel` and `.resume` (`SubscriptionsPartHooks`), so a pack's
  section passes its own; a pack adds its own lines (`about`) and buttons (`change`). Memberships'
  and Courses' blocks use it and lose their own card buttons: the card is Payment method's, once.
  Courses' section is a new export, `MyCoursesSection` (`MyCoursesSectionScreen` in the app): its
  courses, then its subscription. In the app the shell gives each pack's screen `onManage`, which
  opens the website account page (ADR 0714).
- **A parent sees a child's memberships and passes** in the Memberships section, under the child's
  name, from `mine` with the child's id, which the host answers only for a linked child where the
  object opens to guardians. Bookings' blocks read `me.family` (ADR 0540 as amended).
- **The staff card** on a Person's page calls the admins' operations (`customer.disable`,
  `.enable`, `.revokeSessions`, `.changeEmail`, `.cancelEmailChange`) and shows what the host
  refuses. It shows an open address change only as `customer.list` gives it (masked) and never a
  code.

## Consequences

- A client app's shell takes `signIn` and `onDeleted`; an app that copied the shell before this
  step adds them when it upgrades (`cos diff web-account`).
- Courses' portal declaration names new exports; `cos upgrade` writes `account-sections.gen.ts`
  again.
- Not tried on real phones, or against the app stores' rules on account deletion and on linking to
  the website for paid memberships: those are for the business to check.

## Rejected

- **Sending the member to the sign-in route with a return address.** It loses what they typed and
  puts their new address in the URL.
- **A checkbox as the deletion's confirmation.** Too easy to tick past; typing a word is the
  convention for an act that cannot be undone from the member's side.
- **Each pack keeping its own subscription list with a card button.** A member with a membership
  and a course subscription saw two "update card" buttons for one card (the spec's finding 5).

## Amended 2026-11-26: signing in again ends the session it replaces

Found at the review of PR #467: after an in-place sign-in the session it replaced stayed valid on
the host until it expired, and showed as a second "this device", while staff on a phone end theirs
first (`staffSession`'s `endPrevious`). **The host now ends it, once the new sign-in has worked**
(a wrong code ends nothing, so the member is never left signed out):

- **Web.** The customer sign-in's `/sign-in/email-otp` (`customerIdentity().handle` in
  `packages/auth`) reads the session the request's cookie names before signing in, and after a
  successful sign-in deletes that `core_customer_session` row. The web app's `/auth/sign-in`
  forwards the browser's cookie (`forVisitor`), so nothing changes in the template.
- **App.** `/api/v1/auth/customer/sign-in` takes an optional `replaces`: the refresh token of the
  device session being replaced. After the new device session is issued, the host ends that one
  as `/auth/sign-out` would (`signOutDeviceSession`: holding its refresh token is the proof; any
  other token ends nothing). `tokenSession.signInWithCode` in `@composable-os/client` sends it
  from the store for a customer, so the template's `hostSession` needs no change.

Host-side rather than in the templates: a copied app or an adopted site gets it without editing
its own code, and ending the old session before the code is checked (as `endPrevious` does) would
sign the member out on a mistyped code. Tests: `packages/auth/test/customer-auth.test.ts`,
`apps/app/test/company-web.test.ts`, `apps/app/test/native-sign-in.test.ts`,
`packages/client/test/client.test.ts`.

## Amended 2026-11-26: the rest of the review of PR #467

- **A shell draws only the base sections it has a part for.** `portalSections` takes `base`, the
  keys a shell draws; both shells pass theirs. A base section a newer host lists that an older
  copy has no part for (as Contact preferences and Delete my account were added after the first
  shells were copied) is left out, not shown as a heading with nothing under it. Without `base`
  every listed base section is kept, so a shell copied before this keeps working as it did.
- **A deletion forgets at once.** `useDeleteAccount` removes every query from the app's cache once
  the host answers that the account is deleted, when the app made the hooks with its
  `useQueryClient`. The native block calls its `endSession` prop (the app's `session.signOut`:
  it forgets the stored tokens) as soon as the deletion is done (`confirmDelete`), so a relaunch
  before "Leave" finds no session. `onDeleted` stays where the app goes after.
- **Money owed on an order leads to paying it.** `balance_due` and `finish_paying` lead to the
  order itself in Orders (`attentionTarget`'s `order`). On the web the order's row pays it with
  the existing `order.checkout` for the customer's own order (`useCheckoutOrder`, coming back to
  the shell's `returnUrl`); no operation is added. In the app the item and the row's "Pay on the
  website" open the website (ADR 0714); the block lint refuses `useCheckoutOrder` in a native
  block.
- **Only `https:` is followed.** An address the host gave (a provider's page to confirm a
  payment, a checkout) is followed only when it is `https:` or a path on the site
  (`followableUrl`).
- **The template mobile app's Account tab is the native shell** (criterion 12): `cos create
  --with-mobile` copies `native-account` with its sections and writes its
  `account-sections.gen.ts`.

Tests: `packages/client/test/account-acts.test.ts`, `blocks/test/account.test.tsx`,
`apps/app/e2e/my-account.spec.ts` (paying from an attention item).
