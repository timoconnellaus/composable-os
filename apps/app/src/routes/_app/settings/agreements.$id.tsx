// Settings → Agreements → a document (stage 44 step 1, ADRs 0640 and 0641): the working copy
// editor (title, body, tick label, how, who, for whom, a health form's questions), Publish (the
// change against the newest version, small change or everyone agrees again, now or from a date),
// where it is needed (attach and detach agreement points), its versions, and Retire. The host
// decides everything. The confirm step shows the exact snapshot publishPreview returned (every
// field) and publishes that snapshot's hash and rev, so a copy changed meanwhile (the assistant
// drafting) is refused. Publish waits for unsaved edits, and a copy someone else saved is never
// swapped in silently: the page says who changed it and offers to load it.

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
import { useQueryClient } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { PlusIcon, Trash2Icon } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { RichTextEditor } from "#/components/fields/rich-text-editor";
import { PageLayout } from "#/components/layout/page-layout";
import { AgreementBody } from "#/components/settings/agreement-body";
import {
  CHANGE_LABELS,
  FOR_LABELS,
  HOW_LABELS,
  KIND_LABELS,
  WHO_LABELS,
} from "#/components/settings/agreement-labels";
import { formatDateTime } from "#/lib/format";
import { callOp } from "#/lib/operations";
import { errorMessage, invalidateOps, useOp, useOpMutation } from "#/lib/query";

export const Route = createFileRoute("/_app/settings/agreements/$id")({
  component: AgreementPage,
});

type Doc = CoreOutput<"agreement.get">;
type Draft = Doc["draft"];
type Question = NonNullable<Draft["questions"]>[number];

const VIA_LABELS: Record<string, string> = {
  human: "a person",
  assistant: "the assistant",
  mcp: "an MCP client",
  automation: "an automation",
  extension: "extension code",
};

/** Who saved a copy: the staff account's name and, when it was not the person, the kind of actor. */
function savedBy(draft: { updatedVia: string; updatedByName: string | null }): string {
  const name = draft.updatedByName ?? "a staff account";
  return draft.updatedVia === "human"
    ? name
    : `${VIA_LABELS[draft.updatedVia] ?? draft.updatedVia}, for ${name}`;
}

function AgreementPage() {
  const { id } = Route.useParams();
  const doc = useOp("agreement.get", { id });
  // Whether the editor holds edits not yet saved: Publish waits for them.
  const [dirty, setDirty] = useState(false);
  // The working copy's rev the editor shows (null until loaded): what a save and a publish are
  // made against.
  const [shownRev, setShownRev] = useState<number | null>(null);
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
          {doc.data.state !== "retired" && (
            <WorkingCopy
              doc={doc.data}
              onDirty={setDirty}
              shownRev={shownRev}
              onShownRev={setShownRev}
            />
          )}
          {doc.data.state !== "retired" && (
            <Publish
              doc={doc.data}
              shownRev={shownRev}
              onPublished={setShownRev}
              blocked={
                dirty
                  ? "Save or discard your edits before publishing."
                  : shownRev !== null && shownRev !== doc.data.draft.rev
                    ? "Someone else changed the working copy: load it before publishing."
                    : null
              }
            />
          )}
          <Points doc={doc.data} />
          <Versions doc={doc.data} />
          {doc.data.state !== "retired" && <Retire doc={doc.data} />}
        </>
      )}
    </PageLayout>
  );
}

