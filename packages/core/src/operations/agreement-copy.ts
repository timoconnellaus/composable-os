// The copy and the signed PDF (stage 44 step 4, ADR 0645):
//
//   me.agreements.pdf          a signed-in customer: their own acceptance, or a linked child's
//   agreement.acceptance.pdf   a person on the staff: any one, health answers only with
//                              agreements:health; every download audited (no value in the row)
//   agreement.version.pdf      a person on the staff: a version's blank form, to sign on paper
//   agreement.copy.preview     a person on the staff with agreements:paper: where it would go
//   agreement.copy.send       a person on the staff with agreements:paper: email a paper form's
//                              copy to the Person's own address, or for a child's to the parent
//                              or guardian staff pick (ADR 0648)
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
  type PaperCopyGuardian,
  paperCopyRecipient,
  sendCopiesNow,
} from "../agreements/copy.ts";
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from "../errors.ts";
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
export async function requireVisible(ctx: HandlerContext, personId: string | null): Promise<void> {
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
      // Who signed a paper form and staff's note are free text that may name someone (the review
      // of PR #288): shown to staff with agreements:manage only.
      freeText: holdsPermission(ctx.user, ctx.permissionGrants, "agreements:manage"),
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

/** A paper acceptance staff may email a copy of, and where it would go, or why it would not. */
async function paperCopyTarget(ctx: HandlerContext, acceptanceId: string) {
  const facts = await acceptanceFacts(ctx.db, acceptanceId);
  if (!facts || facts.erased || !facts.personId) {
    throw new NotFoundError("acceptance", acceptanceId);
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
  return {
    facts: { ...facts, personId: facts.personId },
    existing,
    recipient: await paperCopyRecipient(ctx.db, facts.personId),
  };
}

/** Whether this member of staff may see a Person, through the seam (never an error). */
async function visible(ctx: HandlerContext, personId: string): Promise<boolean> {
  try {
    await ctx.records.get("person", personId);
    return true;
  } catch (error) {
    if (error instanceof NotFoundError || error instanceof ForbiddenError) return false;
    throw error;
  }
}

/**
 * A child's live guardians this member of staff may see, each with the address the host holds
 * for them; none with an address are left out. Never another guardian's name or address than
 * the seam shows them.
 */
async function guardianChoices(
  ctx: HandlerContext,
  guardians: readonly PaperCopyGuardian[],
): Promise<{ personId: string; name: string; to: string }[]> {
  const out: { personId: string; name: string; to: string }[] = [];
  for (const g of guardians) {
    if (g.to && (await visible(ctx, g.personId))) {
      out.push({ personId: g.personId, name: g.name, to: g.to });
    }
  }
  return out;
}

const REFUSED = {
  minor:
    "This form is for a child, and no parent or guardian linked to them has an email address to send the copy to. Download the PDF and give it to their parent or guardian.",
  no_address: "This Person has no email address to send the copy to.",
  guardian_no_address:
    "This parent or guardian has no email address to send the copy to: choose another, or download the PDF and give it to them.",
  not_guardian:
    "That Person is not a parent or guardian linked to this child now: look at who to send it to again.",
  choose_guardian:
    "This form is for a child: its copy goes to a parent or guardian linked to them. Choose which one.",
  adult: "This form is for an adult: its copy goes to them, not to anyone else.",
} as const;

const copyState = z.enum(["queued", "sending", "sent", "waiting", "failed", "cancelled"]);

export const agreementCopyPreview = defineOperation({
  name: "agreement.copy.preview",
  description:
    "Before Email a copy of a paper form: the address the host would send it to (the Person's " +
    "sign-in address, or their primary email), or, for a child's form, the parents and guardians " +
    "linked to the child now that you may see and that have an address, each with the address it " +
    "would go to, to choose one; or why it would not be sent (a child with no such guardian, or " +
    "no address), and whether a copy was already asked for. Show the address to the person, who " +
    "confirms it with agreement.copy.send. A person on the staff with agreements:paper. Read-only.",
  input: z.object({ acceptanceId: id("The paper acceptance's id (aga_…)") }).strict(),
  output: z.object({
    acceptanceId: z.string(),
    to: z.string().nullable().describe("An adult's form: the address it would go to"),
    guardians: z
      .array(
        z.object({
          personId: z.string(),
          name: z.string(),
          to: z.string().describe("The address the host holds for them, where it would go"),
        }),
      )
      .describe("A child's form: the linked parents and guardians to choose from"),
    refused: z.enum(["minor", "no_address"]).nullable(),
    state: copyState.nullable().describe("A copy already asked for: how it went"),
  }),
  permission: "agreements:paper",
  risk: "read",
  actors: ["human"],
  mcp: { expose: false },
  async handler(input, ctx) {
    if (ctx.actor !== "human") throw new ForbiddenError("Only a person emails a paper form's copy");
    const { facts, existing, recipient } = await paperCopyTarget(ctx, input.acceptanceId);
    const guardians =
      "guardians" in recipient ? await guardianChoices(ctx, recipient.guardians) : [];
    return {
      acceptanceId: facts.id,
      to: "to" in recipient ? recipient.to : null,
      guardians,
      // A child's form with no guardian this person may send it to is refused as a child's.
      refused:
        "refused" in recipient
          ? recipient.refused
          : "guardians" in recipient && !guardians.length
            ? "minor"
            : null,
      state: existing?.state ?? null,
    };
  },
});

export const agreementCopySend = defineOperation({
  name: "agreement.copy.send",
  description:
    "Email a paper form's copy (Email a copy): the signed PDF goes, as the host's own mail, to " +
    "the address the host holds for the Person it is for, which agreement.copy.preview showed; " +
    "for a child's form, to the linked parent or guardian chosen (`guardianId`, one the preview " +
    "listed), at the address the host holds for them. `confirmTo` is that address as the person " +
    "saw it: if the host's address changed since (an edit, by anyone), it is refused and shown " +
    "again. Once only: asking again answers how the first one went. Refused for a child's form " +
    "with no linked guardian who has an address, for anyone who is not a live guardian of the " +
    "child, and for a Person with no address. A person on the staff with agreements:paper only.",
  input: z
    .object({
      acceptanceId: id("The paper acceptance's id (aga_…)"),
      guardianId: id(
        "A child's form: the linked parent or guardian to send it to (per_…), as the preview listed",
      ).optional(),
      confirmTo: z
        .string()
        .min(3)
        .max(320)
        .describe("The address agreement.copy.preview showed, as the person confirmed it"),
    })
    .strict(),
  output: z.object({ acceptanceId: z.string(), state: copyState }),
  permission: "agreements:paper",
  risk: "write",
  actors: ["human"],
  mcp: { expose: false },
  async handler(input, ctx) {
    if (ctx.actor !== "human") throw new ForbiddenError("Only a person emails a paper form's copy");
    const { facts, existing, recipient } = await paperCopyTarget(ctx, input.acceptanceId);
    if (existing) return { acceptanceId: facts.id, state: existing.state };
    // The address is the host's record, never an input: the confirmation only proves the person
    // saw the one the host holds now. For a child's form, the guardian chosen must be a live
    // guardian of the child this person may see, with an address; migration 0857 checks the
    // link and the address again in the batch.
    let to: string;
    let guardianId: string | null = null;
    if ("to" in recipient) {
      if (input.guardianId) {
        throw new ValidationError(REFUSED.adult, { rule: "agreement_copy_not_guardian" });
      }
      to = recipient.to;
    } else if ("guardians" in recipient) {
      const guardians = recipient.guardians;
      if (!input.guardianId) {
        if (!(await guardianChoices(ctx, guardians)).length) {
          throw new ValidationError(REFUSED.minor, { rule: "agreement_copy_minor" });
        }
        throw new ValidationError(REFUSED.choose_guardian, {
          rule: "agreement_copy_guardian_required",
        });
      }
      const chosen = guardians.find((g) => g.personId === input.guardianId);
      // Not a live guardian of the child, or one this person may not see: the same answer, so
      // the refusal says nothing of who is linked.
      if (!chosen || !(await visible(ctx, chosen.personId))) {
        throw new ValidationError(REFUSED.not_guardian, { rule: "agreement_copy_not_guardian" });
      }
      if (!chosen.to) {
        throw new ValidationError(REFUSED.guardian_no_address, {
          rule: "agreement_copy_no_address",
        });
      }
      to = chosen.to;
      guardianId = chosen.personId;
    } else {
      throw new ValidationError(REFUSED.no_address, { rule: "agreement_copy_no_address" });
    }
    if (to.toLowerCase() !== input.confirmTo.trim().toLowerCase()) {
      throw new ConflictError(
        guardianId
          ? "This parent or guardian's address changed since it was shown: look at it again before sending."
          : "This Person's address changed since it was shown: look at it again before sending.",
        { rule: "agreement_copy_address_changed" },
      );
    }
    ctx.write(
      ctx.db.insertInto("core_agreement_copy").values({
        acceptance_id: facts.id,
        to_address: to,
        state: "queued",
        send_key: `agreement-copy:${facts.id}`,
        attempts: 0,
        queued_at: ctx.now,
        next_at: ctx.now,
        requested_by: ctx.user.id,
        guardian_id: guardianId,
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
  agreementCopyPreview,
  agreementCopySend,
] as const;
