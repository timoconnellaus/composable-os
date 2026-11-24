// The session's rules without a Worker around them: every input checked, every write applied
// through `applyWrite`, a void waiting until `approve`. For running the conformance suite against
// a system object directly (the fake in memory, or a real system from a person's test script);
// the gatekeeper's own session (session.ts) is what the host reaches.

import { type AccountingWrite, applyWrite } from "./apply.js";
import type { AccountingSystem } from "./system.js";
import type { AccountingReceipt, AccountingSession } from "./types.js";
import {
  MAX_CONTACT_CANDIDATES,
  parseContactInput,
  parseContactQuery,
  parseDocumentInput,
  parseMoneyInput,
  parseReference,
  parseStatusRefs,
  parseSummaryInput,
  parseTransferInput,
  parseVoidInput,
} from "./validate.js";

export function directSession(system: AccountingSystem): {
  session: AccountingSession;
  approve(id: number): Promise<void>;
} {
  let nextId = 0;
  const pending = new Map<number, AccountingWrite>();
  async function write(input: AccountingWrite): Promise<AccountingReceipt> {
    nextId += 1;
    if (input.kind === "void") {
      pending.set(nextId, input);
      return { status: "pending", id: nextId, ref: null };
    }
    return { status: "sent", id: nextId, ref: await applyWrite(system, input) };
  }
  const session: AccountingSession = {
    describeBooks: () => system.describeBooks(),
    listAccounts: () => system.listAccounts(),
    listTaxRates: () => system.listTaxRates(),
    findContacts: async (query) =>
      (await system.findContacts(parseContactQuery(query))).slice(0, MAX_CONTACT_CANDIDATES),
    documentStatus: async (refs) => system.documentStatus(parseStatusRefs(refs)),
    findByReference: async (reference) => system.findByReference(parseReference(reference)),
    upsertContact: async (input) => write({ kind: "contact", input: parseContactInput(input) }),
    postSummary: async (input) => write({ kind: "summary", input: parseSummaryInput(input) }),
    postTransfer: async (input) => write({ kind: "transfer", input: parseTransferInput(input) }),
    postInvoice: async (input) => write({ kind: "invoice", input: parseDocumentInput(input) }),
    postCreditNote: async (input) =>
      write({ kind: "credit_note", input: parseDocumentInput(input) }),
    postPayment: async (input) => write({ kind: "payment", input: parseMoneyInput(input) }),
    postRefund: async (input) => write({ kind: "refund", input: parseMoneyInput(input) }),
    voidDocument: async (input) => write({ kind: "void", input: parseVoidInput(input) }),
  };
  return {
    session,
    async approve(id) {
      const waiting = pending.get(id);
      if (!waiting) throw new Error(`No write ${id} waits for approval.`);
      pending.delete(id);
      await applyWrite(system, waiting);
    },
  };
}
