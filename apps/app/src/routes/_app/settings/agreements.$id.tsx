// Settings → Agreements → a document (stage 44 step 1, ADRs 0610 and 0611): the working copy
// editor (title, body, tick label, how, who, for whom, a health form's questions), Publish (the
// change against the newest version, small change or everyone agrees again, now or from a date),
// where it is needed (attach and detach agreement points), its versions, and Retire. The host
// decides everything: publishing names the hash of the copy shown here, so a copy changed
// meanwhile (by the assistant drafting) is refused and shown again.

import type { CoreOutput } from "@composable-os/core";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@composable-os/ui/components/alert-dialog";
import { Badge } from "@composable-os/ui/components/badge";
import { Button } from "@composable-os/ui/components/button";
import { Card, CardContent, CardHeader, CardTitle } from "@composable-os/ui/components/card";
import { Checkbox } from "@composable-os/ui/components/checkbox";
import { Input } from "@composable-os/ui/components/input";
import { Label } from "@composable-os/ui/components/label";
import { RadioGroup, RadioGroupItem } from "@composable-os/ui/components/radio-group";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@composable-os/ui/components/select";
import { Skeleton } from "@composable-os/ui/components/skeleton";
import { createFileRoute } from "@tanstack/react-router";
import { PlusIcon, Trash2Icon } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { RichTextEditor } from "#/components/fields/rich-text-editor";
import { PageLayout } from "#/components/layout/page-layout";
import {
  CHANGE_LABELS,
  FOR_LABELS,
  HOW_LABELS,
  KIND_LABELS,
  WHO_LABELS,
} from "#/components/settings/agreement-labels";
import { formatDateTime } from "#/lib/format";
import { errorMessage, useOp, useOpMutation } from "#/lib/query";

export const Route = createFileRoute("/_app/settings/agreements/$id")({
  component: AgreementPage,
});

type Doc = CoreOutput<"agreement.get">;
type Draft = Doc["draft"];
type Question = NonNullable<Draft["questions"]>[number];

function AgreementPage() {
  const { id } = Route.useParams();
  const doc = useOp("agreement.get", { id });
  return (
    <PageLayout
      title={doc.data?.title ?? "Agreement"}
      width="md"
      back={{ to: "/settings/agreements", label: "Agreements" }}
      titleAddon={
        doc.data ? (
          <span className="flex gap-2">
            <Badge variant="secondary">{KIND_LABELS[doc.data.kind] ?? doc.data.kind}</Badge>
            <Badge variant={doc.data.state === "live" ? "default" : "outline"}>
              {doc.data.state}
            </Badge>
          </span>
        ) : undefined
      }
    >
      {doc.isLoading || !doc.data ? (
        <Skeleton className="h-64 w-full" />
      ) : (
        <>
          {doc.data.state !== "retired" && <WorkingCopy doc={doc.data} />}
          {doc.data.state !== "retired" && <Publish doc={doc.data} />}
          <Points doc={doc.data} />
          <Versions doc={doc.data} />
          {doc.data.state !== "retired" && <Retire doc={doc.data} />}
        </>
      )}
    </PageLayout>
  );
}

