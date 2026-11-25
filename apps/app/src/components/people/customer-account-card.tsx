// A Person's customer account (stage 22, ADR 0402; stage 48): whether they can sign in to a client
// app, and when they last did; a change of their sign-in address waiting for their code (the new
// address shown only in part) and an open erase request with its due date, from customer.list,
// which only admins may call, so the card shows only for admins. Its buttons are the admins' own
// operations: disable and enable, sign out everywhere, and start or cancel a change of the
// sign-in address (ADR 0712). Starting one emails a code to the new address; only the member,
// entering it, finishes the change, and the code is never shown here. Every button calls the
// operation and shows the host's refusal: nothing a permission decides is hidden here.
// While it loads, the card holds its place with a placeholder: it sits above the Family card, and
// a card arriving late pushed the family picker, open, off the screen (#264).
import { Badge } from "@composable-os/ui/components/badge";
import { Button } from "@composable-os/ui/components/button";
import { Card, CardContent, CardHeader, CardTitle } from "@composable-os/ui/components/card";
import { Input } from "@composable-os/ui/components/input";
import { Label } from "@composable-os/ui/components/label";
import { Skeleton } from "@composable-os/ui/components/skeleton";
import { type FormEvent, useState } from "react";
import { toast } from "sonner";
import { formatDate, formatDateTime } from "#/lib/format";
import { errorMessage, useOp, useOpMutation } from "#/lib/query";

export function CustomerAccountCard({ personId }: { personId: string }) {
  const accounts = useOp("customer.list", { personId, limit: 1 }, { staleTime: 30_000 });
  if (accounts.error) return null;
  const account = accounts.isPending ? undefined : accounts.data.items[0];
  return (
    <Card className="gap-3 py-4" data-testid="customer-account">
      <CardHeader className="px-4">
        <CardTitle className="text-sm">Customer account</CardTitle>
      </CardHeader>
      <CardContent className="grid gap-2 px-4 text-sm">
        {accounts.isPending ? (
          <Skeleton className="h-5" data-testid="customer-account-loading" />
        ) : account ? (
          <>
            <div className="flex flex-wrap items-center gap-2">
              <span className="truncate">{account.email}</span>
              <Badge variant={account.status === "active" ? "outline" : "destructive"}>
                {account.status}
              </Badge>
              {account.linkState === "needs_merge" && <Badge variant="outline">needs merge</Badge>}
            </div>
            <p className="text-muted-foreground">
              {account.lastSignInAt
                ? `Last signed in ${formatDateTime(account.lastSignInAt)}`
                : "Never signed in"}
            </p>
            {account.emailChange ? (
              <p data-testid="customer-email-change">
                {account.emailChange.expired
                  ? `A change of the sign-in address to ${account.emailChange.newEmail} was not confirmed in time.`
                  : `Changing the sign-in address to ${account.emailChange.newEmail}: waiting for the member to enter the code sent there, until ${formatDateTime(account.emailChange.expiresAt)}${account.emailChange.startedBy === "staff" ? " (started by staff)" : ""}.`}
              </p>
            ) : null}
            {account.eraseRequest ? (
              <p data-testid="customer-erase-request">
                {`The member deleted their account on ${formatDate(account.eraseRequest.requestedAt)}: erase their data, or say why some is kept, by ${formatDate(account.eraseRequest.dueAt)} (Settings → Storage).`}
              </p>
            ) : null}
            <AccountActions
              id={account.id}
              status={account.status}
              changing={account.emailChange !== null && !account.emailChange.expired}
            />
          </>
        ) : (
          <p className="text-muted-foreground">No customer account</p>
        )}
      </CardContent>
    </Card>
  );
}

/** The admins' buttons on an account: each the host's operation, its refusal shown as it says. */
function AccountActions({
  id,
  status,
  changing,
}: {
  id: string;
  status: "active" | "disabled";
  changing: boolean;
}) {
  const disable = useOpMutation("customer.disable");
  const enable = useOpMutation("customer.enable");
  const signOut = useOpMutation("customer.revokeSessions");
  const change = useOpMutation("customer.changeEmail");
  const cancel = useOpMutation("customer.cancelEmailChange");
  const [asking, setAsking] = useState(false);
  const [email, setEmail] = useState("");
  const busy =
    disable.isPending ||
    enable.isPending ||
    signOut.isPending ||
    change.isPending ||
    cancel.isPending;

  async function run<T>(act: () => Promise<T>, done: (out: T) => string) {
    try {
      toast.success(done(await act()));
    } catch (error) {
      toast.error(errorMessage(error));
    }
  }

  async function start(event: FormEvent) {
    event.preventDefault();
    await run(
      () => change.mutateAsync({ id, email: email.trim() }),
      (out) => {
        setAsking(false);
        setEmail("");
        return `A code was emailed to ${out.newEmail}. The address changes when the member enters it.`;
      },
    );
  }

  return (
    <div className="grid gap-2">
      <div className="flex flex-wrap gap-2">
        {status === "active" ? (
          <Button
            size="sm"
            variant="outline"
            disabled={busy}
            onClick={() => {
              if (!window.confirm("Disable this account? It is signed out everywhere at once."))
                return;
              void run(
                () => disable.mutateAsync({ id }),
                () => "Account disabled",
              );
            }}
          >
            Disable
          </Button>
        ) : (
          <Button
            size="sm"
            variant="outline"
            disabled={busy}
            onClick={() =>
              void run(
                () => enable.mutateAsync({ id }),
                () => "Account enabled",
              )
            }
          >
            Enable
          </Button>
        )}
        <Button
          size="sm"
          variant="outline"
          disabled={busy}
          onClick={() =>
            void run(
              () => signOut.mutateAsync({ id }),
              (out) =>
                `Signed out everywhere (${out.sessionsEnded} ${out.sessionsEnded === 1 ? "session" : "sessions"})`,
            )
          }
        >
          Sign out everywhere
        </Button>
        {changing ? (
          <Button
            size="sm"
            variant="outline"
            disabled={busy}
            onClick={() =>
              void run(
                () => cancel.mutateAsync({ id }),
                (out) => (out.cancelled ? "Address change cancelled" : "No change was waiting"),
              )
            }
          >
            Cancel address change
          </Button>
        ) : null}
        {asking ? null : (
          <Button size="sm" variant="outline" disabled={busy} onClick={() => setAsking(true)}>
            Change sign-in address
          </Button>
        )}
      </div>
      {asking ? (
        <form className="grid gap-2" aria-label="Change sign-in address" onSubmit={start}>
          <Label htmlFor={`customer-new-email-${id}`}>The member's new sign-in address</Label>
          <Input
            id={`customer-new-email-${id}`}
            type="email"
            autoComplete="off"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
          <p className="text-muted-foreground text-xs">
            We email a code to it. Nothing changes until the member, signed in, enters the code. You
            never see it.
          </p>
          <div className="flex gap-2">
            <Button size="sm" type="submit" disabled={busy || !email.trim()}>
              Email the code
            </Button>
            <Button size="sm" type="button" variant="outline" onClick={() => setAsking(false)}>
              Back
            </Button>
          </div>
        </form>
      ) : null}
    </div>
  );
}
