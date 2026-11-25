# ADR 0008: Deploy-time identity adapters

Status: accepted, 2026-11-04 (stage 0 architecture interview).

## Decision
- `packages/auth` defines `IdentityProvider`: request → `Principal { userId, email, name, roles }`.
- Two built-in adapters, chosen by env var at deploy time:
  - **Better Auth** (default): email plus Google, Microsoft and OIDC/SAML SSO, stored in D1.
  - **Cloudflare Access**: verifies the Access JWT.
- A fork can add its own adapter.
- `/mcp` uses an OAuth 2.1 server (e.g. `workers-oauth-provider`) that delegates login to the active adapter.
- Identity is never runtime-pluggable or AI-configurable. Auth secrets are env-only. In-CRM roles and permissions are core data, editable by admins.

## Amended 2026-11-23: a deployment that serves many clients
[ADR 0611](0611-one-host-a-database-per-client.md) and stage 66's decision 8 (the owner's answer
of 2026-11-23). On a deployment that serves many clients there is no Worker per client to hold a
client's secrets. There, auth secrets are derived per client from one secret in the host's
environment and are stored nowhere; a secret a client gives (payment keys, its own sign-in
provider, its own AI keys) is stored encrypted in the host's registry, under a key only the
host's environment holds, written only by the operator's command and never readable by an
operation, an extension or the assistant. A deployment for one organisation is unchanged.