function WorkingCopy({ doc }: { doc: Doc }) {
  const save = useOpMutation("agreement.draft.save", { invalidates: ["agreement."] });
  const [draft, setDraft] = useState<Draft>(doc.draft);
  // Another save (the assistant's) moves the copy on: show it.
  useEffect(() => setDraft(doc.draft), [doc.draft]);
  const health = doc.kind === "health";
  const set = <K extends keyof Draft>(key: K, value: Draft[K]) =>
    setDraft((d) => ({ ...d, [key]: value }));
  async function submit() {
    try {
      await save.mutateAsync({
        id: doc.id,
        title: draft.title,
        ...(draft.body ? { body: draft.body } : {}),
        tickLabel: draft.tickLabel?.trim() ? draft.tickLabel : null,
        how: draft.how,
        who: draft.who,
        forWhom: draft.forWhom,
        ...(health ? { questions: draft.questions?.length ? draft.questions : null } : {}),
        ...(health ? { askAgainMonths: draft.askAgainMonths } : {}),
      });
      toast.success("Working copy saved");
    } catch (error) {
      toast.error(errorMessage(error));
    }
  }
  return (
    <Card>
      <CardHeader>
        <CardTitle>Working copy</CardTitle>
        <p className="text-muted-foreground text-sm">
          Saving changes no published version and asks nobody anything. Last saved{" "}
          {formatDateTime(doc.draft.updatedAt)}.
        </p>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid gap-1">
          <Label htmlFor="draft-title">Title</Label>
          <Input
            id="draft-title"
            value={draft.title}
            maxLength={200}
            onChange={(e) => set("title", e.target.value)}
          />
        </div>
        <div className="grid gap-1">
          <Label htmlFor="draft-body">The document</Label>
          <div className="rounded-md border">
            <RichTextEditor id="draft-body" value={draft.body} onChange={(v) => set("body", v)} />
          </div>
        </div>
        <div className="grid gap-1">
          <Label htmlFor="draft-tick">The words beside the box</Label>
          <Input
            id="draft-tick"
            value={draft.tickLabel ?? ""}
            maxLength={500}
            onChange={(e) => set("tickLabel", e.target.value)}
          />
        </div>
        <Choice
          id="draft-how"
          label="How a person agrees"
          value={draft.how}
          labels={HOW_LABELS}
          onChange={(v) => set("how", v as Draft["how"])}
        />
        <Choice
          id="draft-who"
          label="Who agrees"
          value={draft.who}
          labels={WHO_LABELS}
          onChange={(v) => set("who", v as Draft["who"])}
        />
        <Choice
          id="draft-for"
          label="For whom"
          value={draft.forWhom}
          labels={FOR_LABELS}
          onChange={(v) => set("forWhom", v as Draft["forWhom"])}
        />
        {health && (
          <Questions
            questions={draft.questions ?? []}
            onChange={(qs) => set("questions", qs)}
            askAgainMonths={draft.askAgainMonths}
            onAskAgain={(m) => set("askAgainMonths", m)}
          />
        )}
        <Button onClick={submit} disabled={save.isPending}>
          Save working copy
        </Button>
      </CardContent>
    </Card>
  );
}

