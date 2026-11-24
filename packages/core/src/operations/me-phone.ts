// me.phone.startCheck and me.phone.check (stage 30 step 3, ADR 0673): a signed-in member checks
// one of their own numbers by a code sent to it by text. A number they checked is textable for
// them (texts.ts), and never for another Person (issue #302's rule for numbers).
//
// - Only a number on the member's own record, and a mobile in a country texts may go to: a code
//   is never sent to a number someone just typed.
// - At most three codes a day for the member and three a day for the number, whoever asks; each
//   one counts against the month's text limit (a code costs the business, ADR 0672).
// - The code is the text gatekeeper's provider's: the host never sees it. Sent and checked
//   through the integration host's `phone-check` queue, the only one the gatekeeper takes them
//   from.
// - A match marks the number the member's own (`phones:<number>`), unless a person already stands
//   behind it, so a number an AI added becomes textable only once its owner proved it.
// Customers only, never in MCP, rate limited per account like every customer operation.
import { z } from "zod";
import { ConflictError, OperationError, RateLimitedError, ValidationError } from "../errors.ts";
import { defineOperation, type HandlerContext } from "../operation.ts";
import type { CustomerPrincipal } from "../principals.ts";
import { loadRoutineMailSettings } from "../routine-mail/index.ts";
import { phoneDigits, phoneField, valueHash } from "../routine-mail/marks.ts";
import { mobileInCountries } from "../routine-mail/numbers.ts";
import {
  claimCodeSpend,
  countCodeTry,
  numberHash,
  refundCodeSpend,
  startPhoneCheck,
  textTarget,
} from "../routine-mail/texts.ts";

/** How long a code may be typed back. */
const CODE_MINUTES = 10;

function customerOf(ctx: HandlerContext): CustomerPrincipal {
  const principal = ctx.principal;
  if (principal.kind !== "customer") {
    throw new OperationError("internal", `${ctx.operation} is for a customer's call`);
  }
  return principal;
}

const numberInput = z
  .string()
  .min(3)
  .max(40)
  .describe("One of your own numbers, as it is in your details");

/** The member's own number matching `number`, as recorded and in international form. */
async function ownMobile(
  ctx: HandlerContext,
  personId: string,
  number: string,
): Promise<{ raw: string; to: string }> {
  const settings = await loadRoutineMailSettings(ctx.db);
  if (!settings.textCountries.length) {
    throw new ValidationError("Texts are not set up here, so a number cannot be checked yet");
  }
  const to = mobileInCountries(number, settings.textCountries);
  if (!to) {
    throw new ValidationError("That is not a mobile number we can text", { field: "number" });
  }
  const phones = await ctx.db
    .selectFrom("core_person_phones")
    .select("number")
    .where("person_id", "=", personId)
    .limit(20)
    .execute();
  const own = phones.find((p) => mobileInCountries(p.number, settings.textCountries) === to);
  if (!own) {
    throw new ValidationError("Add the number to your details first, then check it", {
      field: "number",
    });
  }
  return { raw: own.number, to };
}

const mask = (to: string) =>
  `${to.slice(0, 4)}${"•".repeat(Math.max(0, to.length - 7))}${to.slice(-3)}`;