function WorkingCopy({
  doc,
  onDirty,
  shownRev,
  onShownRev,
}: {
  doc: Doc;
  onDirty: (dirty: boolean) => void;
  shownRev: number | null;
  onShownRev: (rev: number) => void;
}) {
  const save = useOpMutation("agreement.draft.save", { invalidates: ["agreement."] });
  const [draft, setDraft] = useState<Draft>(doc.draft);
  const [dirty, setDirtyState] = useState(false);
  // The editor is remounted to show a copy loaded from the server (never while editing).
  const [editorKey, setEditorKey] = useState(0);
  const setDirty = (value: boolean) => {
    setDirtyState(value);
    onDirty(value);
  };
  useEffect(() => {
    if (shownRev === null) onShownRev(doc.draft.rev);
  }, [shownRev, doc.draft.rev, onShownRev]);
  const health = doc.kind === "health";
  const set = <K extends keyof Draft>(key: K, value: Draft[K]) => {
    setDraft((d) => ({ ...d, [key]: value }));
    setDirty(true);
  };
  // Someone else saved since this copy was loaded: say who, and never swap it silently.
  const changedElsewhere = shownRev !== null && shownRev !== doc.draft.rev;
  function loadNewest() {
    setDraft(doc.draft);
    setEditorKey((k) => k + 1);
    onShownRev(doc.draft.rev);
    setDirty(false);
  }
  async function submit() {
    try {
      const saved = await save.mutateAsync({
        id: doc.id,
        draftRev: shownRev ?? doc.draft.rev,
        title: draft.title,
        ...(draft.body ? { body: draft.body } : {}),
        tickLabel: draft.tickLabel?.trim() ? draft.tickLabel : null,
        how: draft.how,
        who: draft.who,
        forWhom: draft.forWhom,
        ...(health ? { questions: draft.questions?.length ? draft.questions : null } : {}),
        ...(health ? { askAgainMonths: draft.askAgainMonths } : {}),
      });
      onShownRev(saved.rev);
      setDirty(false);
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
          {formatDateTime(doc.draft.updatedAt)} by {savedBy(doc.draft)}.
        </p>
        {changedElsewhere && (
          <div
            className="flex flex-wrap items-center gap-2 rounded-md border border-amber-500 p-2 text-sm"
            role="alert"
            data-testid="draft-changed"
          >
            The working copy was changed by {savedBy(doc.draft)} at{" "}
            {formatDateTime(doc.draft.updatedAt)}, after you opened it. You are still looking at the
            copy you opened.
            <Button size="sm" variant="outline" onClick={loadNewest}>
              {dirty ? "Discard my edits and load it" : "Load the newest copy"}
            </Button>
          </div>
        )}
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
          <p className="text-muted-foreground text-xs">
            No pictures. A link must show its own address, and a linked page is not part of what a
            person agrees to.
          </p>
          <div className="rounded-md border">
            <RichTextEditor
              key={editorKey}
              id="draft-body"
              value={draft.body}
              onChange={(v) => set("body", v)}
            />
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

type Preview = CoreOutput<"agreement.publishPreview">;

function Publish({
  doc,
  blocked,
  shownRev,
  onPublished,
}: {
  doc: Doc;
  blocked: string | null;
  shownRev: number | null;
  onPublished: (rev: number) => void;
}) {
  const preview = useOp("agreement.publishPreview", { id: doc.id });
  const publish = useOpMutation("agreement.publish", { invalidates: ["agreement."] });
  const client = useQueryClient();
  const [change, setChange] = useState<"small" | "agree_again">("small");
  const [when, setWhen] = useState("");
  // The exact snapshot the person confirms: read when they press Publish, and what is published.
  const [reviewing, setReviewing] = useState<Preview | null>(null);
  const p = preview.data;
  async function review() {
    try {
      setReviewing(await callOp("agreement.publishPreview", { id: doc.id }));
    } catch (error) {
      toast.error(errorMessage(error));
    }
  }
  async function confirm() {
    const snapshot = reviewing;
    if (!snapshot) return;
    try {
      const effectiveFrom = when ? new Date(when).toISOString() : undefined;
      const out = await publish.mutateAsync({
        documentId: doc.id,
        change,
        draftHash: snapshot.draftHash,
        draftRev: snapshot.draftRev,
        number: snapshot.number,
        ...(effectiveFrom ? { effectiveFrom } : {}),
      });
      // The publish spends the reviewed rev: the editor now shows the next one, its own.
      onPublished(snapshot.draftRev + 1);
      toast.success(`Version ${out.version.number} published`);
      setWhen("");
    } catch (error) {
      toast.error(errorMessage(error));
      // Show what changed (and who changed it) instead of a stale copy.
      await invalidateOps(client, "agreement.");
    } finally {
      setReviewing(null);
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
            {blocked && (
              <p className="text-sm text-amber-700" role="note" data-testid="publish-blocked">
                {blocked}
              </p>
            )}
            <Button onClick={review} disabled={publish.isPending || blocked !== null}>
              Publish version {p.number}
            </Button>
          </>
        )}
      </CardContent>
      <AlertDialog open={reviewing !== null} onOpenChange={(open) => !open && setReviewing(null)}>
        <AlertDialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
          <AlertDialogHeader>
            <AlertDialogTitle>Publish version {reviewing?.number}?</AlertDialogTitle>
            <AlertDialogDescription>
              This is exactly what will be published:{" "}
              {reviewing?.first ? CHANGE_LABELS.first : CHANGE_LABELS[change]},{" "}
              {when ? `taking effect ${formatDateTime(new Date(when).toISOString())}` : "now"}. It
              cannot be changed or withdrawn afterwards.
            </AlertDialogDescription>
          </AlertDialogHeader>
          {reviewing && shownRev !== null && reviewing.draftRev !== shownRev && (
            <p
              className="rounded-md border border-amber-500 p-2 text-sm"
              role="alert"
              data-testid="snapshot-differs"
            >
              This is not the copy the editor is showing: it was saved again by{" "}
              {savedBy(reviewing.snapshot)} at {formatDateTime(reviewing.snapshot.updatedAt)}. Read
              it below before publishing.
            </p>
          )}
          {reviewing && <Snapshot preview={reviewing} />}
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={confirm}>Publish</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Card>
  );
}

/** The body's blocks that differ from the newest version's, each before and after. */
function BodyChanges({ before, after }: { before: unknown; after: unknown }) {
  const blocksOf = (v: unknown) =>
    ((v as { blocks?: unknown[] } | null)?.blocks ?? []) as unknown[];
  const a = blocksOf(before);
  const b = blocksOf(after);
  const rows: { i: number; was: unknown; now: unknown }[] = [];
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    if (JSON.stringify(a[i] ?? null) !== JSON.stringify(b[i] ?? null)) {
      rows.push({ i, was: a[i], now: b[i] });
    }
  }
  return (
    <div className="space-y-2 text-sm" data-testid="body-changes">
      <p className="font-medium">What changed in the body</p>
      {rows.map((row) => (
        <div key={row.i} className="grid gap-2 sm:grid-cols-2">
          <div className="rounded border border-red-300 p-2">
            <p className="text-muted-foreground text-xs">Before (block {row.i + 1})</p>
            {row.was ? <AgreementBody value={{ blocks: [row.was] }} /> : <p>(none)</p>}
          </div>
          <div className="rounded border border-green-400 p-2">
            <p className="text-muted-foreground text-xs">After (block {row.i + 1})</p>
            {row.now ? <AgreementBody value={{ blocks: [row.now] }} /> : <p>(removed)</p>}
          </div>
        </div>
      ))}
    </div>
  );
}

/** Every field the version will hold, as `publishPreview` returned it. */
function Snapshot({ preview }: { preview: Preview }) {
  const s = preview.snapshot;
  const row = (label: string, value: string) => (
    <div className="grid grid-cols-[10rem_1fr] gap-2">
      <dt className="text-muted-foreground">{label}</dt>
      <dd>{value}</dd>
    </div>
  );
  return (
    <div className="space-y-3 rounded-md border p-3" data-testid="publish-snapshot">
      <p className="font-semibold">{s.title}</p>
      <AgreementBody value={s.body} />
      {preview.latest && preview.changed.includes("body") && (
        <BodyChanges before={preview.latest.body} after={s.body} />
      )}
      <dl className="space-y-1 text-sm">
        {row("Beside the box", s.tickLabel ?? "")}
        {row("How a person agrees", HOW_LABELS[s.how] ?? s.how)}
        {row("Who agrees", WHO_LABELS[s.who] ?? s.who)}
        {row("For whom", FOR_LABELS[s.forWhom] ?? s.forWhom)}
        {s.kind === "health" &&
          row("Asked again after", s.askAgainMonths ? `${s.askAgainMonths} months` : "never")}
        {!preview.first &&
          row("Changed", preview.changed.length ? preview.changed.join(", ") : "nothing")}
      </dl>
      {s.questions?.length ? (
        <ol className="list-decimal pl-5 text-sm">
          {s.questions.map((q) => (
            <li key={q.key}>
              {q.text}
              {q.noteOnYes ? " (a yes asks for a note)" : ""}
            </li>
          ))}
        </ol>
      ) : null}
    </div>
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
                  {v.status === "in_effect"
                    ? "in effect"
                    : v.status === "scheduled"
                      ? `from ${formatDateTime(v.effectiveFrom)}`
                      : v.status === "replaced"
                        ? `from ${formatDateTime(v.effectiveFrom)}, replaced`
                        : "never in force (cancelled)"}
                </span>
                {!v.intact && <Badge variant="destructive">does not match its hash</Badge>}
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
