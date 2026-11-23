// Settings → Checklists (stage 45 step 4b, ADR 0650): the business's checklists, lists of steps
// staff tick off on a duty (a close-down clean, opening up). Anyone on the staff reads them;
// writing needs checklists:write (admins, and anyone an admin grants it), which the host checks.
// A change applies to runs made from now on: shifts already given a run keep the steps they had.
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
      description="Lists of steps staff tick off on a duty, such as a close-down clean or opening up. Pick one on a duty and each of its shifts gets it to tick off."
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
              disabled={save.isPending || !name.trim() || !filled.length}
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
