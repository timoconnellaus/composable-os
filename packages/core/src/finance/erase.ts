// What an erase (ADR 0320) reaches of finance (stage 52, ADR 0790): a reopened month's reason that
// names the person becomes "[erased]" (the one change a reopened version takes), and a closed
// report row about them keeps its figures with "Erased person" for its name and no email (the one
// change a closed row takes). Amounts, dates, order ids and every entry stay, so no total moves.
import type { HandlerContext } from "../operation.ts";
import { jsonList } from "../records/common.ts";
import { aboutPattern } from "../records/erase-subject.ts";

export async function queueEraseFinance(
  ctx: HandlerContext,
  subject: {
    object: string;
    recordIds: readonly string[];
    terms: readonly string[];
    names: readonly string[];
  },
): Promise<void> {
  // Reopened versions are few (one per reopen): read their reasons and match them as the
  // assistant's free text is matched, names as whole words.
  const pattern = aboutPattern(subject.terms, subject.names);
  if (pattern) {
    const reopened = await ctx.db
      .selectFrom("core_finance_period")
      .select(["id", "reopen_reason"])
      .where("state", "=", "reopened")
      .where("reopen_reason", "!=", "[erased]")
      .execute();
    const named = reopened.filter((r) => {
      pattern.lastIndex = 0;
      return pattern.test(r.reopen_reason ?? "");
    });
    if (named.length) {
      ctx.write(
        ctx.db
          .updateTable("core_finance_period")
          .set({ reopen_reason: "[erased]" })
          .where("id", "in", jsonList(named.map((r) => r.id))),
      );
    }
  }
  if (subject.object === "person" && subject.recordIds.length) {
    ctx.write(
      ctx.db
        .updateTable("core_finance_row")
        .set({ name: "Erased person", email: null })
        .where("person_id", "in", jsonList([...subject.recordIds])),
    );
  }
}
