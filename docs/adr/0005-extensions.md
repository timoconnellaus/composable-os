# ADR 0005: Customisation is code: extensions

Status: accepted, 2026-11-04 (stage 0 architecture interview).

## Context
Configuration through code and libraries is more flexible than JSON metadata, and models write code well.

## Decision
- A customisation is an **extension**: TypeScript against the contract in `packages/sdk` (`defineObject`, `defineDashboard` / `defineView`, `defineAutomation`, `defineTool`).
- There are two sources, with one contract:
  - **Shipped extensions** live in `extensions/`, are versioned with releases, and are enabled per deployment.
  - **Runtime extensions** are written by Claude in-app or via MCP, approved, stored and versioned in the extension workspace (ADR 0006).
- **Minimal core**: People, Organisations, Activities and Tasks are core app code. Everything else, starting with Deals/Pipelines (stage 4), is an extension, to prove the contract.
- The host keeps the dangerous parts: it turns declarations into DDL, renders all UI from specs, and grants only host modules.
- The word is **extension**, not "package", to avoid clashing with pnpm workspace packages.

## Consequences
- Customisations never touch the fork, so upgrades stay clean.
- The SDK contract is versioned. The host supports the current and previous contract version.

## Amendment, 2026-11-24 (stage 47, ADR 0660)
"The host renders all UI from specs" holds for runtime extensions, which still never ship UI: a
runtime extension declaring `screens` fails `cos ext check` and install. A **shipped pack** may
declare staff screens: its own web blocks, code in this repository, built into the admin at build
time and loaded lazily, shown to whoever the host lets open them (`screens.mine`). Nothing is
loaded at run time from an extension's files. See [ADR 0660](0660-pack-screens-in-the-admin.md).
