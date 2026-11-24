// Who looks after a Person (stage 56, ADR 0831): the staff accounts, a client's coaches, that read
// the Person's notes kept to their coaches. Chosen here, never worked out from bookings. Staff with
// people:link set it and end it, a person only, and nobody sets themselves: the host refuses
// anyone else, and says so here. Ending it takes effect on the next read.
import type { CoreOutput } from "@composable-os/core";
import { Button } from "@composable-os/ui/components/button";
import {
  Card,
  CardAction,
  CardContent,
  CardHeader,
  CardTitle,
} from "@composable-os/ui/components/card";
import { Skeleton } from "@composable-os/ui/components/skeleton";
import { PlusIcon, UserRoundCheckIcon } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { errorMessage, useOp, useOpMutation } from "#/lib/query";
import { useUsers } from "#/lib/users-adapter";

type Carer = CoreOutput<"carer.list">["items"][number];

export function CarersCard({
  personId,
  personName,
  readOnly = false,
}: {
  personId: string;
  personName: string;
  readOnly?: boolean;
}) {
  const carers = useOp("carer.list", { personId });
  const set = useOpMutation("carer.set");
  const end = useOpMutation("carer.end");
  const users = useUsers();
  const [adding, setAdding] = useState(false);
  const [userId, setUserId] = useState("");
  const items = carers.data?.items ?? [];
  const choices = users.filter((u) => !items.some((c) => c.user.id === u.id));

  async function save() {
    if (!userId) return;
    try {
      const made = await set.mutateAsync({ personId, userId });
      toast.success(`${made.user.name ?? "They"} now look after ${personName}`);
      setAdding(false);
      setUserId("");
    } catch (error) {
      toast.error(errorMessage(error));
    }
  }

  async function stop(carer: Carer) {
    try {
      await end.mutateAsync({ id: carer.id });
      toast.success(`${carer.user.name ?? "They"} no longer look after ${personName}`);
    } catch (error) {
      toast.error(errorMessage(error));
    }
  }

  return (
    <Card className="gap-3 py-4" data-testid="carers-card">
      <CardHeader className="px-4">
        <CardTitle className="text-sm">Looks after</CardTitle>
        {!readOnly && !adding && (
          <CardAction>
            <Button
              variant="ghost"
              size="icon-xs"
              aria-label="Add someone who looks after them"
              onClick={() => setAdding(true)}
            >
              <PlusIcon />
            </Button>
          </CardAction>
        )}
      </CardHeader>
      <CardContent className="grid gap-2 px-4">
        {carers.isPending ? (
          <Skeleton className="h-8" />
        ) : carers.error ? (
          <p className="text-sm text-destructive">{errorMessage(carers.error)}</p>
        ) : items.length === 0 && !adding ? (
          <p className="text-sm text-muted-foreground">
            No one yet. Who looks after {personName} reads the notes kept to their coaches.
          </p>
        ) : (
          <ul className="grid gap-1">
            {items.map((carer) => (
              <li key={carer.id} className="flex items-center gap-2 text-sm">
                <UserRoundCheckIcon className="size-4 shrink-0 text-muted-foreground" aria-hidden />
                <span className="min-w-0 flex-1 truncate">{carer.user.name ?? carer.user.id}</span>
                {!readOnly && (
                  <Button
                    variant="ghost"
                    size="xs"
                    disabled={end.isPending}
                    aria-label={`${carer.user.name ?? "They"} no longer look after them`}
                    onClick={() => stop(carer)}
                  >
                    End
                  </Button>
                )}
              </li>
            ))}
          </ul>
        )}
        {adding && (
          <div className="grid gap-2 rounded-md border p-2 text-sm">
            <label className="grid gap-1">
              <span className="text-muted-foreground">Staff account</span>
              <select
                className="rounded-md border bg-background p-1.5"
                value={userId}
                onChange={(event) => setUserId(event.target.value)}
                data-testid="carer-user"
              >
                <option value="">Choose someone</option>
                {choices.map((u) => (
                  <option key={u.id} value={u.id}>
                    {u.name}
                  </option>
                ))}
              </select>
            </label>
            <div className="flex justify-end gap-2">
              <Button variant="ghost" size="sm" onClick={() => setAdding(false)}>
                Cancel
              </Button>
              <Button size="sm" disabled={!userId || set.isPending} onClick={save}>
                Add
              </Button>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
