// Erasure housekeeping (ADR 0320), human admins only:
// - erasure.addressStatus / erasure.allowAddress: the erased-address list, which keeps mail and
//   calendar sync from collecting an erased person again. Allowing an address is for a person who
//   comes back by consent.
// - erasure.reapply: after a database restore (D1 Time Travel), erase again everything the erase
//   log (R2, outside the restorable database) says was erased.
import { z } from "zod";
import { ConfigError } from "../errors.ts";
import { defineOperation } from "../operation.ts";
import { liftForAddress, suppressStatements } from "../outside/erase.ts";
import { saltFingerprint } from "../outside/match.ts";
import { chunk } from "../records/common.ts";
import { planReapply, putEraseLog, readEraseLog } from "../records/erase-log.ts";
import { erasedAddressHash } from "../records/erase-subject.ts";

const address = z.string().trim().toLowerCase().pipe(z.email().max(320));

export const erasureAddressStatus = defineOperation({
  name: "erasure.addressStatus",
  description:
    "Whether an email address is on the erased-address list: the addresses of erased people, " +
    "which mail and calendar sync drops (the list holds only a hash of each address). Admins only.",
  input: z.object({ email: address }),
  output: z.object({ erased: z.boolean(), erasedAt: z.string().nullable() }),
  // The admin Audit page's permission: admins only, and a read.
  permission: "audit:read",
  risk: "read",
  actors: ["human"],
  mcp: { expose: false },
  async handler(input, ctx) {
    const row = await ctx.db
      .selectFrom("core_erased_address")
      .select("erased_at")
      .where("hash", "=", await erasedAddressHash(input.email))
      .executeTakeFirst();
    return { erased: Boolean(row), erasedAt: row?.erased_at ?? null };
  },
});

export const erasureAllowAddress = defineOperation({
  name: "erasure.allowAddress",
  description:
    "Take an email address off the erased-address list, so mail and calendar sync can match and " +
    "suggest it again: for a person who was erased and has come back by consent. The booking " +
    "system's copy matches them again too: the address's suppression goes, with the outside refs " +
    "the same erase suppressed (theirs). Admins only, " +
    "and only a person in the app. Records the decision in the erase log, so a re-apply after a " +
    "restore keeps it.",
  input: z.object({ email: address }),
  output: z.object({
    removed: z.boolean(),
    bookingSystem: z
      .object({
        addresses: z
          .number()
          .describe("The address's suppression in the booking system's copy, lifted"),
        refs: z
          .number()
          .describe("Outside refs the same erase suppressed (the Person's own), lifted with it"),
        refsLeft: z
          .number()
          .describe(
            "Refs left suppressed because several erases suppressed this address and whose consent this is cannot be told: a person with records:erase lifts the right one with outside.suppression.lift",
          ),
      })
      .describe(
        "The booking system's copy (stage 65): the address and the refs the same erase suppressed are matched again from the next list",
      ),
  }),
  permission: "records:erase",
  risk: "write",
  actors: ["human"],
  mcp: { expose: false },
  // The address is personal data: the audit keeps that the call happened, not the address.
  redact: ["email"],
  async handler(input, ctx) {
    const hash = await erasedAddressHash(input.email);
    const row = await ctx.db
      .selectFrom("core_erased_address")
      .select("hash")
      .where("hash", "=", hash)
      .executeTakeFirst();
    const outside = await liftForAddress(ctx.db, input.email);
    if (!row && !outside.hashes.length && !outside.refsLeft) {
      return { removed: false, bookingSystem: { addresses: 0, refs: 0, refsLeft: 0 } };
    }
    if (ctx.blobs && !ctx.simulation) {
      await putEraseLog(ctx.blobs, {
        v: 1,
        kind: "allow",
        at: ctx.now,
        addresses: row ? [hash] : [],
        ...(outside.hashes.length
          ? {
              outside: outside.hashes,
              ...(outside.eraseId ? { outsideErase: outside.eraseId } : {}),
            }
          : {}),
      });
    }
    if (row) ctx.write(ctx.db.deleteFrom("core_erased_address").where("hash", "=", hash));
    if (outside.statements.length) ctx.write(...outside.statements);
    return {
      removed: Boolean(row),
      bookingSystem: {
        addresses: outside.addresses,
        refs: outside.refs,
        refsLeft: outside.refsLeft,
      },
    };
  },
});

