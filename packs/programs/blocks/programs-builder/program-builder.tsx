// The coach's program builder (stage 41): weeks, sessions, blocks and items, by drag and by
// keyboard; exercises picked from the bank; typed sets; levels; notes, for coaches or shown to
// members; copying a week or a session; the working copy saved as the coach goes, with the host's
// faults shown where they are; versions, restoring one, publishing, and assigning.
//
// Built on the web base layer. It holds no rules: what a layout may hold is the host's schema
// (a refused save shows the host's words at the part it names), who may publish is the host's
// (the button is offered from what `user.me` says, and the host decides), and assigning makes
// its dates in the host. Editing is `layoutEdits` from the pack's client.
import {
  type At,
  describeSets,
  exercisesIn,
  faultsUnder,
  type Item,
  type Layout,
  type Level,
  layoutEdits,
  layoutSummary,
  levelExercises,
  levelLabel,
  type Note,
  numberFrom,
  type Prescription,
  type ProgramsHooks,
  pathOf,
  type RecordOut,
  type SetTarget,
} from "@composable-os/pack-programs/client";
import { type KeyboardEvent, type ReactNode, useState } from "react";
import { Button } from "../ui-button/button.tsx";
import { Card, CardContent, CardHeader, CardTitle } from "../ui-card/card.tsx";
import { Input } from "../ui-input/input.tsx";
import { Label } from "../ui-label/label.tsx";

const DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

/** The hooks the builder calls. */
type BuilderHooks = Pick<
  ProgramsHooks,
  | "useAssign"
  | "useBank"
  | "useClassTypes"
  | "useCreateProgram"
  | "useDraft"
  | "useExercises"
  | "useImportText"
  | "usePeople"
  | "usePrograms"
  | "usePublish"
  | "usePublishOffered"
  | "useRestoreVersion"
  | "useVersions"
  | "useWorkingCopy"
>;

interface Bank {
  byId: Map<string, RecordOut>;
  list: RecordOut[];
  /** The hooks, for a search of the whole bank on the host. */
  programs: BuilderHooks;
}

type Change = (next: Layout) => void;

const nameOf = (bank: Bank, id: string) =>
  String(bank.byId.get(id)?.values.name ?? "Unknown exercise");
const measureOf = (bank: Bank, id: string) =>
  (bank.byId.get(id)?.values.measure as string | undefined) ?? null;

/**
 * The builder as the product's admin shows it (stage 47): the list of programs, and the one
 * opened from it, with a way back. The admin passes it nothing but the hooks.
 */
export function ProgramWorkspace({
  programs,
}: {
  programs: Parameters<typeof ProgramBuilder>[0]["programs"];
}) {
  const [open, setOpen] = useState<string | null>(null);
  if (!open) return <ProgramList programs={programs} onOpen={setOpen} />;
  return (
    <div className="grid gap-4">
      <Button type="button" variant="outline" className="w-fit" onClick={() => setOpen(null)}>
        All programs
      </Button>
      <ProgramBuilder key={open} programs={programs} programId={open} />
    </div>
  );
}

/** The whole builder for one program. */
export function ProgramBuilder({
  programs,
  programId,
}: {
  programs: BuilderHooks;
  programId: string;
}) {
  const copy = programs.useWorkingCopy(programId);
  const bankQuery = programs.useBank();
  // The program's own exercises by id, so a bank larger than one page still names them.
  const ownQuery = programs.useExercises(copy.layout ? exercisesIn(copy.layout) : []);
  const [week, setWeek] = useState(0);
  if (copy.isPending || bankQuery.isPending) return <p aria-busy="true">Loading the program…</p>;
  if (copy.error || !copy.layout) return <p role="alert">We could not load this program.</p>;
  const list = bankQuery.data?.items ?? [];
  const byId = new Map([...list, ...(ownQuery.data?.items ?? [])].map((e) => [e.id, e]));
  const bank: Bank = { list, byId, programs };
  const layout = copy.layout;
  const current = Math.min(week, layout.weeks.length - 1);
  const summary = layoutSummary(layout);
  const missing = ownQuery.isPending ? [] : exercisesIn(layout).filter((id) => !bank.byId.has(id));

  return (
    <div className="grid gap-6" data-testid="program-builder">
      <header className="grid gap-2">
        <Label htmlFor="program-title">Title</Label>
        <Input
          id="program-title"
          value={copy.title}
          onChange={(e) => copy.rename(e.target.value)}
          className="text-lg font-semibold"
        />
        <div className="flex flex-wrap items-center gap-3 text-sm text-muted-foreground">
          <span>
            {summary.weeks} weeks · {summary.sessions} sessions · {summary.items} items
          </span>
          <SaveStatus state={copy.state} />
          <Button size="sm" variant="outline" onClick={() => void copy.saveNow()}>
            Save now
          </Button>
        </div>
        {copy.state === "refused" && copy.message ? (
          <p role="alert" className="text-sm text-destructive" data-testid="save-refused">
            Not saved: {copy.message}
          </p>
        ) : null}
        {missing.length ? (
          <p className="text-sm text-destructive">
            {missing.length} exercise(s) in this layout are no longer in the bank.
          </p>
        ) : null}
      </header>

      <WeekTabs
        layout={layout}
        current={current}
        onSelect={setWeek}
        change={copy.change}
        faults={copy.faults}
      />

      <WeekView
        layout={layout}
        week={current}
        bank={bank}
        change={copy.change}
        faults={copy.faults}
      />

      <div className="grid gap-4 md:grid-cols-2">
        <Versions
          programs={programs}
          programId={programId}
          onRestored={(l, t) => copy.reset(l, t)}
        />
        <Assign programs={programs} programId={programId} />
      </div>
    </div>
  );
}

