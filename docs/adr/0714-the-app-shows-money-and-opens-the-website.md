# ADR 0714: The app shows money and opens the website for it

Status: accepted, 2026-11-24 (stage 48, build step 1; interview decision 6). Amends ADR
[0490](0490-the-course-plan-self-service-and-the-staff-side.md). Builds on ADRs
[0401](0401-platform-packs-screens.md) and [0424](0424-blocks-as-built.md).

## Context

ADR 0490 made a subscription read only in the business's own app: the block lint refuses the
subscription's billing operations (`subscription.start`, `.cancel`, `.resume`, `.portal`,
`.change`, `.pause`) and their hooks in every native block. Its native block said "manage your
subscription on the studio's website" in words, with nothing to press. My account (stage 48) puts
a member's memberships, passes, orders and subscriptions in the app's Account tab, and the owner
decided (decision 6) that a member sees their membership there and opens the website to cancel,
change plan or update their card.

## Decision

- **A native block may link to the business's website account page.** The native account shell
  (`native-account`) takes `websiteUrl`, the website's account page, and its subscriptions part
  (`native-account-subscriptions`) and Payment method section (`native-account-payment`) show
  "Manage on the website", which opens that page in the browser (`openUrl`, React Native's
  `Linking.openURL` by default). The mobile template reads it from `extra.websiteUrl` in
  `app.json`, beside `hostUrl`.
- **It still calls no billing operation.** Both blocks are `noPurchase`; the block lint's native
  rule stands unchanged and passes over every native block. The link is an address, not a call:
  what the member may do there is the host's, on the website, through the web blocks.
- **The app shows money it does not take.** The native Orders section shows each order's amounts,
  tax, deposit, balance and refunds as the host gave them; paying a balance is on the website. The
  native subscriptions part shows each subscription's state in words, without its price.
- **Changing the sign-in address and deleting the account are not money**: they work in the app
  (later steps of stage 48).

## Consequences

- A client app sets its website account page in its mobile app's config. Where the business has no
  website, the button is disabled in the template; the blocks take any address the app gives.
- The app stores' rules on linking out for paid memberships are for the business to check; the
  link opens the business's own page, never the payment provider's.
- Not yet tried on real phones.
