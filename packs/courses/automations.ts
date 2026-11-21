// The Courses automation (stage 42, step 6): when a student first opens a course that has session
// lessons, each program those lessons use is assigned to them from that day, as Programs assigns
// any program (`x.programs.assign`): one dated session per session of its layout, the dates a
// suggested pace. They then log sets with Programs' own tools. It runs as the extension, a few
// seconds after the student's first progress row; that row exists only for a student who holds
// access to the course (the host's `requireAccess`), so no one else is assigned anything.
import { defineAutomation } from "@composable-os/sdk";
import { asOutline, sessionPrograms } from "./outline.ts";

const COURSE = "courses.course";
const PROGRESS = "courses.progress";
const ASSIGNMENT = "programs.assignment";

interface RecordShape {
  id: string;
  values: Record<string, unknown>;
}

export const assignSessions = defineAutomation({
  label: "Assign a course's sessions",
  description:
    "When a student first opens a course with session lessons, assigns them each Programs " +
    "program those lessons use, from that day. A program already assigned to them is left as it is.",
  trigger: { type: "record", object: PROGRESS, on: ["created"] },
  steps: [
    {
      name: "findPrograms",
      label: "Find the course's session programs and the student's assignments",
      reads: [PROGRESS, COURSE, ASSIGNMENT],
      calls: ["record.get", "record.version", "record.list"],
    },
    {
      name: "assign",
      label: "Assign each program not yet assigned",
      writes: [{ object: ASSIGNMENT }, { object: "programs.session" }],
      calls: ["x.programs.assign"],
    },
  ],
  async run(event, step, ctx) {
    const progressId = event.record?.id;
    if (!progressId) return { skipped: "no progress row" };
    const wanted = await step.do("findPrograms", async () => {
      const row = await ctx.ops.call<RecordShape>("record.get", { object: PROGRESS, id: progressId });
      const person = String(row.values.holder ?? "");
      const courseId = String(row.values.course ?? "");
      if (!person || !courseId) return { person, programs: [] as string[] };
      const version = await ctx.ops.call<{ values: Record<string, unknown> }>("record.version", {
        object: COURSE,
        id: courseId,
      });
      const programs = sessionPrograms(asOutline(version.values.outline));
      const missing: string[] = [];
      for (const program of programs) {
        const had = await ctx.ops.call<{ items: RecordShape[] }>("record.list", {
          object: ASSIGNMENT,
          filter: {
            and: [
              { field: "person", op: "eq", value: person },
              { field: "program", op: "eq", value: program },
            ],
          },
          limit: 1,
        });
        if (!had.items.length) missing.push(program);
      }
      return { person, programs: missing };
    });
    if (!wanted.programs.length) return { assigned: 0 };
    const today = new Date().toISOString().slice(0, 10);
    const made = await step.do("assign", async () => {
      const ids: string[] = [];
      for (const programId of wanted.programs) {
        const out = await ctx.ops.call<{ assignmentId: string }>("x.programs.assign", {
          programId,
          personId: wanted.person,
          startDate: today,
        });
        ids.push(out.assignmentId);
      }
      return ids;
    });
    return { assigned: made.length };
  },
});

export const coursesAutomations = { assignSessions };
