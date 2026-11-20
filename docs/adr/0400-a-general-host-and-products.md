# ADR 0400: A general host, and products composed on it

Status: accepted, 2026-11-20 (design conversation and stage 20 interview).

## Context
Relationship OS is a trusted host plus extensions. The host owns identity, one operations registry
exposed to the UI, MCP and extension code, the approval pipeline, audit and the gatekeepers.
Everything CRM-specific above People, Organisations, Activities and Tasks is already an extension
on the public contract (Deals, Leads, lifecycle).

Companies want software that fits them: Ghetto Movement wants to sell event tickets, has a website,
a staff app, a client app on phones and a TV app, and runs bookings and billing in Mindbody. Each of
those is the same shape as the CRM: records, rules, staff screens, AI access. What differs is the
set of objects and rules, and the customer-facing screens.

At the time of this decision nothing is installed anywhere: the repository has no releases, no
forks and no packages on npm.

## Decision
- **One platform, many products.** The host becomes a general platform, **Composable OS**
  (composableos.dev). A **product** is a named composition: which packs are on, the org's own
  extensions, its names and its client apps.
- **The CRM is the first product,** and it is called CRM. It is the platform plus the Deals, Leads
  and lifecycle extensions, defined in `products/crm`. Ghetto Movement is a product for one org.
- **The Relationship OS brand is retired everywhere.** Composable OS is the only brand; products
  are named for what they do.
- **The CRM's core objects are the platform's base primitives.** Person, Organisation, Activity and
  Task stay in core. Every product has people it deals with and a timeline of what happened; a
  ticket buyer or a gym member is a Person.
- **The existing repository is renamed,** to `composable-os`, with package scope
  `@composable-os/*`. The design documents are merged into it. ADR, stage and migration numbers
  carry on: ADRs from 0400, stages from 20.
- **A deployment's Workers and resources are named for its product:** `crm-app`, `ghetto-app`.
  Names come from the product definition and are never written in a package.
- **The extension contract loses the word `crm`:** `codemode:ops`, `ctx.ops`, and `rec_*` views.
- **Code that exists only to upgrade old installs is deleted.**
- **One deployment per org stays** (ADR 0001). No tenant id enters the data model.
- **The licence stays FSL-1.1-ALv2 with the CLA.**

## Why
The hard parts are built and are not CRM-specific: approvals, audit, erase, the extension runtime,
the installer and updater. A second codebase would have to rebuild them.

Every rename is done in one stage because it will never be cheaper. With nothing installed there
is no upgrade path to keep, no alias period for the contract and no second brand to carry. After
the first client has extensions and dashboards of its own, each of these becomes a migration.

Renaming the repository, not starting a new one, keeps history, PRs and CLA signatures, and is how
the last rename was done.

## Consequences
- Stage 20 is a rename across every file and cannot be proven by comparing release bundles. Its
  proof is the test suite, a lint for stray names and a fresh install in a real account.
- Historical ADRs and stage specs (0001 to 0352, stages 00 to 17) keep the old names. They are
  records of what was decided then.
- Core keeps features that only the CRM shows today (duplicates, assignment rules, email sync).
  They stay in core. Switches to hide them per product are added when a second product needs one.
- Supersedes the naming parts of ADR 0190.
- Open: the licence for screens copied into client repos (ADR 0401). Open: where the hosted CRM is
  served from, and the relationshiposcrm.com domain.