function SaveStatus({ state }: { state: string }) {
  const text =
    state === "saving"
      ? "Saving…"
      : state === "unsaved"
        ? "Unsaved changes"
        : state === "refused"
          ? "Not saved"
          : "Saved";
  return (
    <span aria-live="polite" data-testid="save-status" data-state={state}>
      {text}
    </span>
  );
}

function Faults({ faults, path }: { faults: ReadonlyMap<string, string>; path: string }) {
  const here = faultsUnder(faults, path);
  if (!here.length) return null;
  return (
    <ul role="alert" className="grid gap-1 text-sm text-destructive" data-testid="fault">
      {here.map((m) => (
        <li key={m}>{m}</li>
      ))}
    </ul>
  );
}

// --- Weeks ---------------------------------------------------------------------------------------

function WeekTabs({
  layout,
  current,
  onSelect,
  change,
  faults,
}: {
  layout: Layout;
  current: number;
  onSelect: (week: number) => void;
  change: Change;
  faults: ReadonlyMap<string, string>;
}) {
  const onKey = (event: KeyboardEvent) => {
    if (event.key === "ArrowRight") onSelect(Math.min(current + 1, layout.weeks.length - 1));
    if (event.key === "ArrowLeft") onSelect(Math.max(current - 1, 0));
  };
  return (
    <nav className="grid gap-2" aria-label="Weeks">
      <div role="tablist" className="flex flex-wrap gap-1" onKeyDown={onKey}>
        {layout.weeks.map((w, i) => (
          <Button
            // biome-ignore lint/suspicious/noArrayIndexKey: weeks are positions.
            key={i}
            role="tab"
            aria-selected={i === current}
            size="sm"
            variant={
              i === current
                ? "default"
                : faultsUnder(faults, `weeks.${i}`).length
                  ? "destructive"
                  : "outline"
            }
            onClick={() => onSelect(i)}
          >
            {w.label || `Week ${i + 1}`}
          </Button>
        ))}
      </div>
      <div className="flex flex-wrap gap-2">
        <Button
          size="sm"
          variant="outline"
          onClick={() => {
            change(layoutEdits.addWeek(layout));
            onSelect(layout.weeks.length);
          }}
        >
          Add week
        </Button>
        <Button
          size="sm"
          variant="outline"
          onClick={() => {
            change(layoutEdits.copyWeek(layout, current));
            onSelect(current + 1);
          }}
        >
          Copy this week
        </Button>
        <Button
          size="sm"
          variant="ghost"
          disabled={layout.weeks.length < 2}
          onClick={() => {
            change(layoutEdits.removeWeek(layout, current));
            onSelect(Math.max(0, current - 1));
          }}
        >
          Remove this week
        </Button>
        <Input
          aria-label="Week name"
          placeholder={`Week ${current + 1}`}
          value={layout.weeks[current]?.label ?? ""}
          onChange={(e) => change(layoutEdits.setWeekLabel(layout, current, e.target.value))}
          className="h-8 w-48"
        />
      </div>
    </nav>
  );
}

function WeekView({
  layout,
  week,
  bank,
  change,
  faults,
}: {
  layout: Layout;
  week: number;
  bank: Bank;
  change: Change;
  faults: ReadonlyMap<string, string>;
}) {
  const sessions = layout.weeks[week]?.sessions ?? [];
  return (
    <section className="grid gap-4" aria-label={`Week ${week + 1}`}>
      <Faults
        faults={new Map([...faults].filter(([p]) => p === `weeks.${week}.sessions`))}
        path={`weeks.${week}.sessions`}
      />
      {sessions.map((session, s) => (
        <SessionCard
          // biome-ignore lint/suspicious/noArrayIndexKey: sessions are positions in their week.
          key={s}
          layout={layout}
          at={{ week, session: s }}
          bank={bank}
          change={change}
          faults={faults}
          last={s === sessions.length - 1}
          title={session.name}
        />
      ))}
      <div>
        <Button variant="outline" onClick={() => change(layoutEdits.addSession(layout, week))}>
          Add session
        </Button>
      </div>
    </section>
  );
}

// --- Sessions ------------------------------------------------------------------------------------

