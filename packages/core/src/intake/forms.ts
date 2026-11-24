// The form side of the public-write door (stage 29 step 2, ADR 0720): the questions a business
// saves are checked on every write, and the door finds a form only while it takes answers from
// the caller.
import type { Questions } from "@composable-os/sdk";
import { NotFoundError } from "../errors.ts";
import { getObject } from "../fields/index.ts";
import type { HandlerContext } from "../operation.ts";
import { loadRecord } from "../operations/record.ts";
import { liveContent } from "../records/publish.ts";
import { orgReader } from "../visibility/index.ts";
import {
  type DestinationObject,
  destinationObjectOf,
  type FormObject,
  formObjectOf,
  isTrue,
  type SubmissionObject,
  submissionObjectOf,
} from "./declared.ts";

/** A form the door found, as it takes answers now. */
export interface OpenForm {
  object: FormObject;
  submission: SubmissionObject;
  id: string;
  /** The working copy's values (who may answer, dates, cap, destination: not versioned). */
  values: Record<string, unknown>;
  /** The published version answered, and its questions. */
  version: number;
  questions: Questions;
  /** The rest of the published content (a title, a thank-you), for the client to draw. */
  content: Record<string, unknown>;
  anonymous: boolean;
  answeredBy: string | null;
  destination: DestinationObject | null;
}

/** Who is asking, for "open to this caller": the public, a signed-in customer, or staff. */
export type Asker = "public" | "customer" | "staff";

/**
 * The form `id` of `objectName`, published and taking answers from `asker` now; otherwise not
 * found, the same answer whatever the reason (a draft, closed, unpublished, out of its dates, not
 * open to this caller, or no such form). Staff enter any published form (a phone call, paper, a
 * staff form). A `links` form takes answers only by a personal link (step 5 builds them).
 */
export async function openForm(
  ctx: HandlerContext,
  objectName: string,
  id: string,
  asker: Asker,
): Promise<OpenForm> {
  const object = formObjectOf(getObject(objectName));
  const notFound = () => new NotFoundError(objectName, id);
  if (!object) throw notFound();
  const submission = submissionObjectOf(object);
  if (!submission) throw notFound();
  const record = await loadRecord(orgReader(ctx.db), object, id);
  if (!record) throw notFound();
  const live = await liveContent(ctx, object.name, id);
  if (!live) throw notFound();
  const { intake } = object;
  const values = record.values;
  const answeredBy =
    typeof values[intake.answeredBy] === "string" ? (values[intake.answeredBy] as string) : null;
  if (asker !== "staff") {
    const state = object.states ? values[object.states.field] : null;
    if (typeof state !== "string" || !intake.openIn.includes(state)) throw notFound();
    const opens = intake.opensAt ? values[intake.opensAt] : null;
    const closes = intake.closesAt ? values[intake.closesAt] : null;
    const now = Date.parse(ctx.now);
    if (typeof opens === "string" && Date.parse(opens) > now) throw notFound();
    if (typeof closes === "string" && Date.parse(closes) <= now) throw notFound();
    const open = answeredBy === "public" || (answeredBy === "customers" && asker === "customer");
    if (!open) throw notFound();
  }
  const questions = live.content[intake.questions] as Questions | null | undefined;
  if (!questions || !Array.isArray(questions.items)) throw notFound();
  const anonymous = intake.anonymous ? isTrue(values[intake.anonymous]) : false;
  const destination =
    !anonymous && intake.destination ? destinationObjectOf(values[intake.destination]) : null;
  return {
    object,
    submission,
    id,
    values,
    version: live.version,
    questions,
    content: live.content,
    anonymous,
    answeredBy,
    destination,
  };
}
