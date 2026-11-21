# ADR 0191: Hosted SaaS and enterprise model

Status: accepted, 2026-11-05 (rename & commercial-model interview).

## Decision
- **SaaS: one isolated deployment per customer**, in our Cloudflare account, using **Workers for Platforms** dispatch namespaces. This keeps ADR 0001's single-org design: there are no tenant ids. Each customer has their own D1, Durable Objects, R2, queues and AI Gateway.
- **The control plane** (`app.relationshiposcrm.com`) handles:
  - self-serve sign-up and trial;
  - **Stripe** billing, with per-seat or per-org plans;
  - **usage-based AI billing**, either passing through each customer's AI Gateway spend or selling bundled credits;
  - an **admin console** for us: customers, plans, health, and support access without impersonation;
  - **staged automatic updates** of every customer instance on release;
  - **data export and account deletion** on cancellation.

  It provisions and updates instances using the existing Stage 8 deploy engine and release bundles.
- **Customer URLs.** Each customer's instance is at `<org>.relationshiposcrm.com`. Enterprise customers can use custom domains through Cloudflare for SaaS custom hostnames.
- **Enterprise.** The customer chooses a **dedicated deployment in our account** (the same as SaaS, plus SSO, a custom domain and SLAs) or a **managed deployment in their own Cloudflare account**, which uses the self-hosted installer and self-updater.
- **Rollout.** We have no Workers for Platforms subscription yet. Everything is built and tested against a fake Workers for Platforms and Stripe, ready to switch on. It goes live when the **first customer signs up**, following a short runbook.
- **Landing page.** `relationshiposcrm.com` is a static marketing site in the monorepo (`apps/marketing`), deployed to Workers using the same design system. The domain is already on our Cloudflare account.

## Amended 2026-11-21: what the landing page offers
The site (`apps/marketing`, now composableos.dev) no longer presents the hosted plans or a
waitlist. It sells a product built for the business by Zero BS AI and maintained on one
subscription ([ADR 0465](0465-the-site-sells-a-built-and-maintained-product.md)). The rest of this
record is left as decided; ADR 0465 does not decide whether the hosted SaaS is still built.