function SessionCard({
  layout,
  at,
  bank,
  change,
  faults,
  last,
  title,
}: {
  layout: Layout;
  at: At;
  bank: Bank;
  change: Change;
  faults: ReadonlyMap<string, string>;
  last: boolean;
  title: string;
}) {
  const session = layout.weeks[at.week]?.sessions[at.session ?? 0];
  const [dragging, setDragging] = useState<{ block: number; item: number } | null>(null);
  if (!session) return null;
  const path = pathOf(at);
  const later = layout.weeks.length - at.week - 1;
  return (
    <Card data-testid="session" aria-label={`Session ${title}`}>
      <CardHeader className="grid gap-2">
        <div className="flex flex-wrap items-end gap-2">
          <div className="grid gap-1">
            <Label>Session name</Label>
            <Input
              aria-label="Session name"
              value={session.name}
              onChange={(e) => change(layoutEdits.setSession(layout, at, { name: e.target.value }))}
            />
          </div>
          <div className="grid gap-1">
            <Label>Day</Label>
            <select
              aria-label="Day"
              className="h-9 rounded-md border px-2"
              value={session.day}
              onChange={(e) =>
                change(layoutEdits.setSession(layout, at, { day: Number(e.target.value) }))
              }
            >
              {DAYS.map((d, i) => (
                <option key={d} value={i + 1}>
                  {d}
                </option>
              ))}
            </select>
          </div>
          <div className="grid flex-1 gap-1">
            <Label>Focus</Label>
            <Input
              aria-label="Focus"
              value={session.focus ?? ""}
              onChange={(e) =>
                change(layoutEdits.setSession(layout, at, { focus: e.target.value }))
              }
            />
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button
            size="sm"
            variant="outline"
            onClick={() => change(layoutEdits.copySession(layout, at))}
          >
            Copy session
          </Button>
          <Button
            size="sm"
            variant="outline"
            disabled={later === 0}
            onClick={() => {
              let next = layout;
              for (let w = at.week + 1; w < layout.weeks.length; w += 1)
                next = layoutEdits.copySession(next, at, w);
              change(next);
            }}
          >
            Copy to the {later} following week(s)
          </Button>
          <Button
            size="sm"
            variant="ghost"
            disabled={at.session === 0}
            onClick={() =>
              change(
                layoutEdits.moveSession(layout, at.week, at.session ?? 0, (at.session ?? 0) - 1),
              )
            }
          >
            Move up
          </Button>
          <Button
            size="sm"
            variant="ghost"
            disabled={last}
            onClick={() =>
              change(
                layoutEdits.moveSession(layout, at.week, at.session ?? 0, (at.session ?? 0) + 1),
              )
            }
          >
            Move down
          </Button>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => change(layoutEdits.removeSession(layout, at))}
          >
            Remove session
          </Button>
        </div>
        <Faults
          faults={
            new Map([...faults].filter(([p]) => !p.includes(".blocks.") && p.startsWith(path)))
          }
          path={path}
        />
      </CardHeader>
      <CardContent className="grid gap-4">
        <div className="grid gap-1">
          <Label>Warm-up</Label>
          <textarea
            aria-label="Warm-up"
            className="min-h-16 rounded-md border p-2 text-sm"
            value={session.warmup?.text ?? ""}
            onChange={(e) => change(layoutEdits.setWarmup(layout, at, e.target.value))}
          />
        </div>
        {session.blocks.map((block, b) => {
          const blockAt = { ...at, block: b };
          return (
            <section
              // biome-ignore lint/suspicious/noArrayIndexKey: blocks are positions in their session.
              key={b}
              className="grid gap-3 rounded-md border p-3"
              aria-label={`Block ${block.label}`}
              data-testid="block"
              onDragOver={(e) => e.preventDefault()}
              onDrop={() => {
                if (dragging)
                  change(
                    layoutEdits.moveItem(
                      layout,
                      { ...at, ...dragging },
                      { block: b, item: block.items.length },
                    ),
                  );
                setDragging(null);
              }}
            >
              <div className="flex flex-wrap items-end gap-2">
                <div className="grid gap-1">
                  <Label>Block</Label>
                  <Input
                    aria-label="Block label"
                    className="w-20"
                    value={block.label}
                    onChange={(e) =>
                      change(layoutEdits.setBlock(layout, blockAt, { label: e.target.value }))
                    }
                  />
                </div>
                <div className="grid gap-1">
                  <Label>Rounds</Label>
                  <Input
                    aria-label="Rounds"
                    className="w-24"
                    inputMode="numeric"
                    value={block.rounds ?? ""}
                    onChange={(e) =>
                      change(
                        layoutEdits.setBlock(layout, blockAt, {
                          rounds: numberFrom(e.target.value) ?? null,
                        }),
                      )
                    }
                  />
                </div>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => change(layoutEdits.removeBlock(layout, blockAt))}
                >
                  Remove block
                </Button>
              </div>
              <Faults
                faults={
                  new Map(
                    [...faults].filter(
                      ([p]) => !p.includes(".items.") && p.startsWith(pathOf(blockAt)),
                    ),
                  )
                }
                path={pathOf(blockAt)}
              />
              <ol className="grid gap-3">
                {block.items.map((item, i) => (
                  <ItemEditor
                    // biome-ignore lint/suspicious/noArrayIndexKey: items are positions in their block.
                    key={i}
                    layout={layout}
                    at={{ ...blockAt, item: i }}
                    item={item}
                    bank={bank}
                    change={change}
                    faults={faults}
                    count={block.items.length}
                    onDragStart={() => setDragging({ block: b, item: i })}
                    onDrop={() => {
                      if (dragging)
                        change(
                          layoutEdits.moveItem(
                            layout,
                            { ...at, ...dragging },
                            { block: b, item: i },
                          ),
                        );
                      setDragging(null);
                    }}
                  />
                ))}
              </ol>
              <ExercisePicker
                bank={bank}
                label={`Add an item to block ${block.label}`}
                onPick={(id) =>
                  change(layoutEdits.addItem(layout, blockAt, id, measureOf(bank, id)))
                }
              />
              <NotesEditor
                notes={block.notes ?? []}
                onAdd={(text, members) =>
                  change(layoutEdits.addNote(layout, blockAt, text, members))
                }
                onChange={(index, note) =>
                  change(layoutEdits.setNote(layout, blockAt, index, note))
                }
              />
            </section>
          );
        })}
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" onClick={() => change(layoutEdits.addBlock(layout, at))}>
            Add block
          </Button>
        </div>
        <NotesEditor
          notes={session.notes ?? []}
          onAdd={(text, members) => change(layoutEdits.addNote(layout, at, text, members))}
          onChange={(index, note) => change(layoutEdits.setNote(layout, at, index, note))}
        />
      </CardContent>
    </Card>
  );
}

