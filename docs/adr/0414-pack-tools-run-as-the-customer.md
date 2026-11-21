# ADR 0414: A pack's tool called by a customer runs as that customer

Status: accepted, 2026-11-20 (stage 22 review, built in step 6). Builds part of
[ADR 0402](0402-staff-and-customers.md) on [ADR 0413](0413-outside-handlers-have-no-raw-database.md).

## Context
ADR 0402 decided that a customer changes records only through a tool a pack opens to them. A
tool is extension code. Until now extension code called operations as the extension, with the
permissions in its manifest and the whole org's records in reach. Run that way for a customer, a
bug in a tool could change another customer's record, and the tool would be filtering by customer
itself, which the seam exists to prevent. Tools also need to set fields a customer may not set
directly: a cancel sets `status`.

## Decision
- **`defineTool` gains `audiences`,** as operations have. Left out, staff only. A tool open to
  `customer` or `public` has risk `read` or `write`; another fails the contract check and does
  not load.
- **An object gains `customer: { field, read, write }`** in the contract, checked by the SDK and
  carried by the reconciler into the field registry, where the seam reads it.
- **A runtime extension can declare neither.** `extension.check` and install refuse a runtime
  extension that opens a tool or declares an object's customer, with a message. A runtime
  extension's tool also loads as staff only whatever its stored manifest says. Only a shipped
  extension (which includes an org's own, shipped from its repository) can open anything.
- **Called by a customer, a tool runs as that customer.** The runner makes the tool's operation
  calls through the pipeline's outside path with the caller's own principal, never as the
  extension. So the tool reaches exactly the operations open to customers, the seam gives it
  only the caller's rows and listed fields, and a tool bug cannot touch another customer's
  record. The extension's declared permissions still apply on top.
- **The tool writes with `my.create` and `my.update`,** core operations open to customers and
  marked `toolOnly`: a customer calling one directly gets the unknown-operation answer. They are
  thin wrappers over `ctx.records`.
- **Fields are widened per tool, in the manifest.** A tool lists, per object of its own
  extension, the fields it may set beyond `customer.write` (`customerFields`). The host allows
  exactly those for calls made by that tool, read from the installed manifest and not from the
  run. Never the customer field and never `id`.
- **A tool running for a customer has `ops`, `storage` and `log` only.** No gatekeeper module
  and no model call.
- **The generated list covers shipped tools.** The open-operations test builds the tools of the
  shipped extensions as operations and lists any that are open, and shows `toolOnly`.

## Why
- Rows stay the host's decision on every path. A tool author declares what the tool may set, and
  that declaration is in the manifest, in `check` output and in review.
- `toolOnly` keeps the stage's rule (no generic customer write) while giving tools one checked
  way to write, not SQL of their own.

## Consequences
- A tool for customers is written against `my.*`, not `record.*`: `record.get` does not exist
  for its caller.
- A tool open to customers alone does not exist for staff. One for both lists both, and then
  sees whichever caller it has.
- A tool cannot start another tool for a customer.
- `customerFields` names objects of the tool's own extension only.
- The check that an extension is "the org's own, reviewed" is its source being `shipped`. Stage
  24 (client repos) must keep that true.