export const erasureReapply = defineOperation({
  name: "erasure.reapply",
  description:
    "After the database is restored from a backup or Time Travel, erase again every person and " +
    "organisation the erase log says was erased, and restore the erased-address list and the " +
    "booking-system copy's suppressions. The log " +
    "lives in blob storage, outside the database, and holds only hashes. Safe to run more than " +
    "once. Admins only, and only a person in the app.",
  input: z.object({}),
  output: z.object({
    entries: z.number().describe("Erase-log entries read"),
    people: z.array(z.string()).describe("People erased again"),
    organisations: z.array(z.string()).describe("Organisations erased again"),
    addresses: z.number().describe("Addresses on the erased-address list"),
    outsideSuppressed: z
      .number()
      .describe("Booking-system refs and addresses suppressed again (stage 65), by keyed hash"),
  }),
  permission: "records:erase",
  risk: "destructive",
  actors: ["human"],
  mcp: { expose: false },
  async handler(_input, ctx) {
    if (!ctx.blobs?.list) {
      throw new ConfigError("The erase log is in blob storage (R2), which is not available here");
    }
    const entries = await readEraseLog(ctx.blobs);
    const plan = await planReapply(ctx.db, entries);
    // Suppressions keyed with another salt than the one in use would match nothing: an erased
    // Person would come back with the next list. Refused, loudly, before anything is done.
    const fingerprint = await saltFingerprint(ctx.db);
    if (plan.outside.some((o) => o.fingerprint !== null && o.fingerprint !== fingerprint)) {
      throw new ConfigError(
        "The erase log's booking-system suppressions were kept with another deployment salt than the one in use (the core_settings row text_number_salt was lost, perhaps by the restore). Restore that row from the backup, then run erasure.reapply again; until then erased people would come back with the next list.",
      );
    }
    const nested = { actor: ctx.actor, user: ctx.user, origin: ctx.origin };
    if (!ctx.simulation) {
      // Each erase commits on its own (and is audited); a failure stops here and the call can be
      // repeated: what was erased is no longer found.
      // A record merged into another one in the plan goes with it, so each is looked up again
      // just before its erase.
      for (const id of plan.people) {
        const live = await ctx.db
          .selectFrom("core_person")
          .select("id")
          .where("id", "=", id)
          .executeTakeFirst();
        if (live) await ctx.pipeline.invoke("person.erase", { id }, nested);
      }
      for (const id of plan.organisations) {
        const live = await ctx.db
          .selectFrom("core_organisation")
          .select("id")
          .where("id", "=", id)
          .executeTakeFirst();
        if (live) await ctx.pipeline.invoke("organisation.erase", { id }, nested);
      }
    }
    for (const part of chunk(plan.addresses)) {
      ctx.write(
        ctx.db
          .insertInto("core_erased_address")
          .values(
            part.map((hash) => ({
              hash,
              object_type: "person" as const,
              erased_at: ctx.now,
              erased_by: ctx.user.id,
            })),
          )
          .onConflict((oc) => oc.doNothing()),
      );
    }
    // The booking system's copy keeps nothing of them at the next load (stage 65, ADR 0926).
    const suppress = suppressStatements(plan.outside, ctx.now);
    if (suppress.length) ctx.write(...suppress);
    return {
      entries: entries.length,
      people: plan.people,
      organisations: plan.organisations,
      addresses: plan.addresses.length,
      outsideSuppressed: plan.outside.length,
    };
  },
});

export const erasureOperations = [
  erasureAddressStatus,
  erasureAllowAddress,
  erasureReapply,
] as const;