// --- Items ---------------------------------------------------------------------------------------

function ItemEditor({
  layout,
  at,
  item,
  bank,
  change,
  faults,
  count,
  onDragStart,
  onDrop,
}: {
  layout: Layout;
  at: At;
  item: Item;
  bank: Bank;
  change: Change;
  faults: ReadonlyMap<string, string>;
  count: number;
  onDragStart: () => void;
  onDrop: () => void;
}) {
  const index = at.item ?? 0;
  const moveTo = (to: number) =>
    change(layoutEdits.moveItem(layout, at, { block: at.block ?? 0, item: to }));
  const onKey = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (!event.altKey) return;
    if (event.key === "ArrowUp" && index > 0) {
      event.preventDefault();
      moveTo(index - 1);
    }
    if (event.key === "ArrowDown" && index < count - 1) {
      event.preventDefault();
      moveTo(index + 1);
    }
  };
  return (
    <li
      draggable
      onDragStart={(e) => {
        e.stopPropagation();
        onDragStart();
      }}
      onDragOver={(e) => e.preventDefault()}
      onDrop={(e) => {
        e.stopPropagation();
        onDrop();
      }}
      className="grid gap-2 rounded-md bg-muted/40 p-3"
      data-testid="item"
      data-label={item.label}
    >
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          onKeyDown={onKey}
          className="cursor-grab select-none rounded px-1 text-muted-foreground focus-visible:ring-2"
          aria-label={`Move item ${item.label}: drag it, or Alt and the arrow keys`}
        >
          ⠿
        </button>
        <Input
          aria-label="Item label"
          className="h-8 w-20"
          value={item.label}
          onChange={(e) => change(layoutEdits.setItemLabel(layout, at, e.target.value))}
        />
        <select
          aria-label="For"
          className="h-8 rounded-md border px-2 text-sm"
          value={item.kind}
          onChange={(e) =>
            change(layoutEdits.setItemKind(layout, at, e.target.value as Item["kind"]))
          }
        >
          <option value="all">For everyone</option>
          <option value="levels">With levels</option>
        </select>
        <Button size="xs" variant="ghost" disabled={index === 0} onClick={() => moveTo(index - 1)}>
          Up
        </Button>
        <Button
          size="xs"
          variant="ghost"
          disabled={index === count - 1}
          onClick={() => moveTo(index + 1)}
        >
          Down
        </Button>
        <Button
          size="xs"
          variant="ghost"
          onClick={() => change(layoutEdits.removeItem(layout, at))}
        >
          Remove
        </Button>
      </div>
      <Faults faults={faults} path={pathOf(at)} />
      {item.kind === "all" ? (
        <div className="grid gap-2">
          {item.exercises.map((p, e) => (
            <PrescriptionEditor
              // biome-ignore lint/suspicious/noArrayIndexKey: exercises are positions in their item.
              key={e}
              layout={layout}
              at={{ ...at, exercise: e }}
              prescription={p}
              bank={bank}
              change={change}
              removable={item.exercises.length > 1}
            />
          ))}
          <ExercisePicker
            bank={bank}
            label="Add an exercise done together"
            compact
            onPick={(id) => change(layoutEdits.addExercise(layout, at, id, measureOf(bank, id)))}
          />
        </div>
      ) : (
        <>
          <div className="grid gap-2" data-testid="everyone">
            {(item.exercises ?? []).map((p, e) => (
              <PrescriptionEditor
                // biome-ignore lint/suspicious/noArrayIndexKey: exercises are positions in their item.
                key={e}
                layout={layout}
                at={{ ...at, everyone: true, exercise: e }}
                prescription={p}
                bank={bank}
                change={change}
                removable
              />
            ))}
            <ExercisePicker
              bank={bank}
              label="Add an exercise for everyone, beside the levels"
              compact
              onPick={(id) =>
                change(
                  layoutEdits.addExercise(
                    layout,
                    { ...at, everyone: true },
                    id,
                    measureOf(bank, id),
                  ),
                )
              }
            />
          </div>
          <LevelsEditor layout={layout} at={at} levels={item.levels} bank={bank} change={change} />
        </>
      )}
      <NotesEditor
        notes={item.notes ?? []}
        onAdd={(text, members) => change(layoutEdits.addNote(layout, at, text, members))}
        onChange={(i, note) => change(layoutEdits.setNote(layout, at, i, note))}
      />
    </li>
  );
}

