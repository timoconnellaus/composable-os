// The publish controls (stage 28, step 5; ADRs 0446, 0441, 0443) on a publishable record's page:
// where it is (draft, scheduled, published, unpublished), publish now, schedule, cancel, take it
// down; its versions, what changed since one, restoring one into the working copy; and, for
// content the public reads, preview links to make, list and stop. On an object staff confirm they
// have read (ADR 0702), a publish after the first asks the person to choose: everyone confirms
// again, or a small fix that keeps their confirmations.
//
// Every button is an operation and the host decides it: a member without the publish permission
// is refused by the host and told so, and an AI actor never publishes (ADR 0446).
import { Badge } from "@composable-os/ui/components/badge";
import { Button } from "@composable-os/ui/components/button";
import { Card, CardContent, CardHeader, CardTitle } from "@composable-os/ui/components/card";
import { Input } from "@composable-os/ui/components/input";
import { Label } from "@composable-os/ui/components/label";
import { useState } from "react";
import { toast } from "sonner";
import { formatDateTime } from "#/lib/format";
import { errorMessage, useOp, useOpMutation } from "#/lib/query";

const STATE_LABEL: Record<string, string> = {
  draft: "Draft",
  scheduled: "Scheduled",
  published: "Published",
  unpublished: "Unpublished",
};

