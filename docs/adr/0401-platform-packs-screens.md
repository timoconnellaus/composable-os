# ADR 0401: Platform, packs and screens, and where each lives

Status: accepted, 2026-11-20 (design conversation and stage 24 interview).

## Context
A product for a company could be built by forking the whole platform, or by depending on it. A fork
puts platform code in every client's repo: a fix to billing or the approval pipeline becomes one
merge per client, into codebases that have each drifted, and an agent working in a client repo can
edit the trust floor by accident. But customer-facing screens must differ per client, and a shared
component library makes every product feel the same.

## Decision
Code is split by who needs to own change.

| Kind | What | How it ships | Owned by |
| --- | --- | --- | --- |
| **Platform** | Operations pipeline, identity, audit, behaviours, gatekeepers, the typed client | Versioned packages and verified release bundles | The platform |
| **Pack** | A shipped extension (objects, behaviours, automations, tools) plus its headless client hooks | Versioned packages, chosen per product | The platform |
| **Block** | A screen or part of one for a pack, in a web skin and a native skin | Copied into the client repo from a registry | The client, once copied |

- **Each client has their own repository, never a fork of the platform.** A new one starts from a
  template; an existing one is adopted in place, with nothing moved.
- **A client repo gets the platform's packages from npm,** as public packages. The host itself is
  still deployed only from the verified release bundle.
- **Blocks ship inside the release and are MIT.** A block matches the platform version it was
  copied from, and the company owns its copy outright. Nothing updates a copied block
  automatically.
- **Customers sign in on the company's own domain; staff use the admin on the host's address.**
  The two kinds of cookie are never on one hostname.
- **A company's own extensions are installed by deploy,** after the checker, with no approval
  inside the deployment.
- **A gap found in a client repo is reported, not worked around.** The client's agent stops that
  part, says what the platform needs, and builds the rest.
- **One command line, `cos`.**
- **A client repo holds** the web
  app (TanStack Start), the mobile app (Expo) where there is one, the org's own extensions and a
  product definition naming the packs and platform version.
- **The host runs as its own Workers, deployed from a release.** The client's web app is a separate
  Worker that reaches the host over a service binding. Client code never opens the database, the
  same rule extensions follow.
- **Web and native share the contract and the logic, never the screens.** A block has a headless
  part (operation calls and state, in the pack), a web skin (Radix or Base UI under shadcn-style
  components) and a native skin (React Native).
- **Pages are code.** There is no page builder. An agent writes each client's pages; content they
  show comes from records.

## Why
Rules need fixes delivered by updating. Screens need to diverge. Putting each where its owner can
change it freely gives both. The host as separate Workers means it updates without a client code
change, and the staff admin and the MCP surface come with it, so only customer-facing screens are
written per client.

## Consequences
- The platform must publish a stable client contract and keep the current and previous versions
  working, as it does for extensions (ADR 0023).
- A copied block does not receive fixes. Blocks stay thin: anything that must be right (prices,
  capacity, what a customer may see) is enforced in the host, never in a block.
- The platform now publishes to npm on every release, which is a commitment to semver for the
  packages a client repo depends on.
- Which primitive library sits under the web blocks (Radix or Base UI) is chosen when stage 24 is
  built.
- Left for later: preview deployments per branch, a TV app in the template, any way to change
  screens without code.

## As built (stage 24, steps 1 and 2 and the sign-in part of step 5, 2026-11-21)
- Packs live in `packs/<id>/` (the extension, `client/`, `blocks/`) as `@composable-os/pack-<id>`;
  a product lists its packs, and only those are in its release:
  [ADR 0420](0420-packs-as-packages-as-built.md).
- The web app's service binding is to cos-app's `ClientApp` entrypoint, which serves customer
  sign-in and the HTTP surface for customers and the public only, reads only the customer's
  verified session cookie, and never a staff session or a token. Customers sign in on the web
  app's hostname; the host's cookie is passed through, host-only, and `CUSTOMER_AUTH_URL` names the
  web app: [ADR 0421](0421-the-client-app-binding-and-customer-sign-in.md).