function LevelsEditor({
  layout,
  at,
  levels,
  bank,
  change,
}: {
  layout: Layout;
  at: At;
  levels: Level[];
  bank: Bank;
  change: Change;
}) {
  const used = new Set(levels.map((l) => l.level));
  return (
    <div className="grid gap-3">
      {levels.map((level, l) => {
        const levelAt = { ...at, level: l };
        const exercises = levelExercises(level);
        return (
          <div
            // biome-ignore lint/suspicious/noArrayIndexKey: levels are positions in their item.
            key={l}
            className="grid gap-2 border-l-2 pl-3"
            data-testid="level"
            data-level={level.level}
            title={levelLabel(level)}
          >
            <div className="flex flex-wrap items-center gap-2">
              <select
                aria-label="Level"
                className="h-8 rounded-md border px-2 text-sm"
                value={level.level}
                onChange={(e) =>
                  change(layoutEdits.setLevelNumber(layout, levelAt, Number(e.target.value)))
                }
              >
                {[1, 2, 3, 4, 5].map((n) => (
                  <option key={n} value={n} disabled={n !== level.level && used.has(n)}>
                    Level {n}
                  </option>
                ))}
              </select>
              <select
                aria-label="Done as"
                className="h-8 rounded-md border px-2 text-sm"
                value={level.mode}
                onChange={(e) =>
                  change(layoutEdits.setLevelMode(layout, levelAt, e.target.value as Level["mode"]))
                }
              >
                <option value="one">One exercise</option>
                <option value="together" disabled={exercises.length < 2}>
                  Together
                </option>
                <option value="alternatives" disabled={exercises.length < 2}>
                  One of these
                </option>
              </select>
              <Button
                size="xs"
                variant="ghost"
                onClick={() => change(layoutEdits.removeLevel(layout, levelAt))}
              >
                Remove level
              </Button>
            </div>
            {exercises.map((p, e) => (
              <PrescriptionEditor
                // biome-ignore lint/suspicious/noArrayIndexKey: exercises are positions in their level.
                key={e}
                layout={layout}
                at={{ ...levelAt, exercise: e }}
                prescription={p}
                bank={bank}
                change={change}
                removable={exercises.length > 1}
              />
            ))}
            <ExercisePicker
              bank={bank}
              compact
              label={`Add another exercise to level ${level.level}`}
              onPick={(id) =>
                change(layoutEdits.addExercise(layout, levelAt, id, measureOf(bank, id)))
              }
            />
          </div>
        );
      })}
      {levels.length < 5 ? (
        <ExercisePicker
          bank={bank}
          label="Add a level"
          onPick={(id) => change(layoutEdits.addLevel(layout, at, id, measureOf(bank, id)))}
        />
      ) : null}
    </div>
  );
}

function PrescriptionEditor({
  layout,
  at,
  prescription,
  bank,
  change,
  removable,
}: {
  layout: Layout;
  at: At;
  prescription: Prescription;
  bank: Bank;
  change: Change;
  removable: boolean;
}) {
  const [swapping, setSwapping] = useState(false);
  return (
    <div className="grid gap-2 rounded-md border bg-background p-2" data-testid="prescription">
      <div className="flex flex-wrap items-center gap-2">
        <strong className="text-sm">{nameOf(bank, prescription.exercise)}</strong>
        <span className="text-xs text-muted-foreground">{describeSets(prescription.sets)}</span>
        <Button size="xs" variant="ghost" onClick={() => setSwapping(!swapping)}>
          Swap
        </Button>
        {removable ? (
          <Button
            size="xs"
            variant="ghost"
            onClick={() => change(layoutEdits.removeExercise(layout, at))}
          >
            Remove
          </Button>
        ) : null}
      </div>
      {swapping ? (
        <ExercisePicker
          bank={bank}
          compact
          label="Swap for"
          onPick={(id) => {
            change(layoutEdits.swapExercise(layout, at, id));
            setSwapping(false);
          }}
        />
      ) : null}
      <SetsEditor layout={layout} at={at} sets={prescription.sets} change={change} />
      <Input
        aria-label="Coach's words beside the numbers"
        placeholder="In your words: legs as straight as possible"
        value={prescription.note ?? ""}
        onChange={(e) => change(layoutEdits.setPrescriptionNote(layout, at, e.target.value))}
        className="h-8 text-sm"
      />
    </div>
  );
}

