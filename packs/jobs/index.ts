// Jobs (stage 39, step 5; ADR 0756): a trades or services business runs its work in one record,
// the job, from the first call to what is owed; a business with no site visits uses the same
// record as a plain project. Any product can turn it on (`packs` in its product.ts); it needs no
// other pack, and works beside Rostering (the shared roster) when that is installed.
//
// Everything that is a rule is the host's, declared here as behaviours (ADR 0404):
//   - a job moves through stages an admin edits (`stages`, ADR 0100), seeded as a Trades and a
//     Projects pipeline. Accepted, Signed off and Invoiced need a fact only the host or a person's
//     own act sets (`acceptedAt`, `signedOffAt`, `invoicedAt`, read-only; ADR 0750): nobody, an AI
//     included, drags a job into Accepted, and the stages that wait on a fact are an admin's, in
//     person, to change;
//   - a visit is one booked time at the site; each crew member's place on it is a shift (`staffed`,
//     ADR 0621): its times are the visit's, copied by the host in the visit's own batch
//     (`timesFrom`, ADR 0751), so a visit moved by any path moves its crew, and a move that would
//     put anyone in two places at once is refused whole, naming them. A crew place is cancelled
//     with its visit (`states.follows`, ADR 0507), carries the visit type's checklist (ADR 0650),
//     and with Rostering installed only a rosterer says who works it (ADR 0626);
//   - a crew account (`jobs.crew`) reaches only the jobs, visits and crew places of its own live
//     crew places, from a week before the visit to a week after (`mine`, ADR 0755), and reads no
//     line, rate or price;
//   - a line's money and what it belongs to are written only by the pack's tools (`readOnly`), and
//     only while it is a draft; approving, voiding and billing it are moves only tools or the host
//     make (ADR 0513), so an approved line cannot be edited, re-pointed or put in the Trash by a
//     record write (ADR 0863);
//   - a variation is approved before the work: by the office on the customer's word (a person's
//     own act, recorded as the office's), its lines approved or voided with it by the host.
// The tools in tools.ts compose the host's operations and add no rule of their own.
//
// Not in this step: the time tools and `workedOn`/`partOf` (stage 58 step 7), the acceptance of a
// record (step 4), the customer's link and anything open to customers (step 6), blocks, screens,
// mail and photos (step 7), `billable` and invoices (step 8). Access notes wait for a field only
// some staff read (ADR 0756).
import { defineExtension } from "@composable-os/sdk";
import {
  addLine,
  addMaterial,
  approveLine,
  approveVariation,
  assignCrew,
  bookVisit,
  CREW,
  cancelVisit,
  declineVariation,
  editLine,
  enquire,
  exportUnbilled,
  JOB,
  jobSummary,
  LINE,
  markDone,
  markMissed,
  markOnSite,
  markOnTheWay,
  moveVisit,
  myJob,
  myVisits,
  PLACE,
  PRICES,
  proposeVariation,
  recordAcceptance,
  removeCrew,
  SITE,
  unbilled,
  VARIATION,
  VISIT,
  VISIT_TYPE,
  voidLine,
  withdrawVariation,
} from "./tools.ts";

/** Job fields a stage can require on entering it (the stage's `requiredFields` options). */
const REQUIRABLE = [
  { value: "acceptedAt", label: "Accepted (a quote accepted, or the office's record of it)" },
  { value: "signedOffAt", label: "Signed off by the customer" },
  { value: "invoicedAt", label: "Invoiced" },
  { value: "customer", label: "Customer" },
  { value: "site", label: "Site" },
  { value: "owner", label: "Owner" },
  { value: "description", label: "Description" },
  { value: "lostReason", label: "Lost reason" },
];

const stage = (
  pipeline: string,
  name: string,
  position: number,
  type: "open" | "won" | "lost",
  requiredFields: string[] = [],
) => ({ name, pipeline: { seed: pipeline }, position, type, requiredFields });

/** A crew place counts (on the roster, and for the crew's reach) while it is booked. */
const PLACE_LIVE = ["booked"];

