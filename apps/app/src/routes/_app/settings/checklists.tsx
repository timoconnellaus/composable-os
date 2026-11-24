// Settings → Checklists (stage 45 step 4b, ADR 0650): the business's checklists, lists of steps
// staff tick off on a duty (a close-down clean, opening up). Anyone on the staff reads them;
// writing needs checklists:write (admins, and anyone an admin grants it), which the host checks.
// A change applies to runs made from now on: shifts already given a run keep the steps they had.
// A checklist may also be done on its own (ADR 0651): due on set days of the week in the business's
// time zone, by a time, by whoever it names (everyone on staff, a role or a pack's fixed role, or
// a grant). Each due day then gets one run, on Today's checklists.
import { Badge } from "@composable-os/ui/components/badge";
import { Button } from "@composable-os/ui/components/button";
import { Card, CardContent, CardHeader, CardTitle } from "@composable-os/ui/components/card";
import { Checkbox } from "@composable-os/ui/components/checkbox";
import { Input } from "@composable-os/ui/components/input";
import { Label } from "@composable-os/ui/components/label";
import { Skeleton } from "@composable-os/ui/components/skeleton";
import { Switch } from "@composable-os/ui/components/switch";
import { Textarea } from "@composable-os/ui/components/textarea";
import { createFileRoute } from "@tanstack/react-router";
import { ArrowDownIcon, ArrowUpIcon, PlusIcon, Trash2Icon } from "lucide-react";
import { type FormEvent, useEffect, useState } from "react";
import { toast } from "sonner";
import { PageLayout } from "#/components/layout/page-layout";
import { errorMessage, useOp, useOpMutation } from "#/lib/query";

export const Route = createFileRoute("/_app/settings/checklists")({
  component: ChecklistsPage,
});

const MAX_STEPS = 50;

interface StepDraft {
  key: number;
  text: string;
  required: boolean;
  note: boolean;
}

let nextKey = 1;
const blankStep = (): StepDraft => ({ key: nextKey++, text: "", required: true, note: false });

const WEEKDAYS = [
  { day: 1, short: "Mon", label: "Monday" },
  { day: 2, short: "Tue", label: "Tuesday" },
  { day: 3, short: "Wed", label: "Wednesday" },
  { day: 4, short: "Thu", label: "Thursday" },
  { day: 5, short: "Fri", label: "Friday" },
  { day: 6, short: "Sat", label: "Saturday" },
  { day: 7, short: "Sun", label: "Sunday" },
];

type Who =
  | { kind: "staff" }
  | { kind: "role"; role: string }
  | { kind: "grant"; permission: string };
/** The schedule's "who", as the select holds it: `staff`, `role:<role>` or `grant:<permission>`. */
const whoValue = (who: { kind: string; value: string | null }) =>
  who.kind === "staff" ? "staff" : `${who.kind}:${who.value ?? ""}`;
function whoOf(value: string): Who {
  if (value.startsWith("role:")) return { kind: "role", role: value.slice(5) };
  if (value.startsWith("grant:")) return { kind: "grant", permission: value.slice(6) };
  return { kind: "staff" };
}
/** A schedule in a line: "Mon, Wed, Fri, by 09:00". */
function scheduleLine(schedule: { days: number[]; dueBy: string | null }): string {
  const days =
    schedule.days.length === 7
      ? "Every day"
      : schedule.days.map((d) => WEEKDAYS.find((w) => w.day === d)?.short ?? "").join(", ");
  return schedule.dueBy ? `${days}, by ${schedule.dueBy}` : days;
}