function SetsEditor({
  layout,
  at,
  sets,
  change,
}: {
  layout: Layout;
  at: At;
  sets: SetTarget[];
  change: Change;
}) {
  const field = (set: number, key: string, value: string) =>
    change(
      layoutEdits.setSet(layout, { ...at, set }, {
        [key]: key === "tempo" ? value.toUpperCase() : numberFrom(value),
      } as Partial<SetTarget>),
    );
  return (
    <table className="text-sm" data-testid="sets">
      <thead className="text-xs text-muted-foreground">
        <tr>
          <th className="text-left font-normal">Set</th>
          <th className="text-left font-normal">Kind</th>
          <th className="text-left font-normal">Reps / seconds</th>
          <th className="text-left font-normal">Load (kg)</th>
          <th className="text-left font-normal">Tempo</th>
          <th className="text-left font-normal">Rest (s)</th>
          <th />
        </tr>
      </thead>
      <tbody>
        {sets.map((set, s) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: sets are positions.
          <tr key={s}>
            <td className="pr-2">{s + 1}</td>
            <td className="pr-2">
              <select
                aria-label={`Set ${s + 1} kind`}
                className="h-8 rounded-md border px-1"
                value={set.kind}
                onChange={(e) =>
                  change(
                    layoutEdits.setSet(
                      layout,
                      { ...at, set: s },
                      { kind: e.target.value as SetTarget["kind"] },
                    ),
                  )
                }
              >
                <option value="reps">Reps</option>
                <option value="time">Time</option>
                <option value="hold">Hold</option>
              </select>
            </td>
            <td className="pr-2">
              {set.kind === "reps" ? (
                <span className="flex items-center gap-1">
                  <Input
                    aria-label={`Set ${s + 1} reps`}
                    className="h-8 w-14"
                    inputMode="numeric"
                    value={set.reps}
                    onChange={(e) => field(s, "reps", e.target.value)}
                  />
                  to
                  <Input
                    aria-label={`Set ${s + 1} up to reps`}
                    className="h-8 w-14"
                    inputMode="numeric"
                    value={set.repsMax ?? ""}
                    onChange={(e) => field(s, "repsMax", e.target.value)}
                  />
                </span>
              ) : (
                <span className="flex items-center gap-1">
                  <Input
                    aria-label={`Set ${s + 1} seconds`}
                    className="h-8 w-16"
                    inputMode="numeric"
                    value={set.seconds}
                    onChange={(e) => field(s, "seconds", e.target.value)}
                  />
                  {set.kind === "hold" ? (
                    <>
                      ×
                      <Input
                        aria-label={`Set ${s + 1} holds`}
                        className="h-8 w-12"
                        inputMode="numeric"
                        value={set.holds ?? ""}
                        onChange={(e) => field(s, "holds", e.target.value)}
                      />
                    </>
                  ) : null}
                </span>
              )}
            </td>
            <td className="pr-2">
              <Input
                aria-label={`Set ${s + 1} load`}
                className="h-8 w-16"
                inputMode="decimal"
                value={set.load ?? ""}
                onChange={(e) => field(s, "load", e.target.value)}
              />
            </td>
            <td className="pr-2">
              {set.kind === "reps" ? (
                <Input
                  aria-label={`Set ${s + 1} tempo`}
                  className="h-8 w-16"
                  maxLength={4}
                  value={set.tempo ?? ""}
                  onChange={(e) => field(s, "tempo", e.target.value)}
                />
              ) : null}
            </td>
            <td className="pr-2">
              <Input
                aria-label={`Set ${s + 1} rest`}
                className="h-8 w-16"
                inputMode="numeric"
                value={set.rest ?? ""}
                onChange={(e) => field(s, "rest", e.target.value)}
              />
            </td>
            <td>
              <Button
                size="xs"
                variant="ghost"
                aria-label={`Remove set ${s + 1}`}
                onClick={() => change(layoutEdits.removeSet(layout, { ...at, set: s }))}
              >
                ×
              </Button>
            </td>
          </tr>
        ))}
        <tr>
          <td colSpan={7}>
            <Button
              size="xs"
              variant="outline"
              onClick={() => change(layoutEdits.addSet(layout, at))}
            >
              Add set
            </Button>
          </td>
        </tr>
      </tbody>
    </table>
  );
}

// --- Picking from the bank, notes --------------------------------------------------------------------

/** A search over the bank: type, then pick with a click, or Enter for the first match. */
export function ExercisePicker({
  bank,
  label,
  onPick,
  compact,
}: {
  bank: Bank;
  label: string;
  onPick: (exerciseId: string) => void;
  compact?: boolean;
}) {
  const [search, setSearch] = useState("");
  const words = search.trim().toLowerCase();
  // The host searches the whole bank; until it answers, the page already loaded is searched.
  const found = bank.programs.useBank(words);
  const matches = words
    ? (
        found.data?.items ??
        bank.list.filter((e) =>
          String(e.values.name ?? "")
            .toLowerCase()
            .includes(words),
        )
      ).slice(0, 8)
    : [];
  const pick = (id: string) => {
    onPick(id);
    setSearch("");
  };
  return (
    <div className="grid gap-1">
      <Input
        aria-label={label}
        placeholder={`${label}: search the bank`}
        className={compact ? "h-8 text-sm" : ""}
        value={search}
        onChange={(e) => setSearch(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && matches[0]) {
            e.preventDefault();
            pick(matches[0].id);
          }
          if (e.key === "Escape") setSearch("");
        }}
      />
      {matches.length ? (
        <ul className="flex flex-wrap gap-1" aria-label="Matching exercises">
          {matches.map((e) => (
            <li key={e.id}>
              <Button size="xs" variant="secondary" onClick={() => pick(e.id)}>
                {String(e.values.name)}
              </Button>
            </li>
          ))}
        </ul>
      ) : words ? (
        <p className="text-xs text-muted-foreground">
          No exercise in the bank matches. Add it to the bank first.
        </p>
      ) : null}
    </div>
  );
}

