// The copy and the signed PDF (stage 44 step 4, ADR 0645):
//
//   me.agreements.pdf          a signed-in customer: their own acceptance, or a linked child's
//   agreement.acceptance.pdf   a person on the staff: any one, health answers only with
//                              agreements:health; every download audited (no value in the row)
//   agreement.version.pdf      a person on the staff: a version's blank form, to sign on paper
//   agreement.copy.send        a person on the staff with agreements:paper: email a paper form's
//                              copy to the Person's own address
//
// Each returns what the PDF says (`document`); the host's download route
// (apps/app/src/server/http/agreement-pdf.ts) draws it with the email gatekeeper's PDF writer, so
// a download and the copy's attachment are the same bytes for the same values. No AI actor reads
// one (customers only, or `actors: ["human"]`), and none is in MCP. Who may see a name typed, a
// signature or an answer is step 2's rule (`acceptanceDocument`).
import { z } from "zod";
import {
  acceptanceDocument,
  acceptanceFacts,
  blankDocument,
  paperCopyAddress,
  sendCopiesNow,
} from "../agreements/copy.ts";
import { ForbiddenError, NotFoundError, ValidationError } from "../errors.ts";
import { afterCommit, defineOperation, type HandlerContext } from "../operation.ts";
import { holdsPermission } from "../principals.ts";

const id = (what: string) => z.string().min(1).max(64).describe(what);

/** What the PDF says: drawn by the download route, never stored. */
const documentOut = z.object({
  business: z.string(),
  title: z.string(),
  versionNumber: z.number(),
  versionHash: z.string(),
  body: z.object({ blocks: z.array(z.unknown()) }),
  tickLabel: z.string(),
  questions: z.array(z.object({ key: z.string(), text: z.string() })).optional(),
  answers: z
    .union([
      z.array(z.object({ key: z.string(), yes: z.boolean(), note: z.string().optional() })),
      z.literal("in-app"),
      z.literal("withheld"),
    ])
    .optional(),
  record: z.array(z.object({ label: z.string(), value: z.string() })).optional(),
  signature: z
    .object({
      width: z.number(),
      height: z.number(),
      strokes: z.array(z.array(z.array(z.number()))),
    })
    .optional(),
  acceptanceId: z.string().optional(),
  blank: z.boolean().optional(),
});

const pdfOut = z.object({
  filename: z.string().describe("The file name to save it as"),
  document: documentOut.describe("What the signed PDF says; the download route draws it"),
});

const filename = (title: string, suffix: string) =>
  `${
    title
      .normalize("NFKD")
      .replace(/[^A-Za-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 60)
      .toLowerCase() || "agreement"
  }-${suffix}.pdf`;

export const meAgreementsPdf = defineOperation({
  name: "me.agreements.pdf",
  description:
    "The signed PDF of one of your acceptances, as a signed-in customer, or a linked child's: the " +
    "version as you were shown it and the record of who agreed, how and when, with a health " +
    "form's answers. The name typed and the signature drawn are in it when you are the one who " +
    "agreed. Built when asked, never stored. Read-only.",
  input: z.object({ acceptanceId: id("The acceptance's id (aga_…)") }).strict(),
  output: pdfOut,
  permission: "records:read",
  risk: "read",
  audiences: ["customer"],
  hostInternal: true,
  mcp: { expose: false },
  redactResult: ["document"],
  async handler(input, ctx) {
    if (ctx.principal.kind !== "customer")
      throw new NotFoundError("acceptance", input.acceptanceId);
    const me = ctx.principal.personId;
    // The seam's family: the caller and the children linked to them now.
    const family = await ctx.records.family();
    const people = new Set([me, ...family.dependants.map((d) => d.personId)]);
    const facts = await acceptanceFacts(ctx.db, input.acceptanceId);
    // Someone else's is as if it did not exist.
    if (!facts?.personId || facts.erased || !people.has(facts.personId)) {
      throw new NotFoundError("acceptance", input.acceptanceId);
    }
    const document = await acceptanceDocument(ctx.db, facts.id, {
      kind: "person",
      me,
      answers: "include",
    });
    return { filename: filename(document.title, facts.id), document };
  },
});

/** A Person staff may see, through the seam; an erased or person-less one is the manager's. */
async function requireVisible(ctx: HandlerContext, personId: string | null): Promise<void> {
  if (personId) {
    await ctx.records.get("person", personId);
    return;
  }
  if (!holdsPermission(ctx.user, ctx.permissionGrants, "agreements:manage")) {
    throw new ForbiddenError(
      "An acceptance kept after its Person was erased, or a buyer's not yet settled, is opened by staff with agreements:manage",
      { rule: "agreement_kept" },
    );
  }
}

