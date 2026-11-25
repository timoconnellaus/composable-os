// Confirming your own email address (ADR 0457): sign-in by an emailed code, and `cos content
// import --email`, work only for a confirmed address, and the first admin's password sign-up
// leaves it unconfirmed. The account menu and Settings → Users offer it while it is.
import { Button } from "@composable-os/ui/components/button";
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
import { type FormEvent, useEffect, useState } from "react";
import { toast } from "sonner";
import { errorMessage, useOp, useOpMutation } from "#/lib/query";

/** The signed-in person's address and whether it is confirmed; undefined while unknown. */
export function useEmailStatus(enabled = true) {
  return useEmailStatusQuery(enabled).data;
}

function useEmailStatusQuery(enabled = true) {
  return useOp("user.emailStatus", {}, { retry: false, enabled });
}

export function ConfirmEmailDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const query = useEmailStatusQuery();
  const status = query.data;
  // Read afresh when opened: the host's mail may have been set up since.
  const { refetch } = query;
  useEffect(() => {
    if (open) void refetch();
  }, [open, refetch]);
  const send = useOpMutation("user.sendEmailConfirmation");
  const confirm = useOpMutation("user.confirmEmail", { invalidates: ["user.emailStatus"] });
  const [sent, setSent] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function ask() {
    setError(null);
    try {
      const result = await send.mutateAsync({});
      setSent(result.sentTo);
    } catch (caught) {
      setError(errorMessage(caught));
    }
  }

  async function check(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    const code = String(new FormData(event.currentTarget).get("code")).trim();
    try {
      const result = await confirm.mutateAsync({ code });
      if (result.confirmed) {
        toast.success(`${result.email} is confirmed`);
        setSent(null);
        onClose();
      } else {
        setError("That code is not valid. Check it, or ask for a new one.");
      }
    } catch (caught) {
      setError(errorMessage(caught));
    }
  }

  const ready = status?.signInMail.ready ?? false;
  return (
    <Dialog open={open} onOpenChange={(next) => !next && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Confirm your email</DialogTitle>
          <DialogDescription>
            Until {status?.email ?? "your address"} is confirmed, you cannot sign in with a code
            emailed to it, here, in the app or with <code>cos content import --email</code>.
          </DialogDescription>
        </DialogHeader>
        {!ready && status && (
          <p className="text-sm text-destructive" role="alert">
            A code cannot be sent yet: {status.signInMail.problem}.
          </p>
        )}
        {sent ? (
          <form className="grid gap-3" onSubmit={check} aria-label="Enter the confirmation code">
            <p className="text-sm text-muted-foreground">
              A six-digit code is on its way to {sent}. It works for five minutes.
            </p>
            <div className="grid gap-1.5">
              <Label htmlFor="confirm-code">Code</Label>
              <Input
                id="confirm-code"
                name="code"
                inputMode="numeric"
                autoComplete="one-time-code"
                pattern="[0-9]{6}"
                required
              />
            </div>
            {error && (
              <p role="alert" className="text-sm text-destructive">
                {error}
              </p>
            )}
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => void ask()}>
                Send a new code
              </Button>
              <Button type="submit" disabled={confirm.isPending}>
                Confirm
              </Button>
            </DialogFooter>
          </form>
        ) : (
          <>
            {error && (
              <p role="alert" className="text-sm text-destructive">
                {error}
              </p>
            )}
            <DialogFooter>
              <Button variant="outline" onClick={onClose}>
                Later
              </Button>
              <Button disabled={!ready || send.isPending} onClick={() => void ask()}>
                Email me a code
              </Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}

/** A plain notice for an unconfirmed address, with the action. Nothing once it is confirmed. */
export function UnconfirmedEmailNotice() {
  const status = useEmailStatus();
  const [open, setOpen] = useState(false);
  if (!status || status.verified) return null;
  return (
    <div
      className="flex flex-wrap items-center gap-3 rounded-md border border-amber-300 px-3 py-2 text-sm"
      role="note"
      data-testid="unconfirmed-email"
    >
      <span className="flex-1">
        Your address, {status.email}, is not confirmed: until it is, you cannot sign in with an
        emailed code or use <code>cos content import --email</code>.
      </span>
      <Button size="sm" variant="outline" onClick={() => setOpen(true)}>
        Confirm your email
      </Button>
      <ConfirmEmailDialog open={open} onClose={() => setOpen(false)} />
    </div>
  );
}
