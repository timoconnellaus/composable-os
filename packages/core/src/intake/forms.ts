// The form side of the public-write door (stage 29 step 2, ADR 0720): the questions a business
// saves are checked on every write, and the door finds a form only while it takes answers from
// the caller.
import { type Questions, SLUG_MAX, SLUG_RE } from "@composable-os/sdk";
import { NotFoundError } from "../errors.ts";
import { getObject } from "../fields/index.ts";
import type { HandlerContext } from "../operation.ts";
import { loadRecord } from "../operations/record.ts";
import { liveContent } from "../records/publish.ts";
import { orgReader } from "../visibility/index.ts";
import { listVisible } from "../visibility/records.ts";
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
  /** The working copy's values (its state, dates, cap and who is told: not versioned). */
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
 * The id of the live form of `objectName` whose address is `slug` (a form object with
 * `publishable.slug`), or the form an old address of it points to (a slug changed after
 * publishing keeps its old one as a redirect), or not found: the same answer as `openForm` gives, so an address tells a
 * caller nothing a closed or unpublished form would not. Whether it takes answers is `openForm`'s.
 */
export async function formIdBySlug(
  ctx: Pick<HandlerContext, "db">,
  objectName: string,
  slug: string,
): Promise<string> {
  const object = formObjectOf(getObject(objectName));
  const notFound = () => new NotFoundError(objectName, slug);
  const field = object?.publishable?.slug;
  if (!object || !field || slug.length > SLUG_MAX || !SLUG_RE.test(slug)) throw notFound();
  const page = await listVisible(orgReader(ctx.db), object, {
    filter: { field, op: "eq", value: slug },
    limit: 1,
  });
  const id = page.items[0]?.id;
  if (id) return id;
  // An old address of a published form whose slug changed (ADR 0442): a printed QR code or a link
  // still finds the form. Whether it takes answers is openForm's, as for its address now.
  const redirect = await ctx.db
    .selectFrom("core_slug_redirect")
    .select("record_id")
    .where("object_type", "=", object.name)
    .where("slug", "=", slug)
    .executeTakeFirst();
  if (!redirect) throw notFound();
  return redirect.record_id;
}

/**
 * The form `id` of `objectName`, published and taking answers from `asker` now; otherwise not
 * found, the same answer whatever the reason (a draft, closed, unpublished, out of its dates, not
 * open to this caller, or no such form). Staff enter any published form (a phone call, paper, a
 * staff form). A `links` form takes answers only by a personal link (ADR 0723): `byLink` opens a
 * form to the holder of a live link whoever it is open to, but never a staff form or an anonymous
 * one (an anonymous form keeps no Person, so a link to one would be a lie).
 */
export async function openForm(
  ctx: Pick<HandlerContext, "db" | "now">,
  objectName: string,
  id: string,
  asker: Asker,
  options: { byLink?: boolean } = {},
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
  const published = live.content;
  // Who may answer, anonymity and the destination are the version's, as the questions are: an
  // edit does not change how a published form treats answers until a person publishes it.
  const answeredBy =
    typeof published[intake.answeredBy] === "string"
      ? (published[intake.answeredBy] as string)
      : null;
  if (asker !== "staff") {
    const state = object.states ? values[object.states.field] : null;
    if (typeof state !== "string" || !intake.openIn.includes(state)) throw notFound();
    const opens = intake.opensAt ? values[intake.opensAt] : null;
    const closes = intake.closesAt ? values[intake.closesAt] : null;
    const now = Date.parse(ctx.now);
    if (typeof opens === "string" && Date.parse(opens) > now) throw notFound();
    if (typeof closes === "string" && Date.parse(closes) <= now) throw notFound();
    const open = options.byLink
      ? answeredBy === "public" || answeredBy === "customers" || answeredBy === "links"
      : answeredBy === "public" || (answeredBy === "customers" && asker === "customer");
    if (!open) throw notFound();
  }
  const questions = published[intake.questions] as Questions | null | undefined;
  if (!questions || !Array.isArray(questions.items)) throw notFound();
  const anonymous = intake.anonymous ? isTrue(published[intake.anonymous]) : false;
  if (options.byLink && anonymous) throw notFound();
  const destination =
    !anonymous && intake.destination ? destinationObjectOf(published[intake.destination]) : null;
  // What a client draws: the published content without the host's own settings.
  const settings = new Set([intake.answeredBy, intake.anonymous, intake.destination]);
  const content = Object.fromEntries(
    Object.entries(published).filter(([key]) => !settings.has(key)),
  );
  return {
    object,
    submission,
    id,
    values,
    version: live.version,
    questions,
    content,
    anonymous,
    answeredBy,
    destination,
  };
}
