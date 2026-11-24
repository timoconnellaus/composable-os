---
title: "interface"
description: "The Cloudflare OS gatekeeper RPC interface (vendored from workshop-shared/src/gatekeeper.ts)."
editUrl: false
---

The Cloudflare OS gatekeeper RPC interface (vendored from workshop-shared/src/gatekeeper.ts).

|  |  |
| --- | --- |
| Package | `@composable-os/gatekeeper-interface` |
| Host module | none: a library or contract other gatekeepers use |
| Deployed as a Worker | no |
| Source | [packages/gatekeeper-interface](https://github.com/timoconnellaus/composable-os/tree/main/packages/gatekeeper-interface) |

## Source

This file defines the API that the AI Gadgets Workshop uses to talk to Adapters. Each Adapter provides connectivity to some external service which AI Gadgets can then manipulate. Each installation of the Gadgets Workshop may have access to different adapters, typically based on the set of internal services used at the particular company. For instance, there might be adapters for Google Workspace, GitHub, Jira, etc. Adapters provide access to resources. For instance, a Google Workspace adapter might provide access to Google Docs, Spreadsheets, Gmail mailboxes, etc. Each Google Doc, for example, is a separate "resource". Adapters are designed to provide object-oriented, capability-based access to such resources, enabling the Gadget Workshop to grant a particular Gadget fine-grained access to just the things the user wants that Gadget to access. Each adapter is deployed as a completely independent Workers application from the Gadgets Workshop itself, and is provided to the Workshop as a service binding. The Workshop communicates with the adapter over JavaScript RPC. The types in this file define that RPC interface. The `Adapter` type is the root interface implemented by the service binding.

See [packages/gatekeeper-interface/src/gatekeeper.ts](https://github.com/timoconnellaus/composable-os/blob/main/packages/gatekeeper-interface/src/gatekeeper.ts).
