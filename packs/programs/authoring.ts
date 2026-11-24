// Building a working copy without the builder (stage 41, step 6): reading a coach's pasted
// shorthand, and laying out a draft from a brief. Pure functions over the bank: every exercise a
// layout names is one of the bank's, found by name, and a line that names one the bank does not
// have, or cannot be read, is listed for the coach to fix, never guessed. The host still checks
// the result against the layout schema and that every ref is a live exercise.
//
// The shorthand is the shape coaches already type (Ghetto Movement's prototype format):
//
//   Title: Strength, term 1
//   Kind: class                                               (class, client or course; optional)
//   Guidance: Reps and tempo are followed literally…         (for coaches)
//   Week: 1                                                   (optional; else one week)
//   Session: Monday                                           (a weekday names its day)
//   Focus: Slow, controlled reps
//   Warm-up: Wrists and shoulders
//   - Scap push ups x 10
//   Block A: Approx 4-7 rounds                                (rounds: the first number)
//   A1: L sit to planche                                      (a name alone: levels follow)
//     1: L sit x 8-12 sec + Planche lean x 3 (32X1)           ("+" together)
//     3: Pike push throughs x 3 | L-sit walk ups x 3          ("|" alternatives)
//     * a note for coaches on the line above
//   TV: a note shown to members
//   B1: Ring rows x 5 (5050)                                  (an exercise: for everyone)
//   C1: Hollow hold x 30 sec                                  (for everyone, and levels beside it)
//     2: Tuck planche x 3
import type {
  Block,
  Item,
  Layout,
  Level,
  Note,
  Prescription,
  Session,
  SetTarget,
} from "./layout.ts";

export interface BankExercise {
  id: string;
  name: string;
  measure?: string | null;
  theme?: string | null;
  level?: string | null;
}

/** A line the import could not turn into the layout, and why. */
export interface UnreadLine {
  line: number;
  text: string;
  reason: string;
}

export type ProgramKind = "class" | "client" | "course";

export interface ImportResult {
  title: string | null;
  /** What a `Kind:` line said, if there was one. */
  kind: ProgramKind | null;
  guidance: string | null;
  layout: Layout;
  unread: UnreadLine[];
}

