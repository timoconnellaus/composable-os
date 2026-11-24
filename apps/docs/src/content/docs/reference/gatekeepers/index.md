---
title: "Gatekeepers"
sidebar:
  label: "All gatekeepers"
  order: 0
editUrl: false
---

Extension code runs with no network of its own. External access goes only through gatekeepers: Workers that hold the credentials, check every call against a typed contract and put each outbound change through the approval queue where it needs one. An extension asks for a gatekeeper as a host module by name.

| Gatekeeper | Host module | Worker | What it is |
| --- | --- | --- | --- |
| [accounting](/reference/gatekeepers/accounting/) |   |   | The accounting contract every accounting gatekeeper implements: its types, input checks, action descriptions, the shared session, a fake accounting system and the conformance suite. |
| [booking-system](/reference/gatekeepers/booking-system/) |   |   | The read-only booking-system contract every booking-system gatekeeper implements: its types, input checks, the shared session, a fake booking system and the conformance suite. |
| [configurator-ui](/reference/gatekeepers/configurator-ui/) |   |   | The authoring API gatekeeper resource-configurator modules import (type-only stubs from cloudflare-os packages/configurator-ui). The upstream sandbox runtime and frame build are not vendored. |
| [email](/reference/gatekeepers/email/) | `email` | yes | Gatekeeper Worker that receives inbound email (Cloudflare Email Routing) and delivers it to hooks. Vendored from cloudflare-os. |
| [email-send](/reference/gatekeepers/email-send/) | `email-send` | yes | Gatekeeper Worker that sends email through Cloudflare Email Service, each send an approval-queue action. |
| [google](/reference/gatekeepers/google/) | `google` | yes | Gatekeeper Worker for Google Workspace (Gmail, Calendar, Drive, Docs, Sheets, Slides, Chat, BigQuery). Vendored from cloudflare-os. |
| [interface](/reference/gatekeepers/interface/) |   |   | The Cloudflare OS gatekeeper RPC interface (vendored from workshop-shared/src/gatekeeper.ts). |
| [kit](/reference/gatekeepers/kit/) |   |   | Building blocks for gatekeepers: connect-flow, credential, action, observation, and simulation primitives. Vendored from cloudflare-os. Not a deployable Worker. |
| [mcp](/reference/gatekeepers/mcp/) | `mcp` | yes | Gatekeeper Worker that connects any MCP server an admin supplies. Vendored from cloudflare-os. |
| [microsoft](/reference/gatekeepers/microsoft/) | `microsoft` | yes | Gatekeeper Worker for Microsoft 365 (SharePoint and OneDrive, Outlook mail, Outlook Calendar). Vendored from cloudflare-os. |
| [observability](/reference/gatekeepers/observability/) |   |   | The structured Worker logger the vendored gatekeepers log through (a subset of cloudflare-os packages/observability). |
| [payments](/reference/gatekeepers/payments/) |   | yes | Gatekeeper Worker for payments: opens the provider's hosted checkout, submits refunds as approval-queue actions and delivers verified payment events to a bound hook. |
| [slack](/reference/gatekeepers/slack/) | `slack` | yes | Gatekeeper Worker for Slack (workspaces, conversations and threads). Vendored from cloudflare-os. |
| [slack-post](/reference/gatekeepers/slack-post/) | `slack-post` | yes | Gatekeeper Worker that posts Slack messages and DMs with a bot token, each post an approval-queue action. Shares the Slack app with the vendored read-only Slack gatekeeper. |
| [text](/reference/gatekeepers/text/) |   | yes | Gatekeeper Worker for text messages: sends the host's routine texts and checking codes through the business's own text provider account, and delivers verified receipts and STOP, START and HELP replies to the host. |
| [webhook](/reference/gatekeepers/webhook/) | `webhook` | yes | Gatekeeper Worker for inbound webhooks: verifies provider signatures and delivers typed events to a bound hook. |
| [websearch](/reference/gatekeepers/websearch/) | `websearch` | yes | Gatekeeper Worker for web search through Workers AI's websearch() and AI Gateway. Vendored from cloudflare-os. |
| [zoominfo](/reference/gatekeepers/zoominfo/) | `zoominfo` | yes | Gatekeeper Worker for ZoomInfo (GTM API: lookup, search, enrich, Copilot, usage). Vendored from cloudflare-os. |