export const mePhoneStartCheck = defineOperation({
  name: "me.phone.startCheck",
  description:
    "Sends a code by text to one of your own mobile numbers, to check it is yours. Type it back " +
    "with me.phone.check within 10 minutes. At most three codes a day.",
  input: z.object({ number: numberInput }).strict(),
  output: z.object({
    started: z.literal(true),
    number: z.string().describe("The number the code went to, partly hidden"),
    minutes: z.number().int().describe("How long the code may be typed back"),
  }),
  permission: "records:write",
  risk: "write",
  audiences: ["customer"],
  hostInternal: true,
  mcp: { expose: false },
  async handler(input, ctx) {
    const { personId } = customerOf(ctx);
    const own = await ownMobile(ctx, personId, input.number);
    const integrations = ctx.integrations;
    return ctx.afterCommit(async () => {
      const target = await textTarget(ctx.db);
      if (!target || !integrations?.callAsHost) {
        throw new ValidationError("Texts are not set up here, so a number cannot be checked yet");
      }
      const started = await startPhoneCheck(ctx.db, personId, own.to, ctx.now);
      if ("refused" in started) {
        if (started.refused.startsWith("at most")) {
          throw new RateLimitedError(`You can ask for ${started.refused}: try again tomorrow`, {
            retryAfterSeconds: 86_400,
          });
        }
        throw new ConflictError(`We cannot text this number: ${started.refused}`);
      }
      const spend = await claimCodeSpend(ctx.db, ctx.now);
      if (!spend.ok) throw new ConflictError(`We cannot send a code just now: ${spend.why}`);
      try {
        await integrations.callAsHost({
          ...target,
          method: "startCheck",
          args: [{ to: own.to }],
          purpose: "phone-check",
        });
      } catch (error) {
        await refundCodeSpend(ctx.db, spend.month, spend.cost, ctx.now);
        throw error;
      }
      return { started: true as const, number: mask(own.to), minutes: CODE_MINUTES };
    });
  },
});

export const mePhoneCheck = defineOperation({
  name: "me.phone.check",
  description:
    "Checks the code a text sent to one of your own numbers (me.phone.startCheck). A match marks " +
    "the number as checked: your routine texts may go to it.",
  input: z
    .object({
      number: numberInput,
      code: z.string().regex(/^\d{4,10}$/, "the digits of the code"),
    })
    .strict(),
  output: z.object({ checked: z.boolean() }),
  permission: "records:write",
  risk: "write",
  audiences: ["customer"],
  hostInternal: true,
  mcp: { expose: false },
  async handler(input, ctx) {
    const { personId } = customerOf(ctx);
    const own = await ownMobile(ctx, personId, input.number);
    const integrations = ctx.integrations;
    return ctx.afterCommit(async () => {
      const hash = await numberHash(ctx.db, own.to);
      const since = new Date(Date.parse(ctx.now) - CODE_MINUTES * 60_000).toISOString();
      const open = await ctx.db
        .selectFrom("core_phone_check")
        .select("id")
        .where("person_id", "=", personId)
        .where("number_hash", "=", hash)
        .where("checked_at", "is", null)
        .where("started_at", ">", since)
        .orderBy("started_at", "desc")
        .executeTakeFirst();
      const target = await textTarget(ctx.db);
      if (!open || !target || !integrations?.callAsHost) return { checked: false };
      // Three tries a code, counted here whatever the provider allows (the review of PR #435).
      if (!(await countCodeTry(ctx.db, open.id))) return { checked: false };
      const result = await integrations.callAsHost({
        ...target,
        method: "check",
        args: [{ to: own.to, code: input.code }],
        purpose: "phone-check",
      });
      const checked = (result.value as { checked?: unknown } | null)?.checked === true;
      if (!checked) return { checked: false };
      await ctx.db
        .updateTable("core_phone_check")
        .set({ checked_at: ctx.now })
        .where("id", "=", open.id)
        .execute();
      // The member's own, proved: their mark, unless a person already stands behind it.
      await ctx.db
        .insertInto("core_value_mark")
        .values({
          object_type: "person",
          record_id: personId,
          field: phoneField(own.raw),
          value_hash: await valueHash(phoneDigits(own.raw)),
          standing: "customer",
          by_id: null,
          at: ctx.now,
        })
        .onConflict((oc) =>
          oc
            .columns(["object_type", "record_id", "field"])
            .doUpdateSet({
              standing: "customer",
              value_hash: (eb) => eb.ref("excluded.value_hash"),
              by_id: null,
              at: ctx.now,
            })
            .where((eb) =>
              eb.or([
                eb("core_value_mark.standing", "not in", ["person", "default"]),
                eb("core_value_mark.value_hash", "!=", eb.ref("excluded.value_hash")),
              ]),
            ),
        )
        .execute();
      return { checked: true };
    });
  },
});

export const mePhoneOperations = [mePhoneStartCheck, mePhoneCheck] as const;