function NotesEditor({
  notes,
  onAdd,
  onChange,
}: {
  notes: Note[];
  onAdd: (text: string, members: boolean) => void;
  onChange: (index: number, note: Note | null) => void;
}) {
  const [text, setText] = useState("");
  const [members, setMembers] = useState(false);
  return (
    <div className="grid gap-1 text-sm">
      {notes.map((note, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: notes are positions.
        <div key={i} className="flex items-center gap-2" data-testid="note">
          <Input
            aria-label={`Note ${i + 1}`}
            className="h-8 flex-1 text-sm"
            value={note.text}
            onChange={(e) => onChange(i, { ...note, text: e.target.value })}
          />
          <label className="flex items-center gap-1 text-xs">
            <input
              type="checkbox"
              checked={Boolean(note.members)}
              onChange={(e) => onChange(i, { ...note, members: e.target.checked })}
            />
            Shown to members
          </label>
          <Button size="xs" variant="ghost" onClick={() => onChange(i, null)}>
            ×
          </Button>
        </div>
      ))}
      <div className="flex items-center gap-2">
        <Input
          aria-label="New note"
          placeholder="A note (for coaches unless shown to members)"
          className="h-8 flex-1 text-sm"
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && text.trim()) {
              onAdd(text.trim(), members);
              setText("");
            }
          }}
        />
        <label className="flex items-center gap-1 text-xs">
          <input type="checkbox" checked={members} onChange={(e) => setMembers(e.target.checked)} />
          Shown to members
        </label>
        <Button
          size="xs"
          variant="outline"
          disabled={!text.trim()}
          onClick={() => {
            onAdd(text.trim(), members);
            setText("");
          }}
        >
          Add note
        </Button>
      </div>
    </div>
  );
}

// --- Versions, publishing and assigning ----------------------------------------------------------

function Versions({
  programs,
  programId,
  onRestored,
}: {
  programs: BuilderHooks;
  programId: string;
  onRestored: (layout: Layout, title?: string) => void;
}) {
  const versions = programs.useVersions(programId);
  const offered = programs.usePublishOffered();
  const publish = programs.usePublish();
  const restore = programs.useRestoreVersion();
  const [note, setNote] = useState("");
  const [said, setSaid] = useState<string | null>(null);
  return (
    <Card>
      <CardHeader>
        <CardTitle>Versions</CardTitle>
      </CardHeader>
      <CardContent className="grid gap-3">
        {offered ? (
          <div className="flex flex-wrap gap-2">
            <Input
              aria-label="What changed"
              placeholder="What changed (optional)"
              value={note}
              onChange={(e) => setNote(e.target.value)}
              className="h-9 flex-1"
            />
            <Button
              disabled={publish.isPending}
              onClick={async () => {
                try {
                  const out = await publish.mutateAsync({
                    object: "programs.program",
                    id: programId,
                    ...(note.trim() ? { note: note.trim() } : {}),
                  });
                  setSaid(`Published as version ${out.version}.`);
                  setNote("");
                  versions.refetch?.();
                } catch (error) {
                  setSaid((error as { message?: string }).message ?? "Not published.");
                }
              }}
            >
              Publish
            </Button>
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">
            A person who may publish programs publishes this working copy.
          </p>
        )}
        {said ? (
          <p aria-live="polite" className="text-sm" data-testid="publish-said">
            {said}
          </p>
        ) : null}
        <ul className="grid gap-1 text-sm" aria-label="Published versions">
          {(versions.data?.items ?? []).map((v) => (
            <li key={v.version} className="flex items-center gap-2">
              <span>
                Version {v.version}
                {v.current ? " (what people are given)" : ""} ·{" "}
                {new Date(v.publishedAt).toLocaleDateString()}
                {v.note ? ` · ${v.note}` : ""}
              </span>
              <Button
                size="xs"
                variant="ghost"
                disabled={restore.isPending}
                onClick={async () => {
                  const out = await restore.mutateAsync({
                    object: "programs.program",
                    id: programId,
                    version: v.version,
                  });
                  onRestored(
                    out.record.values.layout as Layout,
                    String(out.record.values.title ?? ""),
                  );
                  setSaid(
                    `Version ${v.version} restored into the working copy. Publish to give it to people.`,
                  );
                }}
              >
                Restore
              </Button>
            </li>
          ))}
          {versions.data && !versions.data.items.length ? <li>Not published yet.</li> : null}
        </ul>
      </CardContent>
    </Card>
  );
}

