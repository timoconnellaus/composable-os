// Settings → Notes (stage 56 step 2, ADR 0833): the business's kinds of note. Each has a template
// (labelled sections a person fills in, such as Worked on / How it went / Next time), the level a
// note of it starts at and the lowest level one may have. Anyone on the staff reads the list;
// keeping it needs notes:manage (admins, and anyone an admin grants it), which the host checks.
// A changed level applies to notes written from then on: notes already written keep theirs. A
// retired kind is no longer offered and keeps its notes. Note, the kind of every note written
// without one, stays every staff account's and is never retired.
//
// Whether photos and PDFs may be attached to a kind's notes, and the files' storage total and its
// limit (stage 56 step 3, ADR 0834), are here too. Retention, evidence and the client's uploads
// are later steps of the stage: their settings join this page with them.

import { levelWords, type NoteLevel } from "@composable-os/client";
import type { CoreOutput } from "@composable-os/core";
import { Badge } from "@composable-os/ui/components/badge";
import { Button } from "@composable-os/ui/components/button";
import { Card, CardContent, CardHeader, CardTitle } from "@composable-os/ui/components/card";
import { Checkbox } from "@composable-os/ui/components/checkbox";
import { Input } from "@composable-os/ui/components/input";
import { Label } from "@composable-os/ui/components/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@composable-os/ui/components/select";
import { Skeleton } from "@composable-os/ui/components/skeleton";
import { createFileRoute } from "@tanstack/react-router";
import { ArrowDownIcon, ArrowUpIcon, PlusIcon, Trash2Icon } from "lucide-react";
import { type FormEvent, useState } from "react";
import { toast } from "sonner";
import { PageLayout } from "#/components/layout/page-layout";
import { errorMessage, useOp, useOpMutation } from "#/lib/query";

export const Route = createFileRoute("/_app/settings/notes")({
  component: NotesSettingsPage,
});

type Kind = CoreOutput<"note.kinds.list">["items"][number];

const LEVELS: NoteLevel[] = ["staff", "coaches", "sensitive"];
const MAX_SECTIONS = 12;

interface SectionDraft {
  /** The row's key in this form. */
  row: number;
  /** The section's key at the host, kept when its label changes; absent for a new one. */
  key?: string;
  label: string;
  hint: string;
  required: boolean;
}

let nextRow = 1;
const blankSection = (): SectionDraft => ({ row: nextRow++, label: "", hint: "", required: false });