export const agreementAcceptancePdf = defineOperation({
  name: "agreement.acceptance.pdf",
  description:
    "The signed PDF of one acceptance, for a person on the staff: the version shown and the " +
    "record of who agreed, how and when, the name typed and the signature drawn (paper marked " +
    "as recorded from paper), and a health form's answers only for staff with " +
    "agreements:health. Every download is audited. Never an AI's read. Read-only.",
  input: z.object({ acceptanceId: id("The acceptance's id (aga_…)") }).strict(),
  output: pdfOut,
  permission: "records:read",
  risk: "read",
  actors: ["human"],
  mcp: { expose: false },
  auditReads: true,
  // The audit row says who downloaded whose, and whether answers were in it: nothing of them.
  auditSummary: (output, input) => ({
    acceptanceId: input.acceptanceId,
    answers: Array.isArray(output.document.answers),
  }),
  redactResult: ["document"],
  async handler(input, ctx) {
    if (ctx.actor !== "human") throw new ForbiddenError("Only a person downloads a signed PDF");
    const facts = await acceptanceFacts(ctx.db, input.acceptanceId);
    if (!facts) throw new NotFoundError("acceptance", input.acceptanceId);
    await requireVisible(ctx, facts.erased ? null : facts.personId);
    const document = await acceptanceDocument(ctx.db, facts.id, {
      kind: "staff",
      answers: holdsPermission(ctx.user, ctx.permissionGrants, "agreements:health"),
    });
    return { filename: filename(document.title, facts.id), document };
  },
});

export const agreementVersionPdf = defineOperation({
  name: "agreement.version.pdf",
  description:
    "A version's blank form as a PDF, to print and sign on paper (then agreement.recordPaper): " +
    "its words, the tick label, a health form's questions with boxes, lines for the name, " +
    "signature and date, and the version's number and hash at the foot of every page. A person " +
    "on the staff. Read-only.",
  input: z.object({ versionId: id("The version's id (agv_…)") }).strict(),
  output: pdfOut,
  permission: "records:read",
  risk: "read",
  actors: ["human"],
  mcp: { expose: false },
  async handler(input, ctx) {
    if (ctx.actor !== "human") throw new ForbiddenError("Only a person prints a paper form");
    const document = await blankDocument(ctx.db, input.versionId);
    return { filename: filename(document.title, `version-${document.versionNumber}`), document };
  },
});

export const agreementCopySend = defineOperation({
  name: "agreement.copy.send",
  description:
    "Email a paper form's copy (Email a copy): the signed PDF goes, as the host's own mail, to " +
    "the address the host holds for the Person it is for (their sign-in address, or their " +
    "primary email). Once only: asking again answers how the first one went. Refused when the " +
    "Person has no address. A person on the staff with agreements:paper only.",
  input: z.object({ acceptanceId: id("The paper acceptance's id (aga_…)") }).strict(),
  output: z.object({
    acceptanceId: z.string(),
    state: z.enum(["queued", "sending", "sent", "waiting", "failed", "cancelled"]),
  }),
  permission: "agreements:paper",
  risk: "write",
  actors: ["human"],
  mcp: { expose: false },
  async handler(input, ctx) {
    if (ctx.actor !== "human") throw new ForbiddenError("Only a person emails a paper form's copy");
    const facts = await acceptanceFacts(ctx.db, input.acceptanceId);
    if (!facts || facts.erased || !facts.personId) {
      throw new NotFoundError("acceptance", input.acceptanceId);
    }
    await requireVisible(ctx, facts.personId);
    if (facts.by !== "paper") {
      throw new ValidationError(
        "A copy of this acceptance went to whoever agreed when it was made; only a paper form's is emailed on request.",
        { rule: "agreement_copy_not_paper" },
      );
    }
    const existing = await ctx.db
      .selectFrom("core_agreement_copy")
      .select("state")
      .where("acceptance_id", "=", facts.id)
      .executeTakeFirst();
    if (existing) return { acceptanceId: facts.id, state: existing.state };
    // The address is the host's record of the Person's, never an input.
    const to = await paperCopyAddress(ctx.db, facts.personId);
    if (!to) {
      throw new ValidationError("This Person has no email address to send the copy to.", {
        rule: "agreement_copy_no_address",
      });
    }
    ctx.write(
      ctx.db.insertInto("core_agreement_copy").values({
        acceptance_id: facts.id,
        to_address: to,
        state: "queued",
        send_key: `agreement-copy:${facts.id}`,
        attempts: 0,
        queued_at: ctx.now,
        requested_by: ctx.user.id,
      }),
    );
    const integrations = ctx.integrations;
    return afterCommit(async () => {
      await sendCopiesNow({ db: ctx.db, integrations }, [facts.id]);
      const row = await ctx.db
        .selectFrom("core_agreement_copy")
        .select("state")
        .where("acceptance_id", "=", facts.id)
        .executeTakeFirst();
      return { acceptanceId: facts.id, state: row?.state ?? "queued" };
    });
  },
});

export const agreementCopyOperations = [
  meAgreementsPdf,
  agreementAcceptancePdf,
  agreementVersionPdf,
  agreementCopySend,
] as const;
