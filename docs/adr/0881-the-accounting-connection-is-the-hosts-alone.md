# ADR 0881: The accounting connection is the host's alone

Status: accepted, 2026-11-24 (stage 61 build, step 3). Builds on ADRs
[0050](0050-integration-host-and-connections.md), [0111](0111-outbound-actions-in-the-approval-queue.md),
[0429](0429-payments-gatekeeper-verified-events-and-refunds.md) (`callAsHost`, the host's own
message), [0774](0774-card-on-a-reader.md) (kinds always reviewed, approved by a human admin) and
[0880](0880-the-accounting-contract.md) (the accounting contract). Spec:
[stage 61](../stages/61-accounting-sync.md).

## Context

An accounting gatekeeper holds a grant that can write the business's books. Every entry the sync
sends is composed by host code from host records, under rules the host keeps (what is sent, once,
to which account, after which approval). Any other way into the connection would let a person, an
AI, an MCP client or an extension write to the books around those rules. And the sync sends dozens
of entries a day: if each were an outbound action waiting in the Approvals inbox, the approval
would be a chore nobody does properly; the spec puts it in the outbox instead, one per day.

## Decision

**A purpose `accounting` for `callAsHost`.** The integration host opens the session as the system
user (`SYSTEM_USER`), as for an agreement's copy. The queue marks what it submits as the host's
own message (`hostMessage`), so a contact or an entry (`accounting.contact`, `accounting.post`)
applies at once unless the deploy-time floor denies it; the approving is the outbox's (step 4).
Its writes are audited under origin `system.accounting` (surface `system`): no AI wrote them, so
the outbound check never reads them. Any session method may be called on this purpose (reads and
writes alike); the contract (ADR 0880) has no delete and no edit.

**`accounting.void` is always reviewed.** It joins `ALWAYS_REVIEWED_KINDS` as
`ACCOUNTING_VOID_KINDS`, so whatever the policy, an admin's auto-approve or the host's own call
say, a void waits in the Approvals inbox. Only a person approves one, never an AI actor, and only
an admin (`integrations:manage`, which no grant gives), as for a card reader. The spec gives
`accounting:manage` the request (`accounting.void.request`), not the approval; that permission is
step 2's and was not on `main` when this step was built. Widening the approver to a holder of
`accounting:manage` is a later, reviewed change if a bookkeeper needs it.

**The host-only rule.** The integration host refuses to open a session on a connection whose
gatekeeper `implements: "accounting"` (`keepsBooks`, from the catalogue) for anything but that
purpose, and that purpose opens nothing but such a connection. The check is in the integration
host, where every session starts (`call`, `callAsHost`, `openSession`), so it holds for every
caller: `integration.call` (MCP, the assistant, a person), Code Mode and an extension's
`codemode:<gatekeeper>` (both through the host's `call`), and a code session. `integration.call`
also refuses before dispatch, as `forbidden` with `details.rule` `accounting_host_only`; the host's
refusal carries `accounting_host_only` at the start of its message (RPC keeps a message, not a
class). No `codemode:` module is an accounting gatekeeper, and a test keeps it so.
`integration.types` still answers: it reads the contract's declarations and reaches nothing.

## Consequences

- Only the accounting operations and the runner (step 4) can read or write the books. Connecting,
  binding the books and disconnecting stay the integration operations a human admin uses.
- A floor that denies `accounting.post` stops the sync's sends: the host's call reports them in
  `denied`, and the outbox holds them.
- The gatekeeper itself does not yet check that its queue is the host's accounting queue
  (`hostPurpose()`); the rule is the integration host's, which is where every session starts.
  Adding the gatekeeper's own check is defence in depth for a later step.