/** The crew's reach: through their own booked crew places, a week either side of the visit. */
const crewReach = (path?: string) => ({
  through: PLACE,
  who: "staff",
  ...(path ? { path } : {}),
  live: PLACE_LIVE,
  within: { from: "starts", to: "ends", days: 7 },
});

const VISIT_OPEN = ["booked", "on_the_way", "on_site"];

export default defineExtension({
  id: "jobs",
  version: "0.1.0",
  contractVersion: 1,
  label: "Jobs",
  description:
    "Jobs and projects moving through pipelines of stages, with sites, visits booked with a " +
    "crew (each place a shift on the roster), lines of what is quoted, added and used, " +
    "variations, charge-out rates and a download of what is unbilled.",
  permissions: {
    // query.sql: what is unbilled, over the rec_* views (one statement). person and
    // organisation: a job's customer and organisation.
    read: ["person", "organisation"],
    operations: ["query.sql"],
    modules: ["ops"],
  },
  // Prices, costs and margins are the office's (decision 5): admins, and whoever an admin grants
  // (ADR 0625). Everything else every admin and member holds; a crew account holds jobs:crew.
  restricted: [PRICES],
  grantable: [PRICES],
  grantableLabels: {
    [PRICES]:
      "Jobs: see and set prices, costs and rates on jobs, approve and void lines, and download " +
      "what is unbilled",
  },
  roles: {
    crew: {
      label: "Crew",
      description:
        "Works on customers' jobs: sees the jobs, visits and sites they have a place on, from a " +
        "week before the visit to a week after, marks a visit on the way, on site and done, " +
        "records materials and proposes extra work. Sees no prices.",
      permissions: [CREW],
      read: [JOB, VISIT, PLACE, VISIT_TYPE],
      mine: {
        [JOB]: crewReach("visit.job"),
        [VISIT]: crewReach("visit"),
        [PLACE]: crewReach(),
      },
    },
  },
  objects: {
    pipeline: {
      label: "Pipeline",
      plural: "Pipelines",
      icon: "kanban",
      titleField: "name",
      description: "A kind of job: an ordered set of stages its jobs move through.",
      navigation: "settings",
      fields: {
        name: { type: "text", label: "Name", required: true },
        position: { type: "number", label: "Order" },
        description: { type: "longText", label: "Description" },
      },
      indexes: [["position"]],
      seed: {
        trades: {
          name: "Trades",
          position: 1,
          description: "Work at a customer's site: enquiry, quote, visits, sign-off, invoice.",
        },
        projects: {
          name: "Projects",
          position: 2,
          description: "A plain project with tasks and time, and no site or visits.",
        },
      },
    },
    stage: {
      label: "Job stage",
      plural: "Job stages",
      icon: "list-ordered",
      titleField: "name",
      description:
        "One step of a pipeline: its order, whether jobs in it are open, won or lost, and what " +
        "a job needs to enter it. Stages that wait on a fact only the host sets (Accepted, " +
        "Signed off, Invoiced) are changed by an admin in person.",
      navigation: "settings",
      fields: {
        name: { type: "text", label: "Name", required: true },
        pipeline: { type: "relation", label: "Pipeline", to: "jobs.pipeline", required: true },
        position: { type: "number", label: "Order", required: true },
        type: {
          type: "select",
          label: "Type",
          required: true,
          options: [
            { value: "open", label: "Open" },
            { value: "won", label: "Won", color: "green" },
            { value: "lost", label: "Lost", color: "red" },
          ],
        },
        requiredFields: {
          type: "multiSelect",
          label: "Required to enter",
          description: "What a job must have to enter this stage.",
          options: REQUIRABLE,
        },
      },
      indexes: [["pipeline", "position"]],
      seed: {
        trEnquiry: stage("trades", "Enquiry", 1, "open"),
        trSiteVisit: stage("trades", "Site visit", 2, "open"),
        trQuoting: stage("trades", "Quoting", 3, "open"),
        trQuoteSent: stage("trades", "Quote sent", 4, "open"),
        trAccepted: stage("trades", "Accepted", 5, "open", ["acceptedAt"]),
        trScheduled: stage("trades", "Scheduled", 6, "open"),
        trInProgress: stage("trades", "In progress", 7, "open"),
        trComplete: stage("trades", "Complete", 8, "open"),
        trSignedOff: stage("trades", "Signed off", 9, "open", ["signedOffAt"]),
        trInvoiced: stage("trades", "Invoiced", 10, "open", ["invoicedAt"]),
        trPaid: stage("trades", "Paid", 11, "won"),
        trLost: stage("trades", "Lost", 12, "lost"),
        trCancelled: stage("trades", "Cancelled", 13, "lost"),
        prPlanning: stage("projects", "Planning", 1, "open"),
        prInProgress: stage("projects", "In progress", 2, "open"),
        prReview: stage("projects", "Review", 3, "open"),
        prDone: stage("projects", "Done", 4, "won"),
        prCancelled: stage("projects", "Cancelled", 5, "lost"),
      },
    },
    job: {
      label: "Job",
      plural: "Jobs",
      icon: "hard-hat",
      titleField: "title",
      owner: "owner",
      description:
        "A piece of work for a customer, or an internal project, moving through the stages of " +
        "its pipeline. Charged at a fixed price (the accepted estimate and approved variations) " +
        "or by the time and materials used.",
      navigationOrder: 30,
      fields: {
        title: { type: "text", label: "Title", required: true },
        customer: {
          type: "relation",
          label: "Customer",
          to: "person",
          description: "Who the work is for. Empty for an internal project.",
        },
        organisation: { type: "relation", label: "Organisation", to: "organisation" },
        site: {
          type: "relation",
          label: "Site",
          to: "jobs.site",
          description: "Where the work is. Empty for a plain project.",
        },
        pipeline: {
          type: "relation",
          label: "Pipeline",
          to: "jobs.pipeline",
          description: "Defaults to the Default pipeline setting (Trades).",
        },
        stage: {
          type: "relation",
          label: "Stage",
          to: "jobs.stage",
          track: "timeline",
          description: "Defaults to the pipeline's first stage. What a stage requires applies.",
        },
        status: {
          type: "select",
          label: "Status",
          readOnly: true,
          description: "Open, won or lost: the type of the job's stage.",
          options: [
            { value: "open", label: "Open" },
            { value: "won", label: "Won", color: "green" },
            { value: "lost", label: "Lost", color: "red" },
          ],
        },
        billing: {
          type: "select",
          label: "Charged",
          required: true,
          default: "fixed",
          description:
            "Fixed price: the accepted estimate plus approved variations, with time and " +
            "materials as cost only. Time and materials: the labour and materials used.",
          options: [
            { value: "fixed", label: "Fixed price" },
            { value: "time_and_materials", label: "Time and materials" },
          ],
        },
        defaultRate: {
          type: "relation",
          label: "Default rate",
          to: "jobs.rate",
          description: "The charge-out rate its labour is priced at unless changed.",
        },
        owner: { type: "user", label: "Owner" },
        description: { type: "longText", label: "Description" },
        lostReason: {
          type: "select",
          label: "Lost reason",
          description: "Required to move a job to a lost stage.",
          options: [
            { value: "price", label: "Price" },
            { value: "competitor", label: "Went with someone else" },
            { value: "timing", label: "Timing" },
            { value: "noResponse", label: "No response" },
            { value: "cancelledByCustomer", label: "Cancelled by the customer" },
            { value: "notForUs", label: "Not work we do" },
            { value: "other", label: "Other" },
          ],
        },
        closedAt: {
          type: "datetime",
          label: "Closed",
          readOnly: true,
          description: "Set when the job enters a won or lost stage; cleared when it reopens.",
        },
        // The host's facts (ADR 0750): set by the act they record, never by a move or a form.
        acceptedAt: {
          type: "datetime",
          label: "Accepted at",
          readOnly: true,
          description:
            "When the customer accepted the work. Set by the office's record of it " +
            "(recordAcceptance) until quotes are built; the Accepted stage needs it.",
        },
        acceptedBy: {
          type: "select",
          label: "Accepted by",
          readOnly: true,
          description: "A quote the customer accepted, or the office on the customer's word.",
          options: [
            { value: "quote", label: "Quote accepted" },
            { value: "office", label: "Office, on the customer's word" },
          ],
        },
        acceptedHow: {
          type: "text",
          label: "How it was accepted",
          readOnly: true,
          description: "What the office recorded (a signed paper estimate, a phone call).",
        },
        acceptedByName: { type: "text", label: "Acceptance recorded by", readOnly: true },
        signedOffAt: {
          type: "datetime",
          label: "Signed off at",
          readOnly: true,
          description: "When the customer signed the work off. The Signed off stage needs it.",
        },
        invoicedAt: {
          type: "datetime",
          label: "Invoiced at",
          readOnly: true,
          description: "When an invoice was issued for it. The Invoiced stage needs it.",
        },
        requestKey: {
          type: "text",
          label: "Request key",
          readOnly: true,
          description: "Set by enquire: the same enquiry sent again finds this job.",
        },
      },
      stages: {
        field: "stage",
        stage: {
          type: "type",
          order: "position",
          requiredFields: "requiredFields",
          group: "pipeline",
        },
        group: "pipeline",
        closedDate: "closedAt",
        status: "status",
        requiredByType: { lost: ["lostReason"] },
        defaultGroupSetting: "defaultPipeline",
      },
      unique: [{ fields: ["requestKey"] }],
      timelineLinks: ["organisation"],
      indexes: [
        ["stage"],
        ["pipeline", "status"],
        ["status", "updatedAt"],
        ["customer"],
        ["site"],
        ["organisation"],
        ["owner", "status"],
      ],
    },
    site: {
      label: "Site",
      plural: "Sites",
      icon: "map-pin",
      titleField: "name",
      description:
        "Where work is done: a customer's home, a shop, a block of flats. Its address and any " +
        "hazards the crew should know of.",
      navigationOrder: 31,
      fields: {
        name: {
          type: "text",
          label: "Name",
          required: true,
          description: "How the office knows it: the street address, or a name.",
        },
        customer: { type: "relation", label: "Customer", to: "person" },
        line1: { type: "text", label: "Address" },
        line2: { type: "text", label: "Address line 2" },
        suburb: { type: "text", label: "Suburb or town" },
        region: { type: "text", label: "State or region" },
        postcode: { type: "text", label: "Postcode" },
        country: { type: "text", label: "Country" },
        hazards: {
          type: "longText",
          label: "Hazards",
          description:
            "What the crew must know to work safely (asbestos, a steep roof, a dog). No access " +
            "codes: they are not kept here.",
        },
      },
      indexes: [["customer"], ["postcode"]],
    },
    visittype: {
      label: "Visit type",
      plural: "Visit types",
      icon: "clipboard-list",
      titleField: "name",
      description:
        "A kind of visit (a site visit, electrical work, a clean): how long it usually takes, " +
        "the checklist the crew ticks, and what a person must be qualified for to be on it.",
      navigation: "settings",
      fields: {
        name: { type: "text", label: "Name", required: true },
        defaultMinutes: {
          type: "number",
          label: "Usual length (minutes)",
          min: 15,
          max: 1440,
          step: 1,
          default: 60,
        },
        checklist: {
          type: "checklist",
          label: "Checklist",
          description: "Ticked off by each person on a visit of this type (a safety check).",
          personApproves: true,
        },
      },
      seed: {
        siteVisit: { name: "Site visit", defaultMinutes: 60 },
        electrical: { name: "Electrical", defaultMinutes: 240 },
        plumbing: { name: "Plumbing", defaultMinutes: 240 },
        clean: { name: "Clean", defaultMinutes: 180 },
      },
    },
    visit: {
      label: "Visit",
      plural: "Visits",
      icon: "calendar-clock",
      titleField: "title",
      titleDefault: { from: ["job"], suffix: "visit" },
      description:
        "One booked time at a job's site, with its crew. Moving it moves everyone on it; it is " +
        "marked on the way, on site and done by the crew, or cancelled by the office.",
      navigationOrder: 32,
      fields: {
        title: { type: "text", label: "Title" },
        // What decides a crew account's reach (ADR 0755): the job a visit is for and its times
        // are a person's to change, and the job is set only when the visit is booked.
        job: {
          type: "relation",
          label: "Job",
          to: "jobs.job",
          readOnly: true,
          personApproves: true,
        },
        visitType: {
          type: "relation",
          label: "Visit type",
          to: "jobs.visittype",
          required: true,
          personApproves: true,
        },
        starts: { type: "datetime", label: "Starts", required: true, personApproves: true },
        ends: { type: "datetime", label: "Ends", required: true, personApproves: true },
        zone: { type: "timezone", label: "Time zone" },
        arrivalWindow: {
          type: "text",
          label: "Arrival window",
          description: "What the customer is told (between 8 and 10).",
        },
        crewNotes: { type: "longText", label: "Notes for the crew" },
        state: {
          type: "select",
          label: "State",
          default: "booked",
          track: "timeline",
          options: [
            { value: "booked", label: "Booked", color: "blue" },
            { value: "on_the_way", label: "On the way", color: "orange" },
            { value: "on_site", label: "On site", color: "orange" },
            { value: "done", label: "Done", color: "green" },
            { value: "missed", label: "Missed", color: "red" },
            { value: "cancelled", label: "Cancelled", color: "gray" },
          ],
        },
        requestKey: {
          type: "text",
          label: "Request key",
          readOnly: true,
          description: "Set by bookVisit: the same booking sent again finds this visit.",
        },
      },
      indexes: [["job", "starts"], ["state", "starts"], ["starts"]],
      // One open visit per booking request: one refused whole (a clash) leaves it to be sent again.
      unique: [{ fields: ["requestKey"], states: VISIT_OPEN }],
      // Every move is a tool's, a person's own act or one a person approves (ADR 0513): a record
      // write cannot mark a visit done, and a live visit is out of the Trash but for those tools'
      // holders, in person (ADR 0863).
      states: {
        field: "state",
        initial: "booked",
        // Made by bookVisit for a job, never by a record write (its job is the tool's to set).
        create: { requires: ["job"] },
        moves: [
          { from: "booked", to: "on_the_way", by: ["host"], tools: ["markOnTheWay"] },
          { from: ["booked", "on_the_way"], to: "on_site", by: ["host"], tools: ["markOnSite"] },
          { from: VISIT_OPEN, to: "done", by: ["host"], tools: ["markDone"], final: true },
          {
            from: ["booked", "on_the_way"],
            to: "missed",
            by: ["host"],
            tools: ["markMissed"],
            final: true,
          },
          // bookVisit cancels a visit it just made when its crew cannot all be on it.
          {
            from: VISIT_OPEN,
            to: "cancelled",
            by: ["host"],
            tools: ["cancelVisit", "bookVisit"],
            final: true,
          },
        ],
      },
    },
    assignment: {
      label: "Crew place",
      plural: "Crew places",
      icon: "user-check",
      titleField: "title",
      titleDefault: { from: ["visit"], suffix: "crew" },
      description:
        "One person's place on a visit: a shift at the visit's time, on the roster and in their " +
        "calendar. Cancelled with its visit, or when the person is taken off it.",
      navigation: "none",
      fields: {
        title: { type: "text", label: "Title" },
        visit: {
          type: "relation",
          label: "Visit",
          to: "jobs.visit",
          required: true,
          personApproves: true,
        },
        staff: { type: "user", label: "Who", required: true, personApproves: true },
        lead: {
          type: "boolean",
          label: "Leads the visit",
          description: "The person the customer deals with on the day.",
        },
        // The visit's, copied by the host (ADR 0751); never written by anyone else.
        visitType: { type: "relation", label: "Visit type", to: "jobs.visittype", readOnly: true },
        starts: { type: "datetime", label: "Starts", readOnly: true, personApproves: true },
        ends: { type: "datetime", label: "Ends", readOnly: true, personApproves: true },
        zone: { type: "timezone", label: "Time zone", readOnly: true },
        state: {
          type: "select",
          label: "State",
          default: "booked",
          personApproves: true,
          options: [
            { value: "booked", label: "Booked", color: "blue" },
            { value: "cancelled", label: "Cancelled", color: "gray" },
          ],
        },
      },
      indexes: [["visit"], ["staff", "starts"], ["state", "starts"]],
      // One place a person on a visit.
      unique: [{ fields: ["visit", "staff"], states: ["booked"] }],
      states: {
        field: "state",
        initial: "booked",
        moves: [
          { from: "booked", to: "cancelled", by: ["host"], tools: ["removeCrew"], final: true },
        ],
        follows: { relation: "visit", when: { cancelled: "cancelled" }, from: ["booked"] },
      },
      staffed: {
        who: { field: "staff" },
        starts: "starts",
        ends: "ends",
        zone: "zone",
        kind: "visitType",
        live: PLACE_LIVE,
        // Its title names the customer's job: other staff see the visit type on the roster.
        private: true,
        timesFrom: "visit",
      },
      checklists: {
        template: "visitType.checklist",
        who: "staff",
        opens: "starts",
        closes: "ends",
        live: PLACE_LIVE,
      },
    },
    line: {
      label: "Job line",
      plural: "Job lines",
      icon: "receipt",
      titleField: "description",
      description:
        "Something quoted, added, used or owed on a job: an estimate line, a variation's line, a " +
        "material used or labour. Written by the pack's tools while a draft; approved, voided " +
        "and billed only by its tools and the host.",
      navigation: "none",
      fields: {
        description: { type: "text", label: "Description", readOnly: true },
        job: { type: "relation", label: "Job", to: "jobs.job", readOnly: true },
        kind: {
          type: "select",
          label: "Kind",
          readOnly: true,
          options: [
            { value: "estimate", label: "Estimate" },
            { value: "variation", label: "Variation" },
            { value: "material", label: "Material" },
            { value: "labour", label: "Labour" },
          ],
        },
        variation: {
          type: "relation",
          label: "Variation",
          to: "jobs.variation",
          readOnly: true,
          description: "The variation a variation line belongs to.",
        },
        quantity: {
          type: "number",
          label: "Quantity",
          readOnly: true,
          min: 0,
          max: 1_000_000,
        },
        unit: {
          type: "text",
          label: "Unit",
          readOnly: true,
          description: "What the quantity counts (m, each, hours).",
        },
        unitPrice: {
          type: "currency",
          label: "Unit price",
          readOnly: true,
          min: 0,
          max: 10_000_000,
          description: "In the base currency, before tax. Set by someone who sees prices.",
        },
        cost: {
          type: "currency",
          label: "Cost",
          readOnly: true,
          min: 0,
          max: 10_000_000,
          description: "What it cost the business, in total.",
        },
        itemCode: {
          type: "text",
          label: "Item",
          readOnly: true,
          description: "A catalogue or price-list item's code it names, if any.",
        },
        taxCode: { type: "text", label: "Tax code", readOnly: true },
        replaces: {
          type: "relation",
          label: "Replaces",
          to: "jobs.line",
          readOnly: true,
          description: "The draft this line corrected (a line's words and numbers never change).",
        },
        voidReason: {
          type: "select",
          label: "Why void",
          readOnly: true,
          options: [
            { value: "voided", label: "Voided" },
            { value: "replaced", label: "Replaced by a corrected line" },
          ],
        },
        recordedBy: { type: "user", label: "Recorded by", readOnly: true },
        recordedByName: { type: "text", label: "Recorded by (name)", readOnly: true },
        requestKey: {
          type: "text",
          label: "Request key",
          readOnly: true,
          description: "Set by the tool that added it: the same request again finds this line.",
        },
        state: {
          type: "select",
          label: "State",
          default: "draft",
          options: [
            { value: "draft", label: "Draft", color: "gray" },
            { value: "approved", label: "Approved", color: "green" },
            { value: "billed", label: "Billed", color: "blue" },
            { value: "void", label: "Void", color: "red" },
          ],
        },
      },
      indexes: [["job", "kind", "state"], ["variation"], ["state", "kind"]],
      unique: [{ fields: ["requestKey"] }],
      states: {
        field: "state",
        initial: "draft",
        // Made by the pack's tools only: what it is, for which job and how many.
        create: { requires: ["description", "job", "kind", "quantity"] },
        moves: [
          {
            from: "draft",
            to: "approved",
            by: ["host"],
            tools: ["approveLine", "recordAcceptance"],
          },
          // Billed is the host's, by an invoice (step 8); a voided invoice gives it back.
          { from: "approved", to: "billed", by: ["host"] },
          { from: "billed", to: "approved", by: ["host"] },
          {
            from: ["draft", "approved"],
            to: "void",
            by: ["host"],
            tools: ["voidLine", "editLine"],
            final: true,
          },
        ],
        // A variation's lines are approved, or voided, with it (in its batch).
        follows: {
          relation: "variation",
          when: { approved: "approved", declined: "void", withdrawn: "void" },
          from: ["draft"],
        },
      },
    },
    variation: {
      label: "Variation",
      plural: "Variations",
      icon: "file-diff",
      titleField: "title",
      description:
        "A change to agreed work: why, who asked, and its lines. Approved before the work is " +
        "done, by the customer or by the office on the customer's word (recorded as which).",
      navigation: "none",
      fields: {
        title: { type: "text", label: "Title", required: true },
        job: { type: "relation", label: "Job", to: "jobs.job", readOnly: true },
        why: { type: "longText", label: "Why", required: true },
        askedBy: {
          type: "select",
          label: "Asked by",
          options: [
            { value: "customer", label: "The customer" },
            { value: "crew", label: "The crew (found on site)" },
            { value: "office", label: "The office" },
          ],
        },
        proposedBy: { type: "user", label: "Proposed by", readOnly: true },
        proposedByName: { type: "text", label: "Proposed by (name)", readOnly: true },
        decidedBy: {
          type: "select",
          label: "Decided by",
          readOnly: true,
          options: [
            { value: "customer", label: "The customer" },
            { value: "office", label: "The office, on the customer's word" },
          ],
        },
        decidedAt: { type: "datetime", label: "Decided at", readOnly: true },
        decidedByName: { type: "text", label: "Recorded by", readOnly: true },
        decisionNote: {
          type: "text",
          label: "Decision note",
          readOnly: true,
          description: "What the office recorded: how the customer agreed or declined.",
        },
        requestKey: { type: "text", label: "Request key", readOnly: true },
        state: {
          type: "select",
          label: "State",
          default: "proposed",
          track: "timeline",
          options: [
            { value: "proposed", label: "Proposed", color: "orange" },
            { value: "approved", label: "Approved", color: "green" },
            { value: "declined", label: "Declined", color: "red" },
            { value: "withdrawn", label: "Withdrawn", color: "gray" },
          ],
        },
      },
      indexes: [["job", "state"]],
      unique: [{ fields: ["requestKey"] }],
      states: {
        field: "state",
        initial: "proposed",
        create: { requires: ["job"] },
        moves: [
          {
            from: "proposed",
            to: "approved",
            by: ["host"],
            tools: ["approveVariation"],
            requires: ["decidedBy", "decidedAt"],
            final: true,
          },
          {
            from: "proposed",
            to: "declined",
            by: ["host"],
            tools: ["declineVariation"],
            requires: ["decidedBy", "decidedAt"],
            final: true,
          },
          {
            from: "proposed",
            to: "withdrawn",
            by: ["host"],
            tools: ["withdrawVariation"],
            final: true,
          },
        ],
      },
    },
    rate: {
      label: "Rate",
      plural: "Rates",
      icon: "badge-dollar-sign",
      titleField: "name",
      description: "A charge-out rate for labour (standard, after hours, an apprentice's).",
      navigation: "settings",
      fields: {
        name: { type: "text", label: "Name", required: true },
        perHour: {
          type: "currency",
          label: "Per hour",
          min: 0,
          max: 100_000,
          description: "In the base currency, before tax.",
        },
        active: { type: "boolean", label: "In use", default: true },
      },
      seed: {
        standard: { name: "Standard", active: true },
        afterHours: { name: "After hours", active: true },
        apprentice: { name: "Apprentice", active: true },
      },
    },
  },
  views: {
    jobsBoard: {
      label: "Jobs board",
      type: "board",
      object: JOB,
      groupBy: "stage",
      cardFields: ["customer", "site", "owner", "billing"],
      sort: { field: "updatedAt", direction: "desc" },
    },
    openJobs: {
      label: "Open jobs",
      object: JOB,
      filter: { field: "status", op: "eq", value: "open" },
      sort: { field: "updatedAt", direction: "desc" },
      columns: ["title", "stage", "customer", "site", "owner", "billing"],
    },
    myJobs: {
      label: "My jobs",
      object: JOB,
      filter: {
        and: [
          { field: "status", op: "eq", value: "open" },
          { field: "owner", op: "eq", value: { $relative: "me" } },
        ],
      },
      sort: { field: "updatedAt", direction: "desc" },
      columns: ["title", "stage", "customer", "site", "billing"],
    },
    schedule: {
      label: "Schedule",
      type: "calendar",
      object: VISIT,
      dateField: "starts",
      mode: "week",
      filter: { field: "state", op: "in", value: VISIT_OPEN },
    },
    upcomingVisits: {
      label: "Upcoming visits",
      object: VISIT,
      filter: {
        and: [
          { field: "state", op: "in", value: VISIT_OPEN },
          { field: "starts", op: "gte", value: { $relative: "today" } },
        ],
      },
      sort: { field: "starts", direction: "asc" },
      columns: ["title", "job", "visitType", "starts", "ends", "arrivalWindow", "state"],
    },
    variationsWaiting: {
      label: "Variations waiting",
      object: VARIATION,
      filter: { field: "state", op: "eq", value: "proposed" },
      sort: { field: "createdAt", direction: "asc" },
      columns: ["title", "job", "askedBy", "proposedByName", "createdAt"],
    },
  },
  recordTabs: {
    jobVisits: {
      label: "Visits",
      on: JOB,
      view: {
        type: "table",
        object: VISIT,
        relation: "job",
        columns: ["title", "visitType", "starts", "ends", "arrivalWindow", "state"],
        sort: { field: "starts", direction: "asc" },
      },
      order: 10,
    },
    jobLines: {
      label: "Lines",
      on: JOB,
      view: {
        type: "table",
        object: LINE,
        relation: "job",
        columns: ["description", "kind", "quantity", "unit", "state", "recordedByName"],
        sort: { field: "createdAt", direction: "asc" },
      },
      order: 20,
    },
    jobVariations: {
      label: "Variations",
      on: JOB,
      view: {
        type: "table",
        object: VARIATION,
        relation: "job",
        columns: ["title", "askedBy", "state", "decidedBy", "decidedAt"],
        sort: { field: "createdAt", direction: "desc" },
      },
      order: 30,
    },
    visitCrew: {
      label: "Crew",
      on: VISIT,
      view: {
        type: "table",
        object: PLACE,
        relation: "visit",
        columns: ["staff", "lead", "state"],
        sort: { field: "createdAt", direction: "asc" },
      },
      order: 10,
    },
    siteJobs: {
      label: "Jobs",
      on: SITE,
      view: {
        type: "table",
        object: JOB,
        relation: "site",
        columns: ["title", "stage", "customer", "status"],
        sort: { field: "updatedAt", direction: "desc" },
      },
      order: 10,
    },
    personJobs: {
      label: "Jobs",
      on: "person",
      view: {
        type: "table",
        object: JOB,
        relation: "customer",
        columns: ["title", "stage", "site", "status"],
        sort: { field: "updatedAt", direction: "desc" },
      },
      order: 40,
    },
    organisationJobs: {
      label: "Jobs",
      on: "organisation",
      view: {
        type: "table",
        object: JOB,
        relation: "organisation",
        columns: ["title", "stage", "customer", "status"],
        sort: { field: "updatedAt", direction: "desc" },
      },
      order: 40,
    },
  },
  settings: {
    defaultPipeline: {
      type: "text",
      label: "Default pipeline",
      description: "The pipeline (by name or id) a new job goes in when none is chosen.",
      default: "Trades",
    },
  },
  tools: {
    enquire,
    jobSummary,
    recordAcceptance,
    bookVisit,
    moveVisit,
    cancelVisit,
    assignCrew,
    removeCrew,
    myVisits,
    myJob,
    markOnTheWay,
    markOnSite,
    markDone,
    markMissed,
    addMaterial,
    addLine,
    editLine,
    approveLine,
    voidLine,
    proposeVariation,
    approveVariation,
    declineVariation,
    withdrawVariation,
    unbilled,
    exportUnbilled,
  },
});
