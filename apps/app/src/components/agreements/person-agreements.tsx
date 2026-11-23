// The Person page's Agreements tab (stage 44 step 2, ADRs 0642 and 0643): each document attached
// anywhere, current or due and why; every acceptance (paper shown as recorded from paper by a
// staff member, never as the member's own); a typed name and a drawn signature opened one at a
// time; a health form's answers behind "Show answers" for staff with agreements:health (each read
// audited by the host); Record paper; and the minor mark. The host decides every one of these:
// what the buttons show only follows what agreement.person says the caller may do.
import { Badge } from "@composable-os/ui/components/badge";
import { Button } from "@composable-os/ui/components/button";
import { Card, CardContent, CardHeader, CardTitle } from "@composable-os/ui/components/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@composable-os/ui/components/dialog";
import { Input } from "@composable-os/ui/components/input";
import { Label } from "@composable-os/ui/components/label";
import { Skeleton } from "@composable-os/ui/components/skeleton";
import { Switch } from "@composable-os/ui/components/switch";
import { Textarea } from "@composable-os/ui/components/textarea";
import { type FormEvent, useState } from "react";
import { toast } from "sonner";
import { formatDate, formatDateTime } from "#/lib/format";
import { errorMessage, useOp, useOpMutation } from "#/lib/query";

const REASONS: Record<string, string> = {
  never: "not agreed yet",
  agree_again: "a new version asks everyone to agree again",
  ask_again: "asked again after its months",
  guardian: "a parent or guardian must agree for them",
};

const BY: Record<string, string> = {
  self: "Agreed by themselves",
  guardian: "Agreed by a parent or guardian",
  guest: "Agreed with an order",
  paper: "Recorded from paper",
};

type Acceptance = {
  id: string;
  title: string;
  versionNumber: number;
  by: string;
  how: string;
  channel: string;
  acceptedAt: string;
  counts: boolean;
  agentName: string | null;
  recordedByName: string | null;
  signedOn: string | null;
  kind: string;
};

/** How an acceptance was made, as every screen says it. Paper is never "their own". */
export function acceptanceLine(a: Acceptance): string {
  if (a.by === "paper") {
    return `Recorded from paper by ${a.recordedByName ?? "staff"} on ${formatDate(a.acceptedAt)}; signed on ${a.signedOn ?? "?"}`;
  }
  if (a.by === "guardian") {
    return `Agreed by ${a.agentName ?? "a parent or guardian"} for them, ${formatDateTime(a.acceptedAt)} (${a.how === "drawn" ? "signed" : "typed name"}, ${a.channel})`;
  }
  return `${BY[a.by] ?? a.by}, ${formatDateTime(a.acceptedAt)} (${a.how === "drawn" ? "signed" : "typed name"}, ${a.channel})`;
}