const norm = (name: string) =>
  name
    .toLowerCase()
    .replace(/[’'"“”]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();

const WEEKDAYS = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"];

/** The bank by normalised name, and a lookup that also tries without a trailing plural "s". */
function bankIndex(bank: readonly BankExercise[]) {
  const byName = new Map<string, BankExercise>();
  for (const e of bank) byName.set(norm(e.name), e);
  return (name: string): BankExercise | undefined => {
    const n = norm(name);
    return byName.get(n) ?? byName.get(n.replace(/s$/, "")) ?? byName.get(`${n}s`);
  };
}

/**
 * A prescription's text ("8-12 sec", "3 reps with a 5 sec hold each rep", "10", "5 each side")
 * as typed sets: `count` of them (a block's rounds), each the same target. Whatever the numbers
 * do not say stays in the prescription's note, in the coach's words.
 */
export function readTarget(
  rx: string | undefined,
  measure: string | null | undefined,
  count: number,
): { sets: SetTarget[]; note?: string } | string {
  const text = (rx ?? "").trim();
  const sets = (target: SetTarget) =>
    Array.from({ length: Math.max(1, Math.min(count, 12)) }, () => ({ ...target }));
  const extra = (used: string) => {
    const rest = text.replace(used, "").replace(/^[\s,;:-]+|[\s,;:-]+$/g, "");
    return rest ? { note: text.length <= 300 ? text : text.slice(0, 300) } : {};
  };
  if (!text) {
    if (measure === "time" || measure === "hold") return "no time given";
    return "no reps or time given";
  }
  const hold = /(\d+)\s*(?:-\s*\d+\s*)?(?:s|sec|secs|seconds)\s+hold/i.exec(text);
  const reps = /^(\d+)(?:\s*-\s*(\d+))?(?:\s*(?:reps?|each|\/))?/i.exec(text);
  const secs = /^(\d+)(?:\s*-\s*(\d+))?\s*(?:s|sec|secs|seconds)\b/i.exec(text);
  const mins = /^(\d+)(?:\s*-\s*(\d+))?\s*(?:min|mins|minutes)\b/i.exec(text);
  if (secs) {
    const seconds = Math.min(Number(secs[1]), 7200);
    if (seconds < 1) return "a time of 0";
    const target: SetTarget =
      measure === "hold"
        ? { kind: "hold", seconds: Math.min(seconds, 600) }
        : { kind: "time", seconds };
    return { sets: sets(target), ...extra(secs[0]) };
  }
  if (mins) {
    const seconds = Math.min(Number(mins[1]) * 60, 7200);
    return { sets: sets({ kind: "time", seconds }), ...extra(mins[0]) };
  }
  if (reps) {
    const count1 = Number(reps[1]);
    if (count1 < 1 || count1 > 999) return `${count1} reps is not a number of reps`;
    const top = reps[2] ? Number(reps[2]) : undefined;
    const target: SetTarget = {
      kind: "reps",
      reps: count1,
      ...(top && top > count1 && top <= 999 ? { repsMax: top } : {}),
    };
    return { sets: sets(target), ...(hold || text !== reps[0] ? extra(reps[0]) : {}) };
  }
  return `"${text.slice(0, 60)}" has no number of reps or seconds`;
}

/** "Name x rx (TEMPO) <link>" → the parts. */
function splitExercise(raw: string): { name: string; rx?: string; tempo?: string } {
  let s = raw.replace(/<\s*https?:\/\/[^>\s]+\s*>/gi, " ");
  let tempo: string | undefined;
  s = s.replace(/[\s,]*\(\s*([0-9xX]{4})\s*\)[\s,]*$/, (_m, t: string) => {
    tempo = t.toUpperCase();
    return " ";
  });
  s = s
    .replace(/\s+/g, " ")
    .replace(/[\s,]+$/, "")
    .trim();
  const sep = /\s+[x×]\s+/gi;
  for (let hit = sep.exec(s); hit; hit = sep.exec(s)) {
    if (/[a-z]/i.test(s.slice(0, hit.index))) {
      return {
        name: s.slice(0, hit.index).trim(),
        rx: s.slice(hit.index + hit[0].length).trim(),
        ...(tempo ? { tempo } : {}),
      };
    }
  }
  return { name: s, ...(tempo ? { tempo } : {}) };
}

const RE = {
  title: /^title\s*:\s*(.*)$/i,
  kind: /^kind\s*:\s*(.*)$/i,
  guidance: /^guidance\s*:\s*(.*)$/i,
  week: /^week\s*:?\s*(\d+)\s*(?::\s*(.*))?$/i,
  session: /^session\s*:\s*(.*)$/i,
  focus: /^focus\s*:\s*(.*)$/i,
  warmup: /^warm[\s-]?up\s*:?\s*(.*)$/i,
  block: /^block\s+([A-Za-z0-9]{1,4})\s*(?::\s*(.*))?$/i,
  loading: /^loading\s*:\s*(.*)$/i,
  item: /^([A-Z][0-9]{1,2}[a-z]?)\s*[:.]\s*(.*)$/,
  level: /^(?:level\s*|l)?([0-9])\s*[:.]\s*(.*)$/i,
  dash: /^[-•]\s+(.*)$/,
  coachNote: /^\*+\s*(.*)$/,
  memberNote: /^(?:tv|members?)\s*:\s*(.*)$/i,
};

/** Reads shorthand into a layout over `bank`, listing every line it could not use. */
export function readProgramText(text: string, bank: readonly BankExercise[]): ImportResult {
  const find = bankIndex(bank);
  const unread: UnreadLine[] = [];
  let title: string | null = null;
  let kind: ProgramKind | null = null;
  let guidance: string | null = null;
  const weeks: Layout["weeks"] = [];
  let week: Layout["weeks"][number] | null = null;
  let session: Session | null = null;
  let block: Block | null = null;
  let item: Item | null = null;
  let rounds = 1;
  let continueTo: ((more: string) => void) | null = null;

  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  const skip = (n: number, raw: string, reason: string): void => {
    unread.push({ line: n, text: raw.trim().slice(0, 300), reason });
  };
  /** Where a note goes: the item, else the block, else the session. */
  const notesHere = (): Note[] | null => {
    const owner: { notes?: Note[] } | null = item ?? block ?? session;
    if (!owner) return null;
    owner.notes = owner.notes ?? [];
    return owner.notes;
  };

  /** The prescriptions a level or item line names, or why it cannot. */
  const prescriptionsOf = (
    raw: string,
  ): { list: Prescription[]; joiner: "+" | "|" | null } | string => {
    const joiner = /\s\|\s/.test(raw) ? "|" : /\s\+\s/.test(raw) ? "+" : null;
    const parts = raw.split(/\s+[+|]\s+/).filter((p) => p.trim());
    const list: Prescription[] = [];
    for (const part of parts) {
      const { name, rx, tempo } = splitExercise(part);
      const exercise = find(name);
      if (!exercise) return `no exercise in the bank is called "${name.slice(0, 80)}"`;
      const target = readTarget(rx, exercise.measure, rounds);
      if (typeof target === "string") return `${exercise.name}: ${target}`;
      if (tempo && target.sets[0]?.kind === "reps") {
        for (const set of target.sets) if (set.kind === "reps") set.tempo = tempo;
      }
      list.push({
        exercise: exercise.id,
        sets: target.sets,
        ...(target.note ? { note: target.note } : {}),
      });
    }
    if (list.length > 3) return "more than three exercises in one line";
    return { list, joiner };
  };

  const needWeek = () => {
    if (!week) {
      week = { sessions: [] };
      weeks.push(week);
    }
    return week;
  };

  const readLine = (rawLine: string, index: number) => {
    const n = index + 1;
    if (!rawLine.trim()) {
      continueTo = null;
      return;
    }
    const indented = /^\s/.test(rawLine);
    const line = rawLine.trim();
    let m: RegExpExecArray | null;

    m = RE.coachNote.exec(line) ?? RE.memberNote.exec(line);
    if (m) {
      const note: Note = {
        text: (m[1] ?? "").trim().slice(0, 800),
        ...(RE.memberNote.test(line) ? { members: true } : {}),
      };
      if (!note.text) return;
      const target = notesHere();
      if (!target) return skip(n, rawLine, "a note before any session");
      if (target.length >= 10) return skip(n, rawLine, "more than ten notes in one place");
      target.push(note);
      return;
    }
    // An indented line under guidance or a warm-up's words continues them.
    if (indented && continueTo && !RE.level.test(line) && !RE.dash.test(line)) {
      (continueTo as (more: string) => void)(line);
      return;
    }
    m = RE.title.exec(line);
    if (m) {
      title = (m[1] ?? "").trim().slice(0, 200) || null;
      continueTo = null;
      return;
    }
    m = RE.kind.exec(line);
    if (m) {
      const said = norm(m[1] ?? "");
      continueTo = null;
      if (said === "class" || said === "client" || said === "course") {
        kind = said;
        return;
      }
      return skip(n, rawLine, "a kind is class, client or course");
    }
    m = RE.guidance.exec(line);
    if (m) {
      guidance = (m[1] ?? "").trim();
      continueTo = (more) => {
        guidance = `${guidance}\n${more}`;
      };
      return;
    }
    m = RE.week.exec(line);
    if (m) {
      week = { ...(m[2] ? { label: m[2].trim().slice(0, 60) } : {}), sessions: [] };
      weeks.push(week);
      session = block = item = null;
      return;
    }
    m = RE.session.exec(line);
    if (m) {
      const name = (m[1] ?? "").trim().slice(0, 60) || "Session";
      const w = needWeek();
      if (w.sessions.length >= 14) return skip(n, rawLine, "more than fourteen sessions in a week");
      const weekday = WEEKDAYS.findIndex((d) => norm(name).split(" ").includes(d));
      const used = new Set(w.sessions.map((s) => s.day));
      const day =
        weekday >= 0 ? weekday + 1 : ([1, 2, 3, 4, 5, 6, 7].find((d) => !used.has(d)) ?? 7);
      session = { name, day, blocks: [] };
      w.sessions.push(session);
      block = item = null;
      continueTo = null;
      return;
    }
    if (!session) return skip(n, rawLine, 'put a "Session: …" line first');
    const s = session as Session;
    m = RE.focus.exec(line);
    if (m) {
      s.focus = (m[1] ?? "").trim().slice(0, 200);
      return;
    }
    m = RE.warmup.exec(line);
    if (m) {
      s.warmup = { ...(m[1]?.trim() ? { text: m[1].trim().slice(0, 1200) } : {}) };
      block = item = null;
      continueTo = (more) => {
        const w = s.warmup ?? {};
        w.text = `${w.text ? `${w.text}\n` : ""}${more}`.slice(0, 1200);
        s.warmup = w;
      };
      return;
    }
    m = RE.dash.exec(line);
    if (m && !block && s.warmup) {
      const found = prescriptionsOf(m[1] ?? "");
      const w = s.warmup;
      if (typeof found === "string") {
        // A warm-up line the bank does not have stays as words in the warm-up.
        w.text = `${w.text ? `${w.text}\n` : ""}- ${m[1]}`.slice(0, 1200);
        return skip(n, rawLine, `kept as warm-up text: ${found}`);
      }
      w.exercises = [...(w.exercises ?? []), ...found.list].slice(0, 15);
      return;
    }
    m = RE.block.exec(line);
    if (m) {
      const label = (m[1] ?? "").toUpperCase();
      if (s.blocks.some((b) => b.label === label))
        return skip(n, rawLine, `block ${label} is there twice`);
      const about = (m[2] ?? "").trim();
      const count =
        /(\d+)\s*(?:-\s*\d+\s*)?rounds?/i.exec(about) ?? /rounds?\s*:?\s*(\d+)/i.exec(about);
      rounds = count ? Math.min(Math.max(Number(count[1]), 1), 12) : 1;
      block = {
        label,
        ...(count ? { rounds: Math.min(Number(count[1]), 50) } : {}),
        items: [],
        ...(about ? { notes: [{ text: about.slice(0, 800), members: true }] } : {}),
      };
      s.blocks.push(block);
      item = null;
      continueTo = null;
      return;
    }
    m = RE.loading.exec(line);
    if (m && block) {
      // How the rounds load: words for members on the block, continued by indented lines.
      block.notes = block.notes ?? [];
      const notes = block.notes;
      const note: Note = { text: (m[1] ?? "").trim().slice(0, 800), members: true };
      if (notes.length >= 10) return skip(n, rawLine, "more than ten notes in one place");
      notes.push(note);
      continueTo = (more) => {
        note.text = `${note.text}\n${more}`.slice(0, 800);
      };
      return;
    }
    m = RE.item.exec(line);
    if (m) {
      if (!block) {
        block = { label: (m[1] ?? "A").charAt(0), items: [] };
        s.blocks.push(block);
      }
      const label = m[1] as string;
      if (block.items.some((i) => i.label === label))
        return skip(n, rawLine, `item ${label} is there twice`);
      const rest = (m[2] ?? "").trim();
      // An exercise on the line: for everyone. A name alone: its levels follow.
      const found = rest ? prescriptionsOf(rest) : "an item with nothing after its label";
      if (typeof found !== "string") {
        item = { kind: "all", label, exercises: found.list };
        block.items.push(item);
        return;
      }
      const looksLikeHead = rest && !/\s[x×]\s/i.test(rest);
      if (looksLikeHead || !rest) {
        item = {
          kind: "levels",
          label,
          levels: [],
          ...(rest ? { notes: [{ text: rest.slice(0, 800), members: true }] } : {}),
        };
        block.items.push(item);
        return;
      }
      item = null;
      return skip(n, rawLine, found);
    }
    m = RE.level.exec(line);
    if (m && item?.kind === "all" && block) {
      // Levels under an item that names an exercise: that exercise is everyone's, beside them.
      const at = block.items.indexOf(item);
      const both: Item = {
        kind: "levels",
        label: item.label,
        exercises: item.exercises,
        levels: [],
        ...(item.notes ? { notes: item.notes } : {}),
      };
      block.items[at] = both;
      item = both;
    }
    if (m && item?.kind === "levels") {
      const number = Number(m[1]);
      if (number < 1 || number > 5) return skip(n, rawLine, "a level is 1 to 5");
      if (item.levels.some((l) => l.level === number))
        return skip(n, rawLine, `level ${number} is there twice`);
      const found = prescriptionsOf(m[2] ?? "");
      if (typeof found === "string") return skip(n, rawLine, found);
      const level: Level =
        found.list.length === 1
          ? { mode: "one", level: number, exercise: found.list[0] as Prescription }
          : {
              mode: found.joiner === "|" ? "alternatives" : "together",
              level: number,
              exercises: found.list,
            };
      item.levels.push(level);
      item.levels.sort((a, b) => a.level - b.level);
      return;
    }
    if (indented && continueTo) {
      (continueTo as (more: string) => void)(line);
      return;
    }
    skip(n, rawLine, "not a line the import knows");
  };
  for (const [index, rawLine] of lines.entries()) readLine(rawLine, index);

  // An item whose levels all failed, or a block left empty, cannot be in the layout: say so.
  // One with exercises for everyone keeps them, as an item for everyone.
  for (const w of weeks) {
    for (const s of w.sessions) {
      for (const b of s.blocks) {
        b.items = b.items.map((i) =>
          i.kind === "levels" && !i.levels.length && i.exercises?.length
            ? {
                kind: "all",
                label: i.label,
                exercises: i.exercises,
                ...(i.notes ? { notes: i.notes } : {}),
              }
            : i,
        );
        const kept = b.items.filter((i) => i.kind === "all" || i.levels.length > 0);
        for (const dropped of b.items.filter((i) => !kept.includes(i))) {
          unread.push({
            line: 0,
            text: `${s.name} › ${dropped.label}`,
            reason: "no level of this item could be read",
          });
        }
        b.items = kept;
      }
      const blocks = s.blocks.filter((b) => b.items.length > 0);
      for (const dropped of s.blocks.filter((b) => !blocks.includes(b))) {
        unread.push({
          line: 0,
          text: `${s.name} › block ${dropped.label}`,
          reason: "no item of this block could be read",
        });
      }
      s.blocks = blocks;
    }
  }
  if (!weeks.length) weeks.push({ sessions: [] });
  unread.sort((a, b) => a.line - b.line);
  return {
    title,
    kind,
    guidance: guidance ? (guidance as string).slice(0, 5000) : null,
    layout: { weeks },
    unread,
  };
}

// --- A draft from a brief --------------------------------------------------------------------------

export interface DraftPlan {
  weeks: number;
  sessionsPerWeek: number;
  /** Words the brief is about (themes, body areas, moves): what picks exercises from the bank. */
  focus: string[];
}

/** A brief's numbers and words, read without a model: the fallback and the floor for one. */
export function readBrief(brief: string): DraftPlan {
  const weeks = /(\d+)\s*-?\s*weeks?/i.exec(brief);
  const perWeek =
    /(\d+)\s*(?:sessions?|days?|x)\s*(?:a|per|\/)\s*week/i.exec(brief) ??
    /(\d+)\s*(?:sessions?|days?)\b/i.exec(brief);
  const focus = norm(brief)
    .split(" ")
    .filter((word) => word.length > 3 && !/^\d+$/.test(word) && !STOP.has(word));
  return {
    weeks: clamp(weeks ? Number(weeks[1]) : 4, 1, 52),
    sessionsPerWeek: clamp(perWeek ? Number(perWeek[1]) : 3, 1, 7),
    focus: [...new Set(focus)],
  };
}

const STOP = new Set([
  "week",
  "weeks",
  "session",
  "sessions",
  "with",
  "that",
  "this",
  "from",
  "into",
  "program",
  "programme",
  "client",
  "class",
  "days",
  "each",
  "some",
  "focus",
  "build",
  "make",
  "about",
  "they",
  "their",
  "them",
  "work",
  "working",
]);

const clamp = (n: number, low: number, high: number) =>
  Math.min(Math.max(Math.round(n), low), high);

/** The bank's exercises the brief is about, best first; the whole bank when none matches. */
export function pickExercises(
  bank: readonly BankExercise[],
  focus: readonly string[],
): BankExercise[] {
  const score = (e: BankExercise) => {
    const words = new Set(norm(`${e.name} ${e.theme ?? ""} ${e.level ?? ""}`).split(" "));
    return focus.filter(
      (f) => words.has(f) || [...words].some((w) => w.startsWith(f) || f.startsWith(w)),
    ).length;
  };
  const scored = bank.map((e) => ({ e, s: score(e) })).filter((x) => x.s > 0);
  scored.sort((a, b) => b.s - a.s || a.e.name.localeCompare(b.e.name));
  return scored.length ? scored.map((x) => x.e) : [...bank];
}

/** A sensible default target for an exercise of `measure`: 3 sets. */
function defaultSets(measure: string | null | undefined): SetTarget[] {
  const one: SetTarget =
    measure === "time"
      ? { kind: "time", seconds: 30, rest: 60 }
      : measure === "hold"
        ? { kind: "hold", seconds: 20, rest: 60 }
        : { kind: "reps", reps: 8, rest: 90 };
  return [one, { ...one }, { ...one }];
}

/**
 * A draft layout: `weeks` weeks of `sessionsPerWeek` sessions on spread-out days, each two blocks
 * of exercises taken in turn from `chosen` (bank exercises only), with three sets each, the same
 * every week: a coach's starting point, not a finished program.
 */
export function draftLayout(plan: DraftPlan, chosen: readonly BankExercise[]): Layout {
  const days = [
    [1],
    [1, 4],
    [1, 3, 5],
    [1, 2, 4, 5],
    [1, 2, 3, 4, 5],
    [1, 2, 3, 4, 5, 6],
    [1, 2, 3, 4, 5, 6, 7],
  ][plan.sessionsPerWeek - 1] as number[];
  const pool = chosen.length ? chosen : [];
  let next = 0;
  const take = () => {
    const e = pool[next % pool.length] as BankExercise;
    next += 1;
    return { exercise: e.id, sets: defaultSets(e.measure) } satisfies Prescription;
  };
  const sessionsOfWeek: Session[] = days.map((day, s) => ({
    name: `Session ${String.fromCharCode(65 + s)}`,
    day,
    blocks: pool.length
      ? ["A", "B"].map((label) => ({
          label,
          rounds: 3,
          items: [1, 2].map((k) => ({
            kind: "all" as const,
            label: `${label}${k}`,
            exercises: [take()],
          })),
        }))
      : [],
  }));
  return {
    weeks: Array.from({ length: plan.weeks }, (_, w) => ({
      label: `Week ${w + 1}`,
      sessions: JSON.parse(JSON.stringify(sessionsOfWeek)) as Session[],
    })),
  };
}
