# ADR 0905: The purchase scan over a client's own app code

Status: accepted, 2026-11-24 (stage 63 steps 1 to 3, `feat/stage-63-app-cli`). Amends
[ADR 0490](0490-the-course-plan-self-service-and-the-staff-side.md); builds on
[ADR 0478](0478-the-courses-pack.md).

## Context
Nothing is bought in the app (stage 63, decision 8; ADR 0490): buying and billing stay on the
website, so the stores' own payment rules never apply. The block lint (`scripts/check-blocks.mjs`)
holds the platform's blocks to it: no billing operation in any native block, and no buying in a
`noPurchase` one. It runs on the platform's blocks only. A client's own app code, and a copied
block a client has edited, were held to nothing.

## Decision
- **`cos app check` scans the client's app code** (every script file in the mobile app's folder,
  copied blocks included, but not the generated client or the native projects the build makes)
  and refuses a buying or billing operation named as a string (`order.start`, `order.checkout`,
  `order.cancel`, the subscription's `start`, `cancel`, `resume`, `portal`, `change` and `pause`,
  a pack's `buy`, `orderStart`, `checkout` and `subscribe`) and a buying hook called in code
  (`useBuy…`, `useCheckout…`, `useOrderStart`, `useSubscribe` and the subscription's billing
  hooks). Reading what a person holds (`order.get`, `subscription.list`) and showing it, prices of
  what was bought included, is fine; a word in a comment or in copy is not code.
- **One set of rules for both checks**: the operation patterns, the billing hooks and the reader
  that blanks comments and strings live in `packages/create-composable-os/src/purchase-rules.ts`,
  which the block lint imports. The block lint's own rules (prices in a `noPurchase` block, the
  operations a block's `block.json` must list) are unchanged.
- **`purchases: "none"`** in `mobile.app` is the only value `defineClientProduct` accepts
  (ADR 0900), until a later stage decides selling in the app (issues #194 and #237).
- It is a product rule, not a security boundary: the host still decides every call.

## Consequences
- A client that wires a buy button into its app is told at `cos app check`, before a store build,
  with the file and line.
- The same check refuses an app without "Delete my account" (nothing in it calls
  `me.deleteAccount`), which the stores require of an app accounts are made in. The template's app
  has none until stage 48's native account shell is in it (stage 63 step 6), so a new client repo's
  `cos app check` fails on it until then.

## Tests
`packages/create-composable-os/test/app.test.ts` (`scanPurchases`, and `cos app check` refusing an
operation and a hook with the file and line, passing the template's own app);
`scripts/check-blocks.test.mjs` unchanged and passing on the shared rules.