function Assign({ programs, programId }: { programs: BuilderHooks; programId: string }) {
  const [search, setSearch] = useState("");
  const [person, setPerson] = useState<{ id: string; name: string } | null>(null);
  const [classType, setClassType] = useState("");
  const [startDate, setStartDate] = useState("");
  const [said, setSaid] = useState<string | null>(null);
  const people = programs.usePeople(search);
  const classTypes = programs.useClassTypes();
  const assign = programs.useAssign();
  return (
    <Card>
      <CardHeader>
        <CardTitle>Assign</CardTitle>
      </CardHeader>
      <CardContent className="grid gap-3 text-sm">
        <div className="grid gap-1">
          <Label htmlFor="assign-person">A client</Label>
          <Input
            id="assign-person"
            placeholder="Search people"
            value={person ? person.name : search}
            onChange={(e) => {
              setPerson(null);
              setSearch(e.target.value);
            }}
          />
          {!person && people.data?.items.length ? (
            <ul className="flex flex-wrap gap-1">
              {people.data.items.map((p) => (
                <li key={p.id}>
                  <Button
                    size="xs"
                    variant="secondary"
                    onClick={() => {
                      setPerson({ id: p.id, name: p.displayName ?? p.id });
                      setClassType("");
                    }}
                  >
                    {p.displayName ?? p.id}
                  </Button>
                </li>
              ))}
            </ul>
          ) : null}
        </div>
        <div className="grid gap-1">
          <Label htmlFor="assign-class">Or a class type</Label>
          <select
            id="assign-class"
            className="h-9 rounded-md border px-2"
            value={classType}
            onChange={(e) => {
              setClassType(e.target.value);
              setPerson(null);
            }}
          >
            <option value="">None</option>
            {(classTypes.data?.items ?? []).map((c) => (
              <option key={c.id} value={c.id}>
                {String(c.values.name ?? c.id)}
              </option>
            ))}
          </select>
        </div>
        <div className="grid gap-1">
          <Label htmlFor="assign-start">Starts</Label>
          <Input
            id="assign-start"
            type="date"
            value={startDate}
            onChange={(e) => setStartDate(e.target.value)}
          />
        </div>
        <Button
          disabled={assign.isPending || !startDate || (!person && !classType)}
          onClick={async () => {
            try {
              const out = await assign.mutateAsync({
                programId,
                startDate,
                ...(person ? { personId: person.id } : { classTypeId: classType }),
              });
              setSaid(
                `Assigned version ${out.programVersion}: ${out.sessions} sessions from ${out.startDate} to ${out.endDate}.`,
              );
            } catch (error) {
              setSaid((error as { message?: string }).message ?? "Not assigned.");
            }
          }}
        >
          Assign the published version
        </Button>
        {said ? (
          <p aria-live="polite" data-testid="assign-said">
            {said}
          </p>
        ) : null}
      </CardContent>
    </Card>
  );
}

/** A list of programs with a button to open one, and to start one blank, drafted or imported. */
export function ProgramList({
  programs,
  onOpen,
}: {
  programs: BuilderHooks;
  onOpen: (programId: string) => void;
}): ReactNode {
  const list = programs.usePrograms();
  const create = programs.useCreateProgram();
  const draft = programs.useDraft();
  const importText = programs.useImportText();
  const [title, setTitle] = useState("");
  const [brief, setBrief] = useState("");
  const [text, setText] = useState("");
  const [unread, setUnread] = useState<{ line: number; text: string; reason: string }[]>([]);
  return (
    <div className="grid gap-4">
      <ul className="grid gap-2" aria-label="Programs">
        {(list.data?.items ?? []).map((p) => (
          <li key={p.id} className="flex items-center gap-2">
            <Button variant="link" onClick={() => onOpen(p.id)}>
              {String(p.values.title ?? p.id)}
            </Button>
            <span className="text-xs text-muted-foreground">
              {p.values.publishedVersion ? `version ${p.values.publishedVersion}` : "not published"}
            </span>
          </li>
        ))}
      </ul>
      <div className="flex flex-wrap gap-2">
        <Input
          aria-label="New program title"
          placeholder="New program title"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          className="max-w-xs"
        />
        <Button
          disabled={!title.trim() || create.isPending}
          onClick={async () => {
            const out = await create.mutateAsync({
              object: "programs.program",
              values: {
                title: title.trim(),
                kind: "client",
                layout: { weeks: [{ sessions: [] }] },
              },
            });
            setTitle("");
            onOpen(out.id);
          }}
        >
          Start a program
        </Button>
      </div>
      <div className="flex flex-wrap gap-2">
        <Input
          aria-label="Brief for a draft"
          placeholder="A brief: 12 weeks of handstands, 3 sessions a week"
          value={brief}
          onChange={(e) => setBrief(e.target.value)}
          className="max-w-md"
        />
        <Button
          variant="outline"
          disabled={brief.trim().length < 3 || draft.isPending}
          onClick={async () => onOpen((await draft.mutateAsync({ brief: brief.trim() })).programId)}
        >
          Draft from the bank
        </Button>
      </div>
      <div className="grid gap-2">
        <Label htmlFor="import-text">Paste a program</Label>
        <textarea
          id="import-text"
          className="min-h-32 rounded-md border p-2 font-mono text-xs"
          value={text}
          onChange={(e) => setText(e.target.value)}
        />
        <div>
          <Button
            variant="outline"
            disabled={!text.trim() || importText.isPending}
            onClick={async () => {
              const out = await importText.mutateAsync({ text });
              setUnread(out.unread);
              if (out.programId) onOpen(out.programId);
            }}
          >
            Import
          </Button>
        </div>
        {unread.length ? (
          <ul className="grid gap-1 text-sm" aria-label="Lines not read">
            {unread.map((u) => (
              <li key={`${u.line}-${u.text}`}>
                {u.line ? `Line ${u.line}: ` : ""}
                <code>{u.text}</code> ({u.reason})
              </li>
            ))}
          </ul>
        ) : null}
      </div>
    </div>
  );
}
