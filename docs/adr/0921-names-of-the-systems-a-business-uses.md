# ADR 0921: Names of the systems a business uses: where a connector is defined, documented and listed, and never beside a business

Status: accepted, 2026-11-24 (stage 65 build, step 2). Amends the owner's rule of 2026-11-22
recorded in `scripts/check-stray-names.mjs` ("the repository does not name a client's suppliers").
Builds on ADR [0400](0400-a-general-host-and-products.md) (the stray-names lint). Spec:
[stage 65](../stages/65-booking-system-connection.md), decision 4 and "The naming rule (step 2)".

## Context

The repository is public. On 2026-11-22 the owner decided it names none of a client's suppliers:
its booking system, its course platform and its website CMS each had a rule in the stray-names lint
that failed in every file but the lint itself. Read together with what a business is doing (moving
its courses, keeping its booking system for months), a supplier's name says who the business is
and what it is leaving.

Stage 65 builds a connector for a booking system in this repository, as stage 61 does for
accounting (decision 4). A connector has to be named where it lives: its package, its gatekeeper's
vendor id, the catalogue entry an admin picks in Settings → Integrations, the integrations guide
and the site's list of connections. What must stay private is not that a connector exists but
which business uses it.

## Decision

**A system's name is allowed where its connector is defined, documented and listed, and nowhere
else.** For the booking system the lint's rule gains an `allow` list of exactly: the connector's
package (`packages/gatekeeper-booking-system-<system>/`), its ADR (0927), stage 65's spec,
`docs/integrations.md`, the catalogue (`packages/core/src/integrations/catalogue.ts`) and the site
(`apps/marketing/`, with `SITE.md`). The shared contract package, core, the runner, other specs and
ADRs, and stage 33's move still fail on it. The course platform and CMS rules are unchanged: they
have no connector, so their names stay allowed only in the lint.

**No file may say which business uses, used or is leaving any system.** A new rule, "a business
named beside a system", reads every file a supplier rule allows (marked `supplier` in `RULES`,
other than the lint and its tests) and fails on any line that names a client. Clients are:

- the labels in `products/*/product.ts`, except the platform's own products (the CRM, ADR 0400),
  whose label names no business;
- `CLIENTS` in the script, for clients with no product here. It is empty, and stays so until a
  client agrees to be named: a name written there is itself public;
- a phrase that points at one client without naming it: "first" or "our" just before "client".

The check is by line in the allowed files, not by line beside the system's name: a connector's
README that says who uses it three lines further down is the same disclosure.

**Elsewhere a client's name is not this lint's business.** The roadmap and older ADRs may say "the
first client"; they name no system, so they pass.

## Consequences

- A new connector for a named system (stage 33's move, a course platform) adds its own paths to its
  rule's `allow` in the PR that builds it, with a test, and is then held to the client rule there.
- The site's `SITE.md` can no longer say "the first client's set-up"; it says "a business's own
  set-up".
- A product added under `products/` for a client makes its label a client name at once. The
  platform's own products are listed in `PLATFORM_PRODUCTS` in the script.
- The lint cannot know every way a file might point at a business (a city, a street, a coach's
  name). Review still has to catch those; the rule catches the common ones.
