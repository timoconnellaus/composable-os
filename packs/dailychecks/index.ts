// Daily checklists (ADR 0651; a follow-on to stage 45 step 4b, ADR 0650): checklists done on their
// own, without a roster. Opening up, closing down, the cleaning: a checklist the business writes in
// Settings → Checklists, given a standing schedule there (the days it is due in the business's
// time zone, a time it is due by, and who may do it). Each due day has one run, which anyone who
// may do it ticks off; whoever ticks the last step finishes it; one not finished by the end of its
// day is missed. Those who manage checklists see how each day went and may tick for someone.
//
// Everything that is a rule is the host's (ADRs 0404, 0650 and 0651): the schedule is a core
// template's, the runs and ticks core tables, who may do it and who manages checklists held by the
// host's operations and the database's triggers. This pack is its screens and the tools they call,
// and adds no rule. It requires nothing: a business with no roster uses it alone, and a business
// with Rostering keeps a duty's checklist as it was (a duty shift's run is the shift's).
//
// Why a pack and not Rostering's or the base layer (ADR 0651): the operations are core, but a
// screen in the admin is a shipped pack's (stage 47, ADR 0660), and a screen in Rostering would be
// missing for a business that has not installed it. A small pack of its own carries the two
// screens and its blocks for the app, and nothing else.
import { defineExtension } from "@composable-os/sdk";
import { checklistDay, done, history, tickStep, today } from "./tools.ts";

export default defineExtension({
  id: "dailychecks",
  version: "0.1.0",
  contractVersion: 1,
  label: "Daily checklists",
  description:
    "Checklists done on their own: opening, closing and cleaning, due on set days by a set " +
    "time, ticked off by whoever may do them, with how each day went for those who manage them.",
  permissions: {
    operations: [
      "checklist.today",
      "checklist.day",
      "checklist.dayTick",
      "checklist.dayDone",
      "checklist.days",
    ],
    modules: ["ops"],
  },
  objects: {},
  tools: {
    today,
    day: checklistDay,
    tick: tickStep,
    done,
    history,
  },
  // Staff screens in the product's admin (stage 47, ADR 0660): today's checklists for every staff
  // account (each sees only the ones they may do; the host decides), and how each day went for
  // those who manage checklists (checklists:write).
  screens: {
    today: {
      label: "Today's checklists",
      block: "dailychecks-today",
      export: "TodaysChecklists",
      nav: { group: "Checklists", order: 10 },
      opens: ["today", "tick"],
    },
    history: {
      label: "Checklist history",
      block: "dailychecks-history",
      export: "ChecklistHistory",
      nav: { group: "Checklists", order: 20 },
      opens: ["history"],
    },
  },
});