function ChecklistsPage() {
  const { isAdmin } = Route.useRouteContext();
  const list = useOp("checklist.list", {});
  // null: nothing open; "new": a new checklist; otherwise the id being edited.
  const [editing, setEditing] = useState<string | null>(null);
  return (
    <PageLayout
      title="Checklists"
      width="md"
      back={{ to: "/settings", label: "Settings" }}
      description="Lists of steps staff tick off, such as a close-down clean or opening up. Give one set days to be done on its own, or pick it on a duty and each of its shifts gets it to tick off."
    >
      {!isAdmin && (
        <p className="text-muted-foreground text-sm" data-testid="checklist-who-writes">
          Admins, and anyone an admin gives the checklists permission, can write and change
          checklists.
        </p>
      )}
      {editing === null ? (
        <Button className="w-fit" onClick={() => setEditing("new")} data-testid="checklist-new">
          <PlusIcon className="size-4" /> New checklist
        </Button>
      ) : (
        <ChecklistEditor
          key={editing}
          id={editing === "new" ? null : editing}
          onDone={() => setEditing(null)}
        />
      )}
      <Card>
        <CardHeader>
          <CardTitle>Checklists</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2">
          {list.isLoading ? (
            <Skeleton className="h-16 w-full" />
          ) : list.data?.items.length ? (
            <ul className="divide-y" data-testid="checklist-list">
              {list.data.items.map((c) => (
                <li
                  key={c.id}
                  className="flex flex-wrap items-center gap-2 py-3"
                  data-testid="checklist-item"
                  data-checklist={c.id}
                >
                  <span className="font-medium">{c.name}</span>
                  <Badge variant={c.active ? "default" : "outline"}>
                    {c.active ? "In use" : "Not in use"}
                  </Badge>
                  <span className="text-muted-foreground text-sm">
                    {c.steps} {c.steps === 1 ? "step" : "steps"} · version {c.version}
                  </span>
                  {c.schedule ? (
                    <Badge variant="outline" data-testid="checklist-schedule">
                      {scheduleLine(c.schedule)}
                    </Badge>
                  ) : null}
                  <Button
                    variant="ghost"
                    size="sm"
                    className="ml-auto"
                    onClick={() => setEditing(c.id)}
                    aria-label={`Edit ${c.name}`}
                  >
                    Edit
                  </Button>
                  {c.purpose ? (
                    <span className="text-muted-foreground w-full text-sm">{c.purpose}</span>
                  ) : null}
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-muted-foreground text-sm">No checklists yet.</p>
          )}
        </CardContent>
      </Card>
    </PageLayout>
  );
}

function ChecklistEditor({ id, onDone }: { id: string | null; onDone: () => void }) {
  const existing = useOp("checklist.get", { id: id ?? "" }, { enabled: id !== null });
  const save = useOpMutation("checklist.save");
  const [name, setName] = useState("");
  const [purpose, setPurpose] = useState("");
  const [active, setActive] = useState(true);
  const [steps, setSteps] = useState<StepDraft[]>(() => [blankStep()]);
  const [onOwn, setOnOwn] = useState(false);
  const [days, setDays] = useState<number[]>([1, 2, 3, 4, 5, 6, 7]);
  const [dueBy, setDueBy] = useState("");
  const [who, setWho] = useState("staff");
  const choices = useOp("checklist.whoChoices", {}, { enabled: onOwn });
  const [loaded, setLoaded] = useState(id === null);

  useEffect(() => {
    if (loaded || !existing.data) return;
    setName(existing.data.name);
    setPurpose(existing.data.purpose ?? "");
    setActive(existing.data.active);
    setSteps(
      existing.data.steps.map((s) => ({
        key: nextKey++,
        text: s.text,
        required: s.required,
        note: s.note,
      })),
    );
    const schedule = existing.data.schedule;
    setOnOwn(schedule !== null);
    if (schedule) {
      setDays(schedule.days);
      setDueBy(schedule.dueBy ?? "");
      setWho(whoValue(schedule.who));
    }
    setLoaded(true);
  }, [existing.data, loaded]);

  const update = (key: number, patch: Partial<StepDraft>) =>
    setSteps((list) => list.map((s) => (s.key === key ? { ...s, ...patch } : s)));
  const move = (index: number, by: number) =>
    setSteps((list) => {
      const next = [...list];
      const [step] = next.splice(index, 1);
      if (step) next.splice(index + by, 0, step);
      return next;
    });

  const filled = steps.filter((s) => s.text.trim());
  async function submit(event: FormEvent) {
    event.preventDefault();
    try {
      const out = await save.mutateAsync({
        ...(id ? { id } : {}),
        name: name.trim(),
        purpose: purpose.trim() || null,
        active,
        steps: filled.map((s) => ({ text: s.text.trim(), required: s.required, note: s.note })),
        schedule: onOwn ? { days, dueBy: dueBy || null, who: whoOf(who) } : null,
      });
      toast.success(
        id && out.changed
          ? "Saved. Shifts already given this checklist keep the steps they had."
          : "Saved.",
      );
      onDone();
    } catch (error) {
      toast.error(errorMessage(error));
    }
  }

  if (!loaded) return <Skeleton className="h-40 w-full" />;
  return (
    <Card>
      <CardHeader>
        <CardTitle>{id ? "Edit checklist" : "New checklist"}</CardTitle>
      </CardHeader>
      <CardContent>
        <form className="grid gap-4" onSubmit={submit} data-testid="checklist-form">
          <div className="grid gap-1">
            <Label htmlFor="checklist-name">Name</Label>
            <Input
              id="checklist-name"
              data-testid="checklist-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              required
              maxLength={120}
            />
          </div>
          <div className="grid gap-1">
            <Label htmlFor="checklist-purpose">What it is for</Label>
            <Textarea
              id="checklist-purpose"
              data-testid="checklist-purpose"
              value={purpose}
              onChange={(e) => setPurpose(e.target.value)}
              maxLength={500}
            />
          </div>
          <div className="flex items-center gap-2">
            <Switch
              id="checklist-active"
              data-testid="checklist-active"
              checked={active}
              onCheckedChange={setActive}
            />
            <Label htmlFor="checklist-active">In use (it can be picked on a duty)</Label>
          </div>
          <fieldset className="grid gap-2 rounded-md border p-3" data-testid="checklist-own">
            <legend className="px-1 text-sm font-medium">Done on its own</legend>
            <div className="flex items-center gap-2">
              <Switch
                id="checklist-on-own"
                data-testid="checklist-on-own"
                checked={onOwn}
                onCheckedChange={setOnOwn}
              />
              <Label htmlFor="checklist-on-own">
                Due on set days, without a shift (opening, closing, cleaning)
              </Label>
            </div>
            {onOwn ? (
              <>
                <fieldset className="flex flex-wrap gap-3 text-sm">
                  <legend className="sr-only">Days it is due</legend>
                  {WEEKDAYS.map((w) => (
                    <span key={w.day} className="flex items-center gap-1.5">
                      <Checkbox
                        aria-label={w.label}
                        data-testid={`checklist-day-${w.day}`}
                        checked={days.includes(w.day)}
                        onCheckedChange={(on) =>
                          setDays((list) =>
                            on === true
                              ? [...new Set([...list, w.day])].sort((a, b) => a - b)
                              : list.filter((d) => d !== w.day),
                          )
                        }
                      />
                      <span aria-hidden>{w.short}</span>
                    </span>
                  ))}
                </fieldset>
                <div className="grid gap-1">
                  <Label htmlFor="checklist-due-by">Due by (the business's time)</Label>
                  <Input
                    id="checklist-due-by"
                    data-testid="checklist-due-by"
                    type="time"
                    className="w-40"
                    value={dueBy}
                    onChange={(e) => setDueBy(e.target.value)}
                  />
                </div>
                <div className="grid gap-1">
                  <Label htmlFor="checklist-who">Who may do it</Label>
                  <select
                    id="checklist-who"
                    data-testid="checklist-who"
                    className="border-input h-9 rounded-md border bg-transparent px-2 text-sm"
                    value={who}
                    onChange={(e) => setWho(e.target.value)}
                  >
                    <option value="staff">Everyone on staff</option>
                    {(choices.data?.roles ?? []).map((r) => (
                      <option key={r.role} value={`role:${r.role}`}>
                        {r.label}
                      </option>
                    ))}
                    {(choices.data?.grants ?? []).map((g) => (
                      <option key={g.permission} value={`grant:${g.permission}`}>
                        Granted: {g.label}
                      </option>
                    ))}
                    {who !== "staff" &&
                    !choices.data?.roles.some((r) => `role:${r.role}` === who) &&
                    !choices.data?.grants.some((g) => `grant:${g.permission}` === who) ? (
                      <option value={who}>{who.replace(/^(role|grant):/, "")}</option>
                    ) : null}
                  </select>
                </div>
                <p className="text-muted-foreground text-sm">
                  Each day it is due gets one checklist, on Today's checklists, from the start of
                  the day. Whoever ticks the last step finishes it; not finished by the end of the
                  day, it is missed and whoever manages checklists is told.
                </p>
              </>
            ) : null}
          </fieldset>
          <fieldset className="grid gap-2">
            <legend className="mb-1 text-sm font-medium">Steps, in order</legend>
            <ol className="grid gap-2" data-testid="checklist-steps">
              {steps.map((step, index) => (
                <li
                  key={step.key}
                  className="grid gap-2 rounded-md border p-2"
                  data-testid="checklist-step"
                >
                  <div className="flex items-center gap-2">
                    <span className="text-muted-foreground w-6 text-sm">{index + 1}.</span>
                    <Input
                      aria-label={`Step ${index + 1}`}
                      data-testid="checklist-step-text"
                      value={step.text}
                      maxLength={300}
                      onChange={(e) => update(step.key, { text: e.target.value })}
                    />
                  </div>
                  <div className="flex flex-wrap items-center gap-4 pl-8 text-sm">
                    <span className="flex items-center gap-1.5">
                      <Checkbox
                        aria-label={`Step ${index + 1} is required`}
                        checked={step.required}
                        onCheckedChange={(on) => update(step.key, { required: on === true })}
                      />
                      <span aria-hidden>Required</span>
                    </span>
                    <span className="flex items-center gap-1.5">
                      <Checkbox
                        aria-label={`Step ${index + 1} asks for a note`}
                        data-testid="checklist-step-note"
                        checked={step.note}
                        onCheckedChange={(on) => update(step.key, { note: on === true })}
                      />
                      <span aria-hidden>Asks for a note</span>
                    </span>
                    <span className="ml-auto flex gap-1">
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        aria-label={`Move step ${index + 1} up`}
                        disabled={index === 0}
                        onClick={() => move(index, -1)}
                      >
                        <ArrowUpIcon className="size-4" />
                      </Button>
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        aria-label={`Move step ${index + 1} down`}
                        disabled={index === steps.length - 1}
                        onClick={() => move(index, 1)}
                      >
                        <ArrowDownIcon className="size-4" />
                      </Button>
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        aria-label={`Remove step ${index + 1}`}
                        disabled={steps.length === 1}
                        onClick={() => setSteps((list) => list.filter((s) => s.key !== step.key))}
                      >
                        <Trash2Icon className="size-4" />
                      </Button>
                    </span>
                  </div>
                </li>
              ))}
            </ol>
            <Button
              type="button"
              variant="outline"
              className="w-fit"
              data-testid="checklist-add-step"
              disabled={steps.length >= MAX_STEPS}
              onClick={() => setSteps((list) => [...list, blankStep()])}
            >
              <PlusIcon className="size-4" /> Add a step
            </Button>
            {steps.length >= MAX_STEPS ? (
              <p className="text-muted-foreground text-sm">A checklist has at most 50 steps.</p>
            ) : null}
          </fieldset>
          {id ? (
            <p className="text-muted-foreground text-sm">
              Shifts already given this checklist keep the steps they had; later shifts get these.
            </p>
          ) : null}
          <div className="flex gap-2">
            <Button
              type="submit"
              data-testid="checklist-save"
              disabled={save.isPending || !name.trim() || !filled.length || (onOwn && !days.length)}
            >
              Save
            </Button>
            <Button type="button" variant="ghost" onClick={onDone}>
              Cancel
            </Button>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}
