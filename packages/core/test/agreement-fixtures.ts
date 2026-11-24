// A published agreement for the tests: a document made, its draft saved, published as version 1
// and attached to points, through the operations an admin uses.
import { unique } from "./helpers.ts";

/** Calls an operation as the admin who writes the documents. */
type Call = (name: string, input: unknown) => Promise<unknown>;

/** A document body of one paragraph of `text`. */
export const agreementBody = (text: string) => ({
  blocks: [{ type: "paragraph", content: [{ type: "text", text }] }],
});

export interface AgreementOptions {
  points: string[];
  title?: string;
  text?: string;
  how?: "typed" | "drawn";
  forWhom?: "everyone" | "dependants";
  questions?: unknown[];
  askAgainMonths?: number | null;
}

/** A live document of `kind`: its id and its current version's. */
export async function publishAgreement(
  call: Call,
  kind: string,
  options: AgreementOptions,
): Promise<{ id: string; versionId: string }> {
  const { id } = (await call("agreement.create", {
    title: options.title ?? unique(`Fixture ${kind}`),
    kind,
  })) as { id: string };
  const saved = (await call("agreement.draft.save", {
    id,
    body: agreementBody(options.text ?? "Fixture text: not a real document."),
    tickLabel: "I have read this fixture",
    ...(options.how ? { how: options.how } : {}),
    ...(options.forWhom ? { forWhom: options.forWhom } : {}),
    ...(options.questions ? { questions: options.questions } : {}),
    ...(options.askAgainMonths !== undefined ? { askAgainMonths: options.askAgainMonths } : {}),
  })) as { hash: string; rev: number };
  const { version } = (await call("agreement.publish", {
    documentId: id,
    draftHash: saved.hash,
    draftRev: saved.rev,
    number: 1,
    change: "small",
  })) as { version: { id: string } };
  await call("agreement.attach", { documentId: id, points: options.points });
  return { id, versionId: version.id };
}
