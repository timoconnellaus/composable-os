// A Person's family links (stage 31a step 6, ADR 0540): the guardians who may book for them and
// the dependants (children) they may book for. Staff with people:link add a link and end one, a
// person only: the host refuses anyone else, and says so here.
import type { CoreOutput } from "@composable-os/core";
import { Badge } from "@composable-os/ui/components/badge";
import { Button } from "@composable-os/ui/components/button";
import {
  Card,
  CardAction,
  CardContent,
  CardHeader,
  CardTitle,
} from "@composable-os/ui/components/card";
import { Skeleton } from "@composable-os/ui/components/skeleton";
import { PlusIcon, UsersIcon } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { RecordPicker } from "#/components/record-picker";
import { errorMessage, useOp, useOpMutation } from "#/lib/query";
import { RecordLink } from "./timeline.tsx";

type Link = CoreOutput<"person.link.list">["items"][number];

export function FamilyCard({
  personId,
  personName,
  readOnly = false,
}: {
  personId: string;
  personName: string;
  readOnly?: boolean;
}) {
  const links = useOp("person.link.list", { personId });
  const add = useOpMutation("person.link.add", { invalidates: ["person.link."] });
  const end = useOpMutation("person.link.end", { invalidates: ["person.link."] });
  const [adding, setAdding] = useState(false);
  const [role, setRole] = useState<"guardian" | "dependant">("dependant");
  const [other, setOther] = useState<{ id: string; name: string } | null>(null);

  const guardians = (links.data?.items ?? []).filter((l) => l.dependant.id === personId);
  const dependants = (links.data?.items ?? []).filter((l) => l.guardian.id === personId);

  async function save() {
    if (!other) return;
    try {
      await add.mutateAsync(
        role === "dependant"
          ? { guardianId: personId, dependantId: other.id }
          : { guardianId: other.id, dependantId: personId },
      );
      toast.success(
        role === "dependant"
          ? `${personName} can now book for ${other.name}`
          : `${other.name} can now book for ${personName}`,
      );
      setAdding(false);
      setOther(null);
    } catch (error) {
      toast.error(errorMessage(error));
    }
  }

  async function stop(link: Link) {
    try {
      const done = await end.mutateAsync({ id: link.id });
      // What they made for the child stays: say so, so staff can cancel any that should not.
      const stays = done.stays.map((s) => `${s.count} ${s.label.toLowerCase()}`).join(", ");
      toast.success(
        `${link.guardian.name ?? "The guardian"} can no longer book for ${link.dependant.name ?? "them"}`,
        stays ? { description: `What they made for them stays: ${stays}.` } : undefined,
      );
    } catch (error) {
      toast.error(errorMessage(error));
    }
  }

  const row = (link: Link, shown: Link["guardian"], label: string) => (
    <li key={link.id} className="flex items-center gap-2 text-sm">
      <UsersIcon className="size-4 shrink-0 text-muted-foreground" aria-hidden />
      <span className="flex min-w-0 flex-1 items-center gap-2 truncate">
        <RecordLink object="person" id={shown.id}>
          {shown.name ?? shown.id}
        </RecordLink>
        <Badge variant="secondary">{label}</Badge>
      </span>
      {!readOnly && (
        <Button
          variant="ghost"
          size="xs"
          disabled={end.isPending}
          aria-label={`End the link with ${shown.name ?? "them"}`}
          onClick={() => stop(link)}
        >
          End
        </Button>
      )}
    </li>
  );

  return (
    <Card className="gap-3 py-4" data-testid="family-card">
      <CardHeader className="px-4">
        <CardTitle className="text-sm">Family</CardTitle>
        {!readOnly && !adding && (
          <CardAction>
            <Button
              variant="ghost"
              size="icon-xs"
              aria-label="Add a family link"
              onClick={() => setAdding(true)}
            >
              <PlusIcon />
            </Button>
          </CardAction>
        )}
      </CardHeader>
      <CardContent className="grid gap-2 px-4">
        {links.isPending ? (
          <Skeleton className="h-8" />
        ) : links.error ? (
          <p className="text-sm text-destructive">{errorMessage(links.error)}</p>
        ) : guardians.length + dependants.length === 0 && !adding ? (
          <p className="text-sm text-muted-foreground">
            No parent or child linked. A linked parent books classes for their child.
          </p>
        ) : (
          <ul className="grid gap-1">
            {guardians.map((l) => row(l, l.guardian, "Parent or guardian"))}
            {dependants.map((l) => row(l, l.dependant, "Child"))}
          </ul>
        )}
        {adding && (
          <div className="grid gap-2 rounded-md border p-2 text-sm">
            <label className="grid gap-1">
              <span className="text-muted-foreground">{personName} is</span>
              <select
                className="rounded-md border bg-background p-1.5"
                value={role}
                onChange={(event) => setRole(event.target.value as "guardian" | "dependant")}
              >
                <option value="dependant">the parent or guardian of</option>
                <option value="guardian">the child of</option>
              </select>
            </label>
            <RecordPicker
              object="person"
              value={other}
              onChange={setOther}
              exclude={[personId]}
              placeholder="Choose a person"
              label="Family member"
            />
            <div className="flex justify-end gap-2">
              <Button variant="ghost" size="sm" onClick={() => setAdding(false)}>
                Cancel
              </Button>
              <Button size="sm" disabled={!other || add.isPending} onClick={save}>
                Link
              </Button>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
