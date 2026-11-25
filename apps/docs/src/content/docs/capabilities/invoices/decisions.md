---
title: "Invoices: decisions"
sidebar:
  label: "Decisions"
  order: 90
editUrl: false
---

The decisions this capability rests on, as recorded in the repository's ADRs.

| ADR | Decision |
| --- | --- |
| [ADR 0730](https://github.com/timoconnellaus/composable-os/blob/main/docs/adr/0730-quotes-invoices-and-credit-notes-as-core-records.md) | Quotes, invoices and credit notes as core records: numbering, immutability, retention, the document event log |
| [ADR 0731](https://github.com/timoconnellaus/composable-os/blob/main/docs/adr/0731-an-invoice-is-an-order.md) | An invoice is an order: due, not expiring; its own adjustments; moved only through the invoice |
| [ADR 0732](https://github.com/timoconnellaus/composable-os/blob/main/docs/adr/0732-tax-worked-out-by-the-host-on-documents.md) | Tax worked out by the host on documents, from the business's rates |
| [ADR 0733](https://github.com/timoconnellaus/composable-os/blob/main/docs/adr/0733-recording-a-payment-on-an-invoice.md) | Recording a payment on an invoice: `invoices:payments`, restricted, human only, on the shared step |
| [ADR 0735](https://github.com/timoconnellaus/composable-os/blob/main/docs/adr/0735-credit-notes-and-void.md) | Credit notes and void: what is owed reduced, refunds by method, never more than was paid |
| [ADR 0737](https://github.com/timoconnellaus/composable-os/blob/main/docs/adr/0737-the-shared-pdf-writer-the-invoice-attachment-and-host-mail-purpose-invoices.md) | The shared PDF writer, the `invoice` attachment, host mail purpose `invoices` |

The specification is stage 35's, [35-invoices-quotes.md](https://github.com/timoconnellaus/composable-os/blob/main/docs/stages/35-invoices-quotes.md).
