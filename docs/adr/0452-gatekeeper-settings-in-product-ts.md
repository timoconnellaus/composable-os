# ADR 0452: Gatekeeper settings in a client's product.ts

Status: accepted, 2026-11-21 (client releases and environments fix). Builds on
[ADR 0169](0169-gatekeepers-in-releases.md), [ADR 0429](0429-payments-gatekeeper-verified-events-and-refunds.md)
and [ADR 0450](0450-client-environments.md).

## Context
A host installed from a release could install gatekeepers and take their secrets
(`--secret worker:NAME=VALUE`), but not their vars or bindings. The first client needs the
email-send gatekeeper's `ALLOWED_SENDER_DOMAINS` and `INTERNAL_DOMAINS` and its `send_email`
binding's limits, and the payments gatekeeper's `BASE_URL`, `STRIPE_ACCOUNT` and, so staging can be
tried before Stripe is connected, `PAYMENTS_FAKE_PROVIDER`. The payments runbook assumed a platform
checkout and a hand-edited runner config.

## Decision
- **`product.ts` names the gatekeepers and their settings**, for the product (`gatekeepers`) and per
  environment (`environments.<name>.gatekeepers`, over the product's), by short name. Listing one
  installs it. The type names the settings of the gatekeepers that take any (`email-send`,
  `payments`).
- **Only what the gatekeeper declares.** `cos deploy` checks every setting against the gatekeeper's
  plain vars in the release's manifest and refuses, before any call, an unknown setting (naming the
  ones it takes), a gatekeeper the release does not have, a secret, and a value the deploy derives
  (`BASE_URL`, which is `https://<the environment's host>/gatekeeper/<name>` in the manifest).
- **Applied as deploy-time configuration:** the vars into the deployment state's per-Worker `vars`,
  the `send_email` limits into its new `sendEmail` map, which the deploy engine writes into the
  binding. Upgrades keep both. The release is deployed byte-identical.
- **Secrets stay out of `product.ts`.** A person sets them as Worker secrets; after the deploy,
  `cos deploy` names each missing one with the command, and never prints a value.
- **The fake payment provider only where it cannot take real money:** `defineClientProduct` and
  `cos deploy` refuse `PAYMENTS_FAKE_PROVIDER: true` in a live environment (any not marked
  `live: false`, `live` itself, or a product without environments).

## Consequences
- `docs/deploying.md` has the client-repo Stripe steps and the email-sending setup.
- A gatekeeper added to the platform with settings needs its entry in `GatekeeperSettings` for the
  settings to be typed; `cos deploy`'s check against the manifest holds either way.

## Tests
`packages/create-composable-os/test/client-repo.test.ts`: staging and live with different settings,
the send_email limits on the binding, `BASE_URL` derived per environment, the missing secret named;
refused with no call to Cloudflare: a secret in `product.ts`, an unknown setting, the fake provider
on live, an unknown gatekeeper. `packages/product/test/product.test.ts`: the fake provider rule.
