---
title: "CRM"
description: "The CRM product: the packs it is made of."
editUrl: false
---

Defined in [products/crm/product.ts](https://github.com/timoconnellaus/composable-os/blob/main/products/crm/product.ts). A deployment of it names its Workers and resources from its names (`crm-app`, `crm-runner`, `crm-gatekeeper-`, `crm`, `crm-`).

## Its packs

| Pack | What it is |
| --- | --- |
| [Deals](/packs/deals/) | Deals moving through pipelines of stages, with stage rules, probabilities, stage history and the people involved. |
| [Leads](/packs/leads/) | Inbound interest linked to a person and an organisation, worked from a leads inbox, qualified or disqualified, and converted into deals. |
| [Lifecycle stage](/packs/lifecycle/) | A lifecycle stage on every person (subscriber, lead, marketing qualified, sales qualified, opportunity, customer, evangelist, other), tracked on the timeline, with a board of people by stage. |