export function PersonAgreements({
  personId,
  personName,
  readOnly,
}: {
  personId: string;
  personName: string;
  readOnly: boolean;
}) {
  const data = useOp("agreement.person", { personId });
  const [open, setOpen] = useState<string | null>(null);
  const [paper, setPaper] = useState<{ versionId: string; title: string; kind: string } | null>(
    null,
  );
  if (data.isPending) return <Skeleton className="h-32 w-full" />;
  if (data.isError) return <p className="text-destructive text-sm">{errorMessage(data.error)}</p>;
  const { documents, acceptances, minor, can, healthNote } = data.data;
  return (
    <div className="grid gap-4" data-testid="person-agreements">
      <MinorCard personId={personId} minor={minor} canSet={can.setMinor && !readOnly} />
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            Documents
            {healthNote && (
              <Badge variant="destructive" data-testid="person-health-note">
                Health note
              </Badge>
            )}
          </CardTitle>
        </CardHeader>
        <CardContent>
          {documents.length ? (
            <ul className="divide-y" data-testid="agreement-documents">
              {documents.map((doc) => (
                <li key={doc.documentId} className="flex flex-wrap items-center gap-2 py-2">
                  <span className="font-medium">{doc.title}</span>
                  <span className="text-muted-foreground text-sm">version {doc.versionNumber}</span>
                  {doc.status === "current" ? (
                    <Badge>Agreed</Badge>
                  ) : (
                    <Badge variant="outline">Due: {REASONS[doc.reason ?? "never"]}</Badge>
                  )}
                  {can.recordPaper && !readOnly && (
                    <Button
                      size="sm"
                      variant="ghost"
                      className="ml-auto"
                      onClick={() =>
                        setPaper({ versionId: doc.versionId, title: doc.title, kind: doc.kind })
                      }
                    >
                      Record paper
                    </Button>
                  )}
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-muted-foreground text-sm">No document is needed anywhere yet.</p>
          )}
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>History</CardTitle>
        </CardHeader>
        <CardContent>
          {acceptances.length ? (
            <ul className="divide-y" data-testid="agreement-history">
              {acceptances.map((a) => (
                <li key={a.id} className="grid gap-1 py-2">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-medium">
                      {a.title}, version {a.versionNumber}
                    </span>
                    {a.counts && <Badge variant="secondary">counts now</Badge>}
                    <Button
                      size="sm"
                      variant="ghost"
                      className="ml-auto"
                      onClick={() => setOpen(a.id)}
                    >
                      Open
                    </Button>
                  </div>
                  <span className="text-muted-foreground text-sm">{acceptanceLine(a)}</span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-muted-foreground text-sm">Nothing agreed yet.</p>
          )}
        </CardContent>
      </Card>
      {open && (
        <AcceptanceDialog
          id={open}
          personName={personName}
          canReadAnswers={can.readAnswers}
          onClose={() => setOpen(null)}
        />
      )}
      {paper && (
        <PaperDialog
          personId={personId}
          personName={personName}
          version={paper}
          onClose={() => setPaper(null)}
        />
      )}
    </div>
  );
}

function MinorCard({
  personId,
  minor,
  canSet,
}: {
  personId: string;
  minor: { marked: boolean; dependant: boolean; markedBy: string | null; markedAt: string | null };
  canSet: boolean;
}) {
  const set = useOpMutation("agreement.setMinor", { invalidates: ["agreement.person"] });
  async function toggle(next: boolean) {
    try {
      await set.mutateAsync({ personId, minor: next });
      toast.success(next ? "Marked as a minor" : "No longer marked as a minor");
    } catch (error) {
      toast.error(errorMessage(error));
    }
  }
  return (
    <Card>
      <CardContent className="flex flex-wrap items-center gap-3 pt-6">
        <Switch
          id="minor-mark"
          checked={minor.marked}
          disabled={!canSet || set.isPending}
          onCheckedChange={(v) => void toggle(v)}
        />
        <Label htmlFor="minor-mark">A minor: a parent or guardian agrees for them</Label>
        <span className="text-muted-foreground w-full text-sm" data-testid="minor-state">
          {minor.dependant
            ? "A child of a family link: only a parent or guardian, or a paper form, counts."
            : minor.marked
              ? `Marked by ${minor.markedBy ?? "staff"} on ${formatDate(minor.markedAt)}. Until a parent or guardian is linked, or paper is recorded, nothing can be bought or booked for them.`
              : "Treated as an adult. The host holds no date of birth."}
        </span>
      </CardContent>
    </Card>
  );
}

/** A drawn signature, from its strokes. */
function SignatureSvg({ strokes }: { strokes: number[][][] }) {
  return (
    <svg
      viewBox="0 0 1000 400"
      className="h-24 w-60 rounded border bg-white"
      role="img"
      aria-label="Signature"
    >
      {strokes.map((stroke, i) => (
        <polyline
          // biome-ignore lint/suspicious/noArrayIndexKey: strokes never reorder.
          key={i}
          points={stroke.map(([x, y]) => `${x},${y}`).join(" ")}
          fill="none"
          stroke="currentColor"
          strokeWidth={4}
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      ))}
    </svg>
  );
}

function AcceptanceDialog({
  id,
  personName,
  canReadAnswers,
  onClose,
}: {
  id: string;
  personName: string;
  canReadAnswers: boolean;
  onClose: () => void;
}) {
  const one = useOp("agreement.acceptance.get", { id });
  const [show, setShow] = useState(false);
  return (
    <Dialog open onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>
            {one.data ? `${one.data.title}, version ${one.data.versionNumber}` : "Acceptance"}
          </DialogTitle>
          <DialogDescription>
            {one.data ? acceptanceLine({ ...one.data, agentName: one.data.agentName }) : ""}
          </DialogDescription>
        </DialogHeader>
        {one.isPending ? (
          <Skeleton className="h-20 w-full" />
        ) : one.isError ? (
          <p className="text-destructive text-sm">{errorMessage(one.error)}</p>
        ) : (
          <div className="grid gap-2 text-sm" data-testid="acceptance-detail">
            <p>
              Name {one.data.by === "paper" ? "on the form" : "typed"}:{" "}
              <strong>{one.data.typedName ?? "(erased with the guardian who typed it)"}</strong>
              {one.data.typedName &&
                one.data.typedName.trim().toLowerCase() !== personName.trim().toLowerCase() && (
                  <span className="text-muted-foreground"> (their record says {personName})</span>
                )}
            </p>
            {one.data.signedBy && <p>Signed by: {one.data.signedBy}</p>}
            {one.data.note && <p>Note: {one.data.note}</p>}
            {one.data.signature && <SignatureSvg strokes={one.data.signature.strokes} />}
            {one.data.hasAnswers &&
              (canReadAnswers ? (
                show ? (
                  <Answers acceptanceId={id} />
                ) : (
                  <Button
                    variant="outline"
                    size="sm"
                    className="w-fit"
                    onClick={() => setShow(true)}
                  >
                    Show answers
                  </Button>
                )
              ) : (
                <p className="text-muted-foreground">
                  Health answers are shown only to staff who may read them.
                </p>
              ))}
          </div>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Close
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function Answers({ acceptanceId }: { acceptanceId: string }) {
  // Each read is audited by the host (who read whose answers), so this asks once, on a click.
  const read = useOp(
    "agreement.answers.get",
    { acceptanceId },
    { staleTime: Number.POSITIVE_INFINITY },
  );
  if (read.isPending) return <Skeleton className="h-16 w-full" />;
  if (read.isError) return <p className="text-destructive">{errorMessage(read.error)}</p>;
  return (
    <ul className="grid gap-1" data-testid="health-answers">
      {read.data.enteredByStaff && (
        <li className="text-muted-foreground">Typed in by staff from a paper form.</li>
      )}
      {read.data.answers.map((a) => (
        <li key={a.key}>
          {a.text} <strong>{a.yes ? "Yes" : "No"}</strong>
          {a.note ? `: ${a.note}` : ""}
        </li>
      ))}
    </ul>
  );
}

function PaperDialog({
  personId,
  personName,
  version,
  onClose,
}: {
  personId: string;
  personName: string;
  version: { versionId: string; title: string; kind: string };
  onClose: () => void;
}) {
  const record = useOpMutation("agreement.recordPaper", { invalidates: ["agreement.person"] });
  const [name, setName] = useState(personName);
  const [signedOn, setSignedOn] = useState(new Date().toISOString().slice(0, 10));
  const [signedBy, setSignedBy] = useState("");
  const [note, setNote] = useState("");
  async function submit(event: FormEvent) {
    event.preventDefault();
    try {
      await record.mutateAsync({
        personId,
        versionId: version.versionId,
        signedOn,
        typedName: name,
        ...(signedBy.trim() ? { signedBy: signedBy.trim() } : {}),
        ...(note.trim() ? { note: note.trim() } : {}),
      });
      toast.success("Paper form recorded");
      onClose();
    } catch (error) {
      toast.error(errorMessage(error));
    }
  }
  return (
    <Dialog open onOpenChange={(v) => !v && onClose()}>
      <DialogContent>
        <form onSubmit={submit} className="grid gap-3">
          <DialogHeader>
            <DialogTitle>Record a paper form: {version.title}</DialogTitle>
            <DialogDescription>
              It shows as recorded from paper by you, never as their own acceptance.
              {version.kind === "health" &&
                " A paper health form's answers stay on the paper unless typed in elsewhere."}
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-1">
            <Label htmlFor="paper-name">Name on the form</Label>
            <Input
              id="paper-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              required
            />
          </div>
          <div className="grid gap-1">
            <Label htmlFor="paper-date">Date on the form</Label>
            <Input
              id="paper-date"
              type="date"
              value={signedOn}
              onChange={(e) => setSignedOn(e.target.value)}
              required
            />
          </div>
          <div className="grid gap-1">
            <Label htmlFor="paper-by">Signed by (for a child)</Label>
            <Input id="paper-by" value={signedBy} onChange={(e) => setSignedBy(e.target.value)} />
          </div>
          <div className="grid gap-1">
            <Label htmlFor="paper-note">Note</Label>
            <Textarea id="paper-note" value={note} onChange={(e) => setNote(e.target.value)} />
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={record.isPending}>
              Record paper form
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