function toLocalInput(iso: string): string {
  const at = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}T${pad(at.getHours())}:${pad(at.getMinutes())}`;
}

export function PublishCard({
  object,
  id,
  values,
  slugField,
  hasPreview,
  acknowledged = false,
}: {
  object: string;
  id: string;
  values: Record<string, unknown>;
  slugField: string | null;
  /** Whether the public reads it: then a preview link shows its working copy. */
  hasPreview: boolean;
  /** Whether staff confirm they have read it: then a later version asks "read again?". */
  acknowledged?: boolean;
}) {
  const invalidates = ["record.", "content."];
  const publish = useOpMutation("record.publish", { invalidates });
  const schedule = useOpMutation("record.schedulePublish", { invalidates });
  const cancel = useOpMutation("record.cancelSchedule", { invalidates });
  const unpublish = useOpMutation("record.unpublish", { invalidates });
  const restore = useOpMutation("record.restoreVersion", { invalidates });
  const versions = useOp("record.versions", { object, id });
  const [at, setAt] = useState(() => toLocalInput(new Date(Date.now() + 3_600_000).toISOString()));
  const [compareWith, setCompareWith] = useState<number | null>(null);
  const [readAgain, setReadAgain] = useState<boolean | null>(null);
  const compare = useOp(
    "record.compareVersions",
    { object, id, from: compareWith ?? 1 },
    { enabled: compareWith !== null },
  );

  const state = String(values.publishState ?? "draft");
  const publishAt = typeof values.publishAt === "string" ? values.publishAt : null;
  const live = typeof values.publishedVersion === "number" ? values.publishedVersion : null;
  // The first version always asks; a later one needs the person's choice (ADR 0702).
  const asks = acknowledged && Boolean(versions.data?.items.length);
  const waiting = asks && readAgain === null;
  const choice = asks && readAgain !== null ? { readAgain } : {};

  async function run(what: string, call: () => Promise<unknown>) {
    try {
      await call();
      toast.success(what);
    } catch (error) {
      toast.error(errorMessage(error));
    }
  }

  return (
    <Card data-testid="publish-card">
      <CardHeader className="flex flex-row items-center justify-between gap-2">
        <CardTitle className="text-base">Publishing</CardTitle>
        <Badge
          variant={state === "published" ? "default" : "secondary"}
          data-testid="publish-state"
        >
          {STATE_LABEL[state] ?? state}
        </Badge>
      </CardHeader>
      <CardContent className="grid gap-4 text-sm">
        <p className="text-muted-foreground">
          {live !== null
            ? `Readers see version ${live}${values.publishedAt ? `, published ${formatDateTime(String(values.publishedAt))}` : ""}. Edits wait for the next publish.`
            : "Readers see nothing yet. Edits here are the working copy."}
          {publishAt ? ` Scheduled for ${formatDateTime(publishAt)}.` : ""}
        </p>
        {asks ? (
          <fieldset className="grid gap-1.5" data-testid="read-again">
            <legend className="font-medium">Does this change ask everyone to confirm again?</legend>
            <div className="flex flex-wrap gap-2">
              {[
                { value: true, label: "Yes: everyone confirms again" },
                { value: false, label: "Small fix: keep their confirmations" },
              ].map((o) => (
                <Button
                  key={String(o.value)}
                  type="button"
                  size="sm"
                  variant={readAgain === o.value ? "default" : "outline"}
                  aria-pressed={readAgain === o.value}
                  onClick={() => setReadAgain(o.value)}
                >
                  {o.label}
                </Button>
              ))}
            </div>
          </fieldset>
        ) : null}
        <div className="flex flex-wrap gap-2">
          <Button
            onClick={() =>
              run("Published", async () => {
                await publish.mutateAsync({ object, id, ...choice });
                setReadAgain(null);
              })
            }
            disabled={publish.isPending || waiting}
          >
            Publish now
          </Button>
          {live !== null ? (
            <Button
              variant="outline"
              onClick={() => run("Unpublished", () => unpublish.mutateAsync({ object, id }))}
              disabled={unpublish.isPending}
            >
              Unpublish
            </Button>
          ) : null}
        </div>
        <form
          className="grid gap-1.5"
          onSubmit={(event) => {
            event.preventDefault();
            void run("Scheduled", () =>
              schedule.mutateAsync({ object, id, at: new Date(at).toISOString(), ...choice }),
            );
          }}
        >
          <Label htmlFor="publish-at">Publish at</Label>
          <div className="flex gap-2">
            <Input
              id="publish-at"
              type="datetime-local"
              value={at}
              onChange={(e) => setAt(e.target.value)}
            />
            <Button type="submit" variant="outline" disabled={schedule.isPending || waiting}>
              Schedule
            </Button>
          </div>
          {publishAt ? (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="justify-self-start"
              onClick={() => run("Schedule cancelled", () => cancel.mutateAsync({ object, id }))}
            >
              Cancel the schedule
            </Button>
          ) : null}
        </form>
        <div className="grid gap-2">
          <h3 className="font-medium">Versions</h3>
          {versions.data?.items.length ? (
            <ul className="grid gap-2" data-testid="versions">
              {versions.data.items.map((v) => (
                <li key={v.version} className="grid gap-1 rounded border p-2">
                  <div className="flex items-center justify-between gap-2">
                    <span>
                      Version {v.version}
                      {v.current ? " (live)" : ""} · {formatDateTime(v.publishedAt)}
                      {v.readAgain === true ? " · asked everyone again" : ""}
                      {v.readAgain === false ? " · small fix" : ""}
                    </span>
                    <span className="flex gap-1">
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => setCompareWith(compareWith === v.version ? null : v.version)}
                      >
                        {compareWith === v.version ? "Hide changes" : "Changes since"}
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() =>
                          run(`Version ${v.version} restored to the working copy`, () =>
                            restore.mutateAsync({ object, id, version: v.version }),
                          )
                        }
                      >
                        Restore
                      </Button>
                    </span>
                  </div>
                  {v.note ? <p className="text-muted-foreground">{v.note}</p> : null}
                  {compareWith === v.version && compare.data ? (
                    compare.data.changes.length ? (
                      <ul className="grid gap-1" data-testid="version-changes">
                        {compare.data.changes.map((c) => (
                          <li key={c.field}>
                            <span className="font-medium">{c.field}</span> changed since version{" "}
                            {v.version}
                          </li>
                        ))}
                      </ul>
                    ) : (
                      <p className="text-muted-foreground">The working copy is the same.</p>
                    )
                  ) : null}
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-muted-foreground">Not published yet.</p>
          )}
        </div>
        {hasPreview ? (
          <PreviewLinks object={object} id={id} slug={slugField ? values[slugField] : null} />
        ) : null}
      </CardContent>
    </Card>
  );
}

function PreviewLinks({ object, id, slug }: { object: string; id: string; slug: unknown }) {
  const links = useOp("content.previewLinks", { object, id });
  const make = useOpMutation("content.previewLink", { invalidates: ["content."] });
  const revoke = useOpMutation("content.revokePreview", { invalidates: ["content."] });
  const [made, setMade] = useState<{ token: string; expiresAt: string } | null>(null);
  const address = (token: string) =>
    `${typeof slug === "string" ? slug : "<address>"}?preview=${encodeURIComponent(token)}`;
  return (
    <div className="grid gap-2" data-testid="preview-links">
      <h3 className="font-medium">Preview links</h3>
      <p className="text-muted-foreground">
        A link shows the working copy to anyone who has it, until it ends.
      </p>
      <Button
        variant="outline"
        className="justify-self-start"
        onClick={async () => {
          try {
            setMade(await make.mutateAsync({ object, id }));
          } catch (error) {
            toast.error(errorMessage(error));
          }
        }}
      >
        Make a preview link
      </Button>
      {made ? (
        <div className="grid gap-1 rounded border p-2" data-testid="preview-made">
          <span>Shown once. Until {formatDateTime(made.expiresAt)}:</span>
          <code className="break-all">{address(made.token)}</code>
        </div>
      ) : null}
      <ul className="grid gap-1">
        {(links.data?.items ?? []).map((link) => (
          <li key={link.id} className="flex items-center justify-between gap-2">
            <span>Until {formatDateTime(link.expiresAt)}</span>
            <Button
              variant="ghost"
              size="sm"
              onClick={async () => {
                try {
                  await revoke.mutateAsync({ object, id, link: link.id });
                  toast.success("Link stopped");
                } catch (error) {
                  toast.error(errorMessage(error));
                }
              }}
            >
              Stop
            </Button>
          </li>
        ))}
      </ul>
    </div>
  );
}