function Choice({
  id,
  label,
  value,
  labels,
  onChange,
}: {
  id: string;
  label: string;
  value: string;
  labels: Record<string, string>;
  onChange: (value: string) => void;
}) {
  return (
    <div className="grid gap-1">
      <Label htmlFor={id}>{label}</Label>
      <Select value={value} onValueChange={onChange}>
        <SelectTrigger id={id} className="w-full sm:w-96">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {Object.entries(labels).map(([v, l]) => (
            <SelectItem key={v} value={v}>
              {l}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}

function Questions({
  questions,
  onChange,
  askAgainMonths,
  onAskAgain,
}: {
  questions: Question[];
  onChange: (questions: Question[]) => void;
  askAgainMonths: number | null;
  onAskAgain: (months: number | null) => void;
}) {
  const update = (i: number, patch: Partial<Question>) =>
    onChange(questions.map((q, j) => (j === i ? { ...q, ...patch } : q)));
  return (
    <fieldset className="space-y-2">
      <legend className="font-medium text-sm">Health questions (yes or no)</legend>
      {questions.map((q, i) => (
        <div key={q.key} className="flex flex-wrap items-center gap-2">
          <Input
            aria-label={`Question ${i + 1}`}
            className="min-w-60 flex-1"
            value={q.text}
            maxLength={500}
            onChange={(e) => update(i, { text: e.target.value })}
          />
          <Label className="flex items-center gap-1 text-sm">
            <Checkbox
              checked={q.noteOnYes}
              onCheckedChange={(c) => update(i, { noteOnYes: c === true })}
            />
            A yes asks for a note
          </Label>
          <Button
            variant="ghost"
            size="icon"
            aria-label={`Remove question ${i + 1}`}
            onClick={() => onChange(questions.filter((_, j) => j !== i))}
          >
            <Trash2Icon className="size-4" />
          </Button>
        </div>
      ))}
      <Button
        variant="outline"
        size="sm"
        disabled={questions.length >= 40}
        onClick={() =>
          onChange([
            ...questions,
            { key: `q${Date.now().toString(36)}`, text: "", noteOnYes: false },
          ])
        }
      >
        <PlusIcon className="size-4" /> Add a question
      </Button>
      <div className="grid gap-1 pt-2">
        <Label htmlFor="draft-ask-again">Ask again after (months; empty for never)</Label>
        <Input
          id="draft-ask-again"
          type="number"
          min={1}
          max={120}
          className="w-32"
          value={askAgainMonths ?? ""}
          onChange={(e) => onAskAgain(e.target.value ? Number(e.target.value) : null)}
        />
      </div>
    </fieldset>
  );
}

function Publish({ doc }: { doc: Doc }) {
  const preview = useOp("agreement.publishPreview", { id: doc.id });
  const publish = useOpMutation("agreement.publish", { invalidates: ["agreement."] });
  const [change, setChange] = useState<"small" | "agree_again">("small");
  const [when, setWhen] = useState("");
  const [confirming, setConfirming] = useState(false);
  const p = preview.data;
  async function confirm() {
    if (!p) return;
    try {
      const effectiveFrom = when ? new Date(when).toISOString() : undefined;
      const out = await publish.mutateAsync({
        documentId: doc.id,
        change,
        draftHash: p.draftHash,
        ...(effectiveFrom ? { effectiveFrom } : {}),
      });
      toast.success(`Version ${out.version.number} published`);
      setWhen("");
    } catch (error) {
      toast.error(errorMessage(error));
    } finally {
      setConfirming(false);
    }
  }
  return (
    <Card>
      <CardHeader>
        <CardTitle>Publish</CardTitle>
        <p className="text-muted-foreground text-sm">
          A published version is kept for good and never changed. Only a person publishes.
        </p>
      </CardHeader>
      <CardContent className="space-y-3">
        {!p ? (
          <Skeleton className="h-10 w-full" />
        ) : p.problems.length ? (
          <ul className="list-disc pl-5 text-sm" data-testid="publish-problems">
            {p.problems.map((problem) => (
              <li key={problem}>{problem}</li>
            ))}
          </ul>
        ) : (
          <>
            <p className="text-sm" data-testid="publish-summary">
              This makes version {p.number}.{" "}
              {p.first
                ? "It is the first."
                : p.changed.length
                  ? `Changed since version ${p.number - 1}: ${p.changed.join(", ")}.`
                  : `Nothing changed since version ${p.number - 1}.`}
            </p>
            {!p.first && (
              <RadioGroup
                value={change}
                onValueChange={(v) => setChange(v as "small" | "agree_again")}
                aria-label="What kind of change"
              >
                <Label className="flex items-center gap-2">
                  <RadioGroupItem value="small" /> Small change: earlier agreements still count
                </Label>
                <Label className="flex items-center gap-2">
                  <RadioGroupItem value="agree_again" /> Everyone agrees again before their next
                  booking or purchase
                </Label>
              </RadioGroup>
            )}
            <div className="grid gap-1">
              <Label htmlFor="publish-when">Takes effect (empty: now)</Label>
              <Input
                id="publish-when"
                type="datetime-local"
                className="w-64"
                value={when}
                onChange={(e) => setWhen(e.target.value)}
              />
            </div>
            <Button onClick={() => setConfirming(true)} disabled={publish.isPending}>
              Publish version {p.number}
            </Button>
          </>
        )}
      </CardContent>
      <AlertDialog open={confirming} onOpenChange={setConfirming}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Publish version {p?.number}?</AlertDialogTitle>
            <AlertDialogDescription>
              {p?.first ? CHANGE_LABELS.first : CHANGE_LABELS[change]},{" "}
              {when ? `from ${formatDateTime(new Date(when).toISOString())}` : "now"}. It cannot be
              changed or withdrawn afterwards.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={confirm}>Publish</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Card>
  );
}

function Points({ doc }: { doc: Doc }) {
  const points = useOp("agreement.points", {});
  const attach = useOpMutation("agreement.attach", { invalidates: ["agreement."] });
  const detach = useOpMutation("agreement.detach", { invalidates: ["agreement."] });
  async function toggle(point: string, on: boolean) {
    try {
      if (on) await attach.mutateAsync({ documentId: doc.id, points: [point] });
      else await detach.mutateAsync({ documentId: doc.id, points: [point] });
    } catch (error) {
      toast.error(errorMessage(error));
    }
  }
  const items = points.data?.items ?? [];
  return (
    <Card>
      <CardHeader>
        <CardTitle>Where it is needed</CardTitle>
        <p className="text-muted-foreground text-sm">
          The places installed packs mark. Attaching asks it of anyone without a current agreement
          from then on; nothing already bought or booked changes.
        </p>
      </CardHeader>
      <CardContent className="space-y-2">
        {doc.state === "draft" && (
          <p className="text-muted-foreground text-sm">Publish the document first.</p>
        )}
        {items.length === 0 && (
          <p className="text-muted-foreground text-sm">No installed pack marks a place yet.</p>
        )}
        {items.map((point) => (
          <Label key={point.point} className="flex items-center gap-2">
            <Checkbox
              checked={doc.points.includes(point.point)}
              disabled={doc.state !== "live" || attach.isPending || detach.isPending}
              onCheckedChange={(c) => toggle(point.point, c === true)}
            />
            {point.label}
            {point.suggests.includes(doc.kind) && (
              <span className="text-muted-foreground text-xs">(suggested)</span>
            )}
          </Label>
        ))}
      </CardContent>
    </Card>
  );
}

function Versions({ doc }: { doc: Doc }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Versions</CardTitle>
      </CardHeader>
      <CardContent>
        {doc.versions.length ? (
          <ul className="divide-y text-sm" data-testid="agreement-versions">
            {doc.versions.map((v) => (
              <li key={v.id} className="flex flex-wrap gap-2 py-2">
                <span className="font-medium">Version {v.number}</span>
                <span>{CHANGE_LABELS[v.change]}</span>
                <span className="text-muted-foreground">
                  {v.id === doc.current?.id
                    ? "in effect"
                    : v.effectiveFrom > new Date().toISOString()
                      ? `from ${formatDateTime(v.effectiveFrom)}`
                      : `from ${formatDateTime(v.effectiveFrom)}, replaced`}
                </span>
                <span className="text-muted-foreground">
                  published {formatDateTime(v.publishedAt)}
                </span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-muted-foreground text-sm">Not published yet.</p>
        )}
      </CardContent>
    </Card>
  );
}

function Retire({ doc }: { doc: Doc }) {
  const retire = useOpMutation("agreement.retire", { invalidates: ["agreement."] });
  const [open, setOpen] = useState(false);
  return (
    <div className="flex justify-end">
      <Button variant="outline" onClick={() => setOpen(true)}>
        Retire document
      </Button>
      <AlertDialog open={open} onOpenChange={setOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Retire this document?</AlertDialogTitle>
            <AlertDialogDescription>
              It is needed nowhere from now on and cannot be published again. Its versions and the
              agreements people made are kept.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={async () => {
                try {
                  await retire.mutateAsync({ documentId: doc.id });
                  toast.success("Retired");
                } catch (error) {
                  toast.error(errorMessage(error));
                }
              }}
            >
              Retire
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