function NotesSettingsPage() {
  const { isAdmin } = Route.useRouteContext();
  const list = useOp("note.kinds.list", { includeRetired: true });
  const retire = useOpMutation("note.kinds.retire");
  // null: nothing open; "new": a new kind; otherwise the id being edited.
  const [editing, setEditing] = useState<string | null>(null);
  const kinds = list.data?.items ?? [];
  const editingKind = kinds.find((k) => k.id === editing) ?? null;

  async function setRetired(kind: Kind, retired: boolean) {
    try {
      await retire.mutateAsync({ id: kind.id, retired });
      toast.success(retired ? `${kind.name} retired` : `${kind.name} is offered again`);
    } catch (error) {
      toast.error(errorMessage(error));
    }
  }

  return (
    <PageLayout
      title="Notes"
      width="md"
      back={{ to: "/settings", label: "Settings" }}
      description="The kinds of note staff write about a client: each with its template, who reads a note of it at first, and the tightest it may never go below."
    >
      {!isAdmin && (
        <p className="text-muted-foreground text-sm" data-testid="note-kinds-who-writes">
          Admins, and anyone an admin gives the notes permission, can change the kinds of note.
        </p>
      )}
      {editing === null ? (
        <Button className="w-fit" onClick={() => setEditing("new")} data-testid="note-kind-new">
          <PlusIcon className="size-4" /> New kind of note
        </Button>
      ) : (
        <KindEditor
          key={editing}
          kind={editing === "new" ? null : editingKind}
          onDone={() => setEditing(null)}
        />
      )}
      <Card>
        <CardHeader>
          <CardTitle>Kinds of note</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2">
          {list.isLoading ? (
            <Skeleton className="h-16 w-full" />
          ) : (
            <ul className="divide-y" data-testid="note-kind-list">
              {kinds.map((kind) => (
                <li
                  key={kind.id}
                  className="flex flex-wrap items-center gap-2 py-3"
                  data-testid="note-kind"
                  data-kind={kind.id}
                >
                  <span className="font-medium">{kind.name}</span>
                  <Badge variant="outline">{levelWords(kind.defaultLevel).label}</Badge>
                  {kind.lowestLevel !== "staff" ? (
                    <Badge variant="outline">
                      Never below {levelWords(kind.lowestLevel).label.toLowerCase()}
                    </Badge>
                  ) : null}
                  {kind.filesAllowed ? <Badge variant="outline">Files</Badge> : null}
                  {!kind.active ? <Badge variant="secondary">Retired</Badge> : null}
                  <span className="text-muted-foreground text-sm">
                    {kind.sections.length
                      ? `${kind.sections.length} ${kind.sections.length === 1 ? "section" : "sections"}`
                      : "No template"}
                  </span>
                  <span className="ml-auto flex gap-1">
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => setEditing(kind.id)}
                      aria-label={`Edit ${kind.name}`}
                    >
                      Edit
                    </Button>
                    {kind.key !== "note" ? (
                      <Button
                        variant="ghost"
                        size="sm"
                        disabled={retire.isPending}
                        onClick={() => void setRetired(kind, kind.active)}
                      >
                        {kind.active ? "Retire" : "Offer again"}
                      </Button>
                    ) : null}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
      <FileStorage isAdmin={isAdmin} />
    </PageLayout>
  );
}

const GB = 1024 * 1024 * 1024;
const inGb = (bytes: number) =>
  `${(bytes / GB).toLocaleString(undefined, { maximumFractionDigits: 2 })} GB`;

/**
 * What the files attached to notes take, and the limit past which uploads are refused (stage 56
 * step 3, ADR 0834). Shown to people who manage notes; the limit is changed by a human admin.
 */
function FileStorage({ isAdmin }: { isAdmin: boolean }) {
  // Refused to anyone who does not manage notes: the card is then not shown.
  const storage = useOp("file.storage.get", {}, { retry: false });
  const setCap = useOpMutation("file.storage.setCap");
  const [cap, setCapText] = useState("");
  if (!storage.data) return null;
  const { usedBytes, files, capBytes } = storage.data;

  async function submit(event: FormEvent) {
    event.preventDefault();
    try {
      await setCap.mutateAsync({ capBytes: Math.round(Number(cap) * GB) });
      toast.success("Storage limit saved");
      setCapText("");
      await storage.refetch();
    } catch (error) {
      toast.error(errorMessage(error));
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Files</CardTitle>
      </CardHeader>
      <CardContent className="grid gap-3">
        <p className="text-sm" data-testid="file-storage">
          {files.toLocaleString()} {files === 1 ? "file" : "files"} take {inGb(usedBytes)} of{" "}
          {inGb(capBytes)}. Past the limit, uploads are refused; nothing kept is deleted.
        </p>
        {isAdmin ? (
          <form className="flex flex-wrap items-end gap-2" onSubmit={submit}>
            <div className="grid gap-2">
              <Label htmlFor="file-storage-cap">Limit, in GB</Label>
              <Input
                id="file-storage-cap"
                type="number"
                min={1}
                max={10240}
                step={1}
                placeholder={String(Math.round(capBytes / GB))}
                value={cap}
                onChange={(e) => setCapText(e.target.value)}
              />
            </div>
            <Button type="submit" disabled={setCap.isPending || !cap}>
              Save limit
            </Button>
          </form>
        ) : null}
      </CardContent>
    </Card>
  );
}

function LevelSelect({
  id,
  value,
  onChange,
  disabled,
  testId,
}: {
  id: string;
  value: NoteLevel;
  onChange: (level: NoteLevel) => void;
  disabled?: boolean;
  testId: string;
}) {
  return (
    <Select value={value} onValueChange={(v) => onChange(v as NoteLevel)} disabled={disabled}>
      <SelectTrigger id={id} className="w-full" data-testid={testId}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {LEVELS.map((level) => (
          <SelectItem key={level} value={level}>
            {levelWords(level).label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

function KindEditor({ kind, onDone }: { kind: Kind | null; onDone: () => void }) {
  const save = useOpMutation("note.kinds.save");
  const [name, setName] = useState(kind?.name ?? "");
  const [defaultLevel, setDefaultLevel] = useState<NoteLevel>(kind?.defaultLevel ?? "staff");
  const [lowestLevel, setLowestLevel] = useState<NoteLevel>(kind?.lowestLevel ?? "staff");
  const [filesAllowed, setFilesAllowed] = useState(kind?.filesAllowed ?? false);
  const [sections, setSections] = useState<SectionDraft[]>(() =>
    (kind?.sections ?? []).map((s) => ({
      row: nextRow++,
      key: s.key,
      label: s.label,
      hint: s.hint ?? "",
      required: s.required,
    })),
  );
  const fixed = kind?.key === "note";
  const rank = (level: NoteLevel) => LEVELS.indexOf(level);

  const update = (row: number, patch: Partial<SectionDraft>) =>
    setSections((list) => list.map((s) => (s.row === row ? { ...s, ...patch } : s)));
  const move = (index: number, by: number) =>
    setSections((list) => {
      const next = [...list];
      const [section] = next.splice(index, 1);
      if (section) next.splice(index + by, 0, section);
      return next;
    });

  async function submit(event: FormEvent) {
    event.preventDefault();
    try {
      await save.mutateAsync({
        ...(kind ? { id: kind.id } : {}),
        name,
        defaultLevel,
        lowestLevel,
        filesAllowed,
        sections: sections
          .filter((s) => s.label.trim())
          .map((s) => ({
            ...(s.key ? { key: s.key } : {}),
            label: s.label,
            hint: s.hint.trim() || null,
            required: s.required,
          })),
      });
      toast.success(kind ? "Kind of note saved" : "Kind of note added");
      onDone();
    } catch (error) {
      toast.error(errorMessage(error));
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>{kind ? `Edit ${kind.name}` : "New kind of note"}</CardTitle>
      </CardHeader>
      <CardContent>
        <form className="grid gap-4" onSubmit={submit} data-testid="note-kind-editor">
          <div className="grid gap-2">
            <Label htmlFor="note-kind-name">Name</Label>
            <Input
              id="note-kind-name"
              value={name}
              maxLength={80}
              required
              onChange={(e) => setName(e.target.value)}
            />
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="grid gap-2">
              <Label htmlFor="note-kind-default">Who reads a new one</Label>
              <LevelSelect
                id="note-kind-default"
                testId="note-kind-default"
                value={defaultLevel}
                disabled={fixed}
                onChange={(level) => {
                  setDefaultLevel(level);
                  if (rank(level) < rank(lowestLevel)) setLowestLevel(level);
                }}
              />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="note-kind-lowest">Never below</Label>
              <LevelSelect
                id="note-kind-lowest"
                testId="note-kind-lowest"
                value={lowestLevel}
                disabled={fixed}
                onChange={(level) => {
                  setLowestLevel(level);
                  if (rank(level) > rank(defaultLevel)) setDefaultLevel(level);
                }}
              />
            </div>
          </div>
          <p className="text-muted-foreground text-sm">
            {fixed
              ? "Note is the kind of every note written without one, so everyone on the staff reads it and none of its sections is required. Add a kind of your own for notes kept tighter."
              : `${levelWords(defaultLevel).hint} A change applies to notes written from now on.`}
          </p>
          <Label className="font-normal">
            <Checkbox
              checked={filesAllowed}
              onCheckedChange={(checked) => setFilesAllowed(checked === true)}
              data-testid="note-kind-files"
            />
            Photos and PDFs may be attached to a note of this kind
          </Label>

          <fieldset className="grid gap-3">
            <legend className="mb-1 text-sm font-medium">Template</legend>
            <p className="text-muted-foreground text-sm">
              The sections a person fills in. With none, a note of this kind is written freely.
            </p>
            {sections.map((section, index) => (
              <div
                key={section.row}
                className="grid gap-2 rounded-md border p-3"
                data-testid="note-kind-section"
              >
                <div className="flex items-center gap-2">
                  <Input
                    aria-label={`Section ${index + 1} label`}
                    placeholder="Label, such as How it went"
                    value={section.label}
                    maxLength={80}
                    onChange={(e) => update(section.row, { label: e.target.value })}
                  />
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    aria-label="Move up"
                    disabled={index === 0}
                    onClick={() => move(index, -1)}
                  >
                    <ArrowUpIcon className="size-4" />
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    aria-label="Move down"
                    disabled={index === sections.length - 1}
                    onClick={() => move(index, 1)}
                  >
                    <ArrowDownIcon className="size-4" />
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    aria-label="Remove section"
                    onClick={() => setSections((list) => list.filter((s) => s.row !== section.row))}
                  >
                    <Trash2Icon className="size-4" />
                  </Button>
                </div>
                <Input
                  aria-label={`Section ${index + 1} hint`}
                  placeholder="A prompt under the label (optional)"
                  value={section.hint}
                  maxLength={200}
                  onChange={(e) => update(section.row, { hint: e.target.value })}
                />
                <Label className="font-normal">
                  <Checkbox
                    checked={section.required}
                    // Note is the kind of a note written without one, which has a body only.
                    disabled={fixed}
                    onCheckedChange={(checked) =>
                      update(section.row, { required: checked === true })
                    }
                  />
                  Must be filled in
                </Label>
              </div>
            ))}
            <Button
              type="button"
              variant="outline"
              className="w-fit"
              disabled={sections.length >= MAX_SECTIONS}
              onClick={() => setSections((list) => [...list, blankSection()])}
              data-testid="note-kind-add-section"
            >
              <PlusIcon className="size-4" /> Add a section
            </Button>
          </fieldset>

          <div className="flex gap-2">
            <Button type="submit" disabled={save.isPending || !name.trim()}>
              {save.isPending ? "Saving…" : "Save"}
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
