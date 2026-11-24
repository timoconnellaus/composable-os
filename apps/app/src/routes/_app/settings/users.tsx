// Settings → Users and roles (admin): every user (user.list) with their role (user.updateRole),
// pack role (user.setPackRole, ADR 0436) and permissions granted one by one (user.setPermissions,
// ADR 0449); staff invites (user.invite, user.invites, user.revokeInvite, ADR 0455); and the
// connection the host's own mail goes out from (sign-in codes and invite notices). The last
// admin cannot be demoted; that refusal is shown inline on the row.

import type { CoreOutput } from "@composable-os/core";
import { CHANNEL_RESOURCE_PATTERNS, CHANNEL_VENDORS } from "@composable-os/core/client";
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
import { Avatar, AvatarFallback, AvatarImage } from "@composable-os/ui/components/avatar";
import { Badge } from "@composable-os/ui/components/badge";
import { Button } from "@composable-os/ui/components/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@composable-os/ui/components/card";
import { Checkbox } from "@composable-os/ui/components/checkbox";
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
import { RadioGroup, RadioGroupItem } from "@composable-os/ui/components/radio-group";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@composable-os/ui/components/select";
import { Skeleton } from "@composable-os/ui/components/skeleton";
import { Switch } from "@composable-os/ui/components/switch";
import { createFileRoute } from "@tanstack/react-router";
import { LockIcon } from "lucide-react";
import { type FormEvent, useState } from "react";
import { toast } from "sonner";
import { UnconfirmedEmailNotice } from "#/components/confirm-email";
import { ErrorState } from "#/components/empty-state";
import { PageLayout } from "#/components/layout/page-layout";
import { formatDate, initials } from "#/lib/format";
import { splitGrants, toggledGrants } from "#/lib/grants";
import { OperationCallError } from "#/lib/operations";
import { errorMessage, useOp, useOpMutation } from "#/lib/query";
import { ALL_USERS_INPUT } from "#/lib/users-adapter";

export const Route = createFileRoute("/_app/settings/users")({ component: UsersPage });

type Role = "admin" | "member" | "viewer";

const ROLE_COPY: Record<Role, { label: string; description: string }> = {
  admin: { label: "Admin", description: "Everything, including users, policy and erase" },
  member: { label: "Member", description: "Read and write records" },
  viewer: { label: "Viewer", description: "Read only" },
};

const NONE = "__none__";

/** A friendlier line for the refusals user.updateRole and user.setPackRole can give. */
function roleError(error: unknown): string {
  if (error instanceof OperationCallError) {
    if (error.code === "conflict") return error.message;
    if (error.code === "forbidden") return "Only admins can change roles.";
  }
  return errorMessage(error);
}

function UsersPage() {
  const { isAdmin } = Route.useRouteContext();
  return (
    <PageLayout
      title="Users and roles"
      width="md"
      back={{ to: "/settings", label: "Settings" }}
      description="Everyone who can sign in. Admins invite people and set what each account may do."
    >
      {!isAdmin && (
        <p className="flex items-center gap-2 rounded-md border px-3 py-2 text-sm text-muted-foreground">
          <LockIcon className="size-4" aria-hidden />
          Only admins can change roles and invite people.
        </p>
      )}
      {isAdmin && <InviteCard />}
      {isAdmin && <PendingInvites />}
      <UserList />
      <dl className="grid gap-1 text-xs text-muted-foreground sm:grid-cols-[6rem_1fr]">
        {(Object.keys(ROLE_COPY) as Role[]).map((r) => (
          <div key={r} className="contents">
            <dt className="font-medium">{ROLE_COPY[r].label}</dt>
            <dd>{ROLE_COPY[r].description}</dd>
          </div>
        ))}
      </dl>
      {isAdmin && <HostMailCard />}
      {isAdmin && <CustomerSignupCard />}
    </PageLayout>
  );
}

/** The pack roles and grantable permissions an admin can choose from. */
function useAccessChoices() {
  const packRoles = useOp("user.packRoles", {});
  const grantable = useOp("user.grantablePermissions", {});
  return { packRoles: packRoles.data?.items ?? [], grantable: grantable.data?.items ?? [] };
}

function PermissionChecks({
  idPrefix,
  value,
  onChange,
  fixedRole = false,
}: {
  idPrefix: string;
  value: string[];
  onChange: (next: string[]) => void;
  /** For an account with a fixed role: only what may be added to one (a pack's, ADR 0600). */
  fixedRole?: boolean;
}) {
  const { grantable: all } = useAccessChoices();
  const grantable = fixedRole ? all.filter((g) => g.forFixedRole) : all;
  if (!grantable.length) return null;
  return (
    <fieldset className="grid gap-2">
      <legend className="mb-1 text-sm font-medium">Also allowed</legend>
      {grantable.map((g) => {
        const id = `${idPrefix}-${g.permission}`;
        return (
          <div key={g.permission} className="flex items-center gap-2 text-sm">
            <Checkbox
              id={id}
              checked={value.includes(g.permission)}
              onCheckedChange={(checked) =>
                onChange(
                  checked ? [...value, g.permission] : value.filter((p) => p !== g.permission),
                )
              }
            />
            <Label htmlFor={id} className="font-normal">
              {g.label}
            </Label>
          </div>
        );
      })}
    </fieldset>
  );
}

function InviteCard() {
  const { packRoles, grantable } = useAccessChoices();
  const invite = useOpMutation("user.invite", { invalidates: ["user.invites"] });
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<Role>("member");
  const [packRole, setPackRole] = useState<string>(NONE);
  const [permissions, setPermissions] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    try {
      const result = await invite.mutateAsync({
        email,
        role,
        packRole: packRole === NONE ? null : packRole,
        // A fixed role's account may be granted a pack's permissions only (ADR 0600).
        permissions:
          packRole === NONE
            ? permissions
            : permissions.filter((p) =>
                grantable.some((g) => g.permission === p && g.forFixedRole),
              ),
      });
      toast.success(
        result.signIn === "access"
          ? `${result.email} is invited. Add them to the Cloudflare Access policy to let them in.`
          : result.invitationEmail === "sent"
            ? `${result.email} is invited and has an email saying how to sign in.`
            : result.invitationEmail === "pending"
              ? `${result.email} is invited. The invite email waits in Approvals; they can sign in with “Email me a code” now.`
              : `${result.email} is invited. No email went out: tell them to sign in with “Email me a code”.`,
      );
      setEmail("");
      setPermissions([]);
      setPackRole(NONE);
    } catch (caught) {
      setError(errorMessage(caught));
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Invite someone</CardTitle>
        <CardDescription>
          They accept by signing in with a code emailed to this address. Nobody else can sign up.
          The invite works for 7 days.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form className="grid gap-4" onSubmit={submit} aria-label="Invite someone">
          <div className="grid gap-1.5">
            <Label htmlFor="invite-email">Email</Label>
            <Input
              id="invite-email"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
            />
          </div>
          <div className="flex flex-wrap gap-4">
            <div className="grid gap-1.5">
              <Label htmlFor="invite-role">Role</Label>
              <Select
                value={role}
                onValueChange={(v) => setRole(v as Role)}
                disabled={packRole !== NONE}
              >
                <SelectTrigger id="invite-role" className="w-36">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {(Object.keys(ROLE_COPY) as Role[]).map((r) => (
                    <SelectItem key={r} value={r}>
                      {ROLE_COPY[r].label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            {packRoles.length > 0 && (
              <div className="grid gap-1.5">
                <Label htmlFor="invite-pack-role">Fixed role</Label>
                <Select value={packRole} onValueChange={setPackRole}>
                  <SelectTrigger id="invite-pack-role" className="w-56">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={NONE}>None</SelectItem>
                    {packRoles.map((r) => (
                      <SelectItem key={r.name} value={r.name}>
                        {r.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            )}
          </div>
          {packRole !== NONE && (
            <p className="text-xs text-muted-foreground">
              {packRoles.find((r) => r.name === packRole)?.description} This, and what you tick
              below, is all the account may do.
            </p>
          )}
          <PermissionChecks
            idPrefix="invite"
            value={permissions}
            onChange={setPermissions}
            fixedRole={packRole !== NONE}
          />
          {error && (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          )}
          <Button type="submit" className="justify-self-start" disabled={invite.isPending}>
            {invite.isPending ? "Inviting…" : "Send invite"}
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}

function PendingInvites() {
  const invites = useOp("user.invites", {});
  const revoke = useOpMutation("user.revokeInvite", { invalidates: ["user.invites"] });
  if (invites.isPending) return <Skeleton className="h-16" />;
  if (invites.isError) {
    return (
      <ErrorState
        title="Could not load invites"
        error={invites.error}
        onRetry={() => void invites.refetch()}
      />
    );
  }
  if (!invites.data.items.length) return null;
  return (
    <section className="grid gap-2">
      <h2 className="text-sm font-medium">Pending invites</h2>
      <ul className="grid divide-y rounded-md border" aria-label="Pending invites">
        {invites.data.items.map((invite) => (
          <li
            key={invite.id}
            className="flex flex-wrap items-center gap-3 px-3 py-3 text-sm"
            data-testid="invite-row"
            data-email={invite.email}
          >
            <div className="grid min-w-0 flex-1">
              <span className="truncate font-medium">{invite.email}</span>
              <span className="text-xs text-muted-foreground">
                {invite.status === "expired"
                  ? `Expired ${formatDate(invite.expiresAt)}`
                  : `Expires ${formatDate(invite.expiresAt)}`}
              </span>
            </div>
            <Badge variant="outline">{invite.packRole ?? ROLE_COPY[invite.role].label}</Badge>
            {invite.permissions.map((p) => (
              <Badge key={p} variant="secondary">
                {p}
              </Badge>
            ))}
            <Button
              size="sm"
              variant="outline"
              disabled={revoke.isPending}
              onClick={async () => {
                try {
                  await revoke.mutateAsync({ id: invite.id });
                  toast.success(`The invite for ${invite.email} is revoked`);
                } catch (error) {
                  toast.error(errorMessage(error));
                }
              }}
            >
              Revoke
            </Button>
          </li>
        ))}
      </ul>
    </section>
  );
}

type ListedUser = CoreOutput<"user.list">["items"][number];

function UserList() {
  const { isAdmin, user: me } = Route.useRouteContext();
  const users = useOp("user.list", ALL_USERS_INPUT);
  const { packRoles } = useAccessChoices();
  const update = useOpMutation("user.updateRole");
  const setPack = useOpMutation("user.setPackRole");
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [granting, setGranting] = useState<ListedUser | null>(null);

  async function run(id: string, action: () => Promise<string>) {
    setErrors(({ [id]: _, ...rest }) => rest);
    try {
      toast.success(await action());
    } catch (error) {
      const message = roleError(error);
      setErrors((current) => ({ ...current, [id]: message }));
      toast.error(message);
    }
  }

  if (users.isPending) return <Skeleton className="h-40" />;
  if (users.isError) {
    return (
      <ErrorState
        title="Could not load users"
        error={users.error}
        onRetry={() => void users.refetch()}
      />
    );
  }
  return (
    <>
      <ul className="grid divide-y rounded-md border" aria-label="Users">
        {users.data.items.map((u) => {
          const name = u.name ?? u.email ?? u.id;
          const role = u.role ?? "member";
          return (
            <li
              key={u.id}
              className="flex flex-wrap items-center gap-3 px-3 py-3 text-sm"
              data-testid="user-row"
              data-email={u.email}
            >
              <Avatar className="size-8">
                {u.image && <AvatarImage src={u.image} alt="" />}
                <AvatarFallback className="text-xs">{initials(name)}</AvatarFallback>
              </Avatar>
              <div className="grid min-w-0 flex-1">
                <span className="flex items-center gap-2 truncate font-medium">
                  {name}
                  {u.id === me.id && <Badge variant="secondary">You</Badge>}
                </span>
                <span className="truncate text-xs text-muted-foreground">
                  {u.email}
                  {u.createdAt ? ` · joined ${formatDate(u.createdAt)}` : ""}
                </span>
                {(u.permissions ?? []).length > 0 && (
                  <span className="text-xs text-muted-foreground">
                    Also: {(u.permissions ?? []).join(", ")}
                  </span>
                )}
                {errors[u.id] && (
                  <span className="text-xs text-destructive" role="alert">
                    {errors[u.id]}
                  </span>
                )}
              </div>
              {isAdmin ? (
                <>
                  {packRoles.length > 0 && role !== "admin" && (
                    <Select
                      value={u.packRole ?? NONE}
                      onValueChange={(next) =>
                        void run(u.id, async () => {
                          const result = await setPack.mutateAsync({
                            id: u.id,
                            role: next === NONE ? null : next,
                          });
                          return result.packRole
                            ? `${name} now holds ${result.packRole} only`
                            : `${name} no longer holds a fixed role`;
                        })
                      }
                      disabled={setPack.isPending}
                    >
                      <SelectTrigger
                        size="sm"
                        className="w-40"
                        aria-label={`Fixed role for ${name}`}
                      >
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value={NONE}>No fixed role</SelectItem>
                        {packRoles.map((r) => (
                          <SelectItem key={r.name} value={r.name}>
                            {r.label}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  )}
                  {!u.packRole && (
                    <Select
                      value={role}
                      onValueChange={(next) =>
                        void run(u.id, async () => {
                          const result = await update.mutateAsync({ id: u.id, role: next as Role });
                          return `${name} is now ${ROLE_COPY[result.role].label.toLowerCase()}`;
                        })
                      }
                      disabled={update.isPending}
                    >
                      <SelectTrigger size="sm" className="w-32" aria-label={`Role for ${name}`}>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {(Object.keys(ROLE_COPY) as Role[]).map((r) => (
                          <SelectItem key={r} value={r}>
                            {ROLE_COPY[r].label}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  )}
                  {!u.packRole && role !== "admin" && (
                    <Button size="sm" variant="ghost" onClick={() => setGranting(u)}>
                      Permissions
                    </Button>
                  )}
                  {u.packRole && <FixedRoleGrants user={u} />}
                </>
              ) : (
                <Badge variant="outline">{u.packRole ?? ROLE_COPY[role].label}</Badge>
              )}
            </li>
          );
        })}
      </ul>
      {granting && <GrantsDialog user={granting} onClose={() => setGranting(null)} />}
    </>
  );
}

/**
 * What an account with a fixed role may be given on top of it (ADR 0600): a pack's permissions,
 * each one tick on the account's row, in the pack's own words (a coach given the Bookings desk).
 * Saved at once with user.setPermissions; the host counts it from the account's next call.
 */
function FixedRoleGrants({ user }: { user: ListedUser }) {
  const { grantable } = useAccessChoices();
  const save = useOpMutation("user.setPermissions", { invalidates: ["user.list"] });
  const choices = grantable.filter((g) => g.forFixedRole);
  const allowed = choices.map((g) => g.permission);
  const name = user.name ?? user.email ?? user.id;
  // Only what the account may hold is sent; a stored grant that no longer applies (its pack was
  // removed) is shown so an admin can take it away, and never makes a tick fail.
  const stored = user.permissions ?? [];
  const { held, stale: unheld } = splitGrants(stored, allowed);
  const stale = grantable.length ? unheld : [];
  if (!choices.length && !stale.length) return null;
  return (
    <fieldset className="grid w-full gap-2 sm:pl-11" aria-label={`Also allowed for ${name}`}>
      {stale.length > 0 && (
        <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
          <span>No longer applies: {stale.join(", ")}</span>
          <Button
            size="sm"
            variant="outline"
            disabled={save.isPending}
            onClick={async () => {
              try {
                await save.mutateAsync({ id: user.id, permissions: held });
                toast.success(`Removed ${stale.join(", ")} from ${name}`);
              } catch (error) {
                toast.error(errorMessage(error));
              }
            }}
          >
            Remove
          </Button>
        </div>
      )}
      {choices.map((g) => {
        const id = `fixed-${user.id}-${g.permission}`;
        return (
          <div key={g.permission} className="flex items-start gap-2 text-sm">
            <Checkbox
              id={id}
              className="mt-0.5"
              checked={held.includes(g.permission)}
              disabled={save.isPending}
              onCheckedChange={async (checked) => {
                const next = toggledGrants(stored, allowed, g.permission, checked === true);
                try {
                  await save.mutateAsync({ id: user.id, permissions: next });
                  toast.success(
                    checked
                      ? `${name} may now also: ${g.label}`
                      : `${name} no longer has: ${g.label}`,
                  );
                } catch (error) {
                  toast.error(errorMessage(error));
                }
              }}
            />
            <Label htmlFor={id} className="font-normal leading-snug">
              {g.label}
            </Label>
          </div>
        );
      })}
    </fieldset>
  );
}

/** Permissions granted one by one (ADR 0449), set whole with user.setPermissions. */
function GrantsDialog({ user, onClose }: { user: ListedUser; onClose: () => void }) {
  const save = useOpMutation("user.setPermissions", { invalidates: ["user.list"] });
  const { grantable } = useAccessChoices();
  const [value, setValue] = useState<string[]>(user.permissions ?? []);
  const name = user.name ?? user.email ?? user.id;
  // A stored grant that is no longer grantable is shown and dropped on save (ADR 0600).
  const split = splitGrants(
    value,
    grantable.map((g) => g.permission),
  );
  const stale = grantable.length ? split.stale : [];
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Permissions for {name}</DialogTitle>
          <DialogDescription>
            On top of their role. A grant never lets the assistant or an MCP client do what only a
            person may.
          </DialogDescription>
        </DialogHeader>
        <PermissionChecks idPrefix={`grant-${user.id}`} value={value} onChange={setValue} />
        {stale.length > 0 && (
          <p className="text-xs text-muted-foreground">
            No longer applies, and saving removes it: {stale.join(", ")}
          </p>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button
            disabled={save.isPending}
            onClick={async () => {
              try {
                await save.mutateAsync({
                  id: user.id,
                  permissions: grantable.length ? split.held : value,
                });
                toast.success(`Saved ${name}'s permissions`);
                onClose();
              } catch (error) {
                toast.error(errorMessage(error));
              }
            }}
          >
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** The connection the host's own mail goes out from: sign-in codes and invite notices. */
function HostMailCard() {
  const settings = useOp("customer.settings.get", {});
  const connections = useOp("connection.list", { scope: "org", includeDisconnected: false });
  const save = useOpMutation("customer.settings.update", {
    invalidates: ["customer.settings.get", "user.emailStatus"],
  });
  const options = (connections.data?.items ?? []).filter(
    (c) =>
      c.scope === "org" &&
      CHANNEL_VENDORS.email.includes(c.vendor) &&
      c.resources.some((r) => CHANNEL_RESOURCE_PATTERNS.email.includes(r.pattern)),
  );
  const selected = settings.data?.emailConnectionId ?? null;
  return (
    <Card>
      <CardHeader>
        <CardTitle>The host's mail</CardTitle>
        <CardDescription>
          Sign-in codes, for staff and customers, and invite emails go out from this org email
          connection, sent by the host itself. This is also customer sign-in's mail.
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-1.5">
        <Label htmlFor="host-mail">Mail connection</Label>
        <Select
          value={selected ?? NONE}
          disabled={settings.isPending || save.isPending}
          onValueChange={async (v) => {
            if (v === NONE) return;
            try {
              await save.mutateAsync({ emailConnectionId: v });
              toast.success("The host's mail connection is saved");
            } catch (error) {
              toast.error(errorMessage(error));
            }
          }}
        >
          <SelectTrigger id="host-mail" className="w-full sm:w-96">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={NONE}>Not chosen</SelectItem>
            {selected && !options.some((o) => o.id === selected) && (
              <SelectItem value={selected}>{selected} (unavailable)</SelectItem>
            )}
            {options.map((c) => (
              <SelectItem key={c.id} value={c.id}>
                {c.title}
                {c.accountLabel ? ` · ${c.accountLabel}` : ""}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {!options.length && (
          <p className="text-xs text-muted-foreground">No org connection can send email yet.</p>
        )}
        {settings.data && <SignInMailState state={settings.data.signInMail} />}
        <UnconfirmedEmailNotice />
      </CardContent>
    </Card>
  );
}

type SignInMail = CoreOutput<"customer.settings.get">["signInMail"];

/**
 * Whether sign-in codes go out now (ADR 0456), and the one switch that lets them: the sign-in
 * kind applying without review. It loosens the approval policy for that kind only, so it asks
 * first; it is a human admin's (outbound.setAutoApprove).
 */
function SignInMailState({ state }: { state: SignInMail }) {
  const [confirming, setConfirming] = useState(false);
  const set = useOpMutation("outbound.setAutoApprove", {
    invalidates: ["customer.settings.get", "outbound.kinds", "user.emailStatus"],
  });
  const kind = state.kind;

  async function apply(enabled: boolean) {
    if (!kind) return;
    try {
      await set.mutateAsync({ tag: kind.tag, enabled });
      setConfirming(false);
      toast.success(
        enabled ? "Sign-in codes now go out without review" : "Sign-in codes need review again",
      );
    } catch (error) {
      toast.error(errorMessage(error));
    }
  }

  return (
    <div className="mt-2 grid gap-2" data-testid="sign-in-mail" data-ready={String(state.ready)}>
      <p className={state.ready ? "text-sm" : "text-sm text-destructive"} role="status">
        {state.ready
          ? "Sign-in codes go out at once, for staff and customers."
          : `Nobody can sign in by code yet: ${state.problem}.`}
      </p>
      {kind && (
        <div className="flex items-center gap-2 text-sm">
          <Switch
            id="sign-in-mail-auto"
            checked={state.autoApproved}
            disabled={set.isPending}
            onCheckedChange={(checked) => {
              if (checked) setConfirming(true);
              else void apply(false);
            }}
          />
          <Label htmlFor="sign-in-mail-auto" className="font-normal">
            Send sign-in codes without review
          </Label>
        </div>
      )}
      <AlertDialog open={confirming} onOpenChange={setConfirming}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Send sign-in codes without review?</AlertDialogTitle>
            <AlertDialogDescription>
              Only the host's own sign-in code email, word for word, goes out this way, to the
              address that asked for it. Every other email still follows the approval policy. A code
              that waited for review could be read by whoever approves it, so codes that would wait
              are never sent. The change is audited, and you can turn it off at any time.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={(event) => {
                event.preventDefault();
                void apply(true);
              }}
              disabled={set.isPending}
            >
              Send without review
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

type CustomerSignup = "invite_only" | "buyers" | "open";

const SIGNUP_COPY: Record<CustomerSignup, { label: string; description: string }> = {
  invite_only: {
    label: "Only people you invite",
    description: "A customer account for an address you invited, or one that already has one.",
  },
  buyers: {
    label: "People you invite, and anyone who has bought",
    description:
      "Also anyone who has paid for an order with their address, so a guest buyer can sign in " +
      "later to see their tickets and orders. Starting a checkout without paying does not count.",
  },
  open: {
    label: "Anyone",
    description: "Anyone who confirms their address with the code we email them.",
  },
};

/**
 * Who may sign in as a customer (ADR 0458): a human admin's choice (customer.settings.update),
 * audited. Whatever it is, the sign-in form answers every address the same.
 */
function CustomerSignupCard() {
  const settings = useOp("customer.settings.get", {});
  const save = useOpMutation("customer.settings.update", {
    invalidates: ["customer.settings.get"],
  });
  const value = (settings.data?.signup ?? "invite_only") as CustomerSignup;
  return (
    <Card>
      <CardHeader>
        <CardTitle>Who can sign in as a customer</CardTitle>
        <CardDescription>
          On your site and app. Everyone is told a code is on its way; only these get one.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <RadioGroup
          value={value}
          disabled={settings.isPending || save.isPending}
          aria-label="Who can sign in as a customer"
          onValueChange={async (next) => {
            try {
              await save.mutateAsync({ signup: next as CustomerSignup });
              toast.success(`Customer sign-in: ${SIGNUP_COPY[next as CustomerSignup].label}`);
            } catch (error) {
              toast.error(errorMessage(error));
            }
          }}
          className="grid gap-3"
        >
          {(Object.keys(SIGNUP_COPY) as CustomerSignup[]).map((mode) => (
            <div key={mode} className="flex items-start gap-2">
              <RadioGroupItem id={`signup-${mode}`} value={mode} className="mt-1" />
              <Label htmlFor={`signup-${mode}`} className="grid gap-0.5 font-normal">
                <span className="font-medium">{SIGNUP_COPY[mode].label}</span>
                <span className="text-xs text-muted-foreground">
                  {SIGNUP_COPY[mode].description}
                </span>
              </Label>
            </div>
          ))}
        </RadioGroup>
        {/* On top of the mode (ADR 0459): a new visitor confirms their address to start a plan. */}
        <div className="mt-4 flex items-start gap-2 border-t pt-4">
          <Checkbox
            id="signup-starting-subscription"
            checked={settings.data?.startingSubscription ?? false}
            disabled={settings.isPending || save.isPending || value === "open"}
            onCheckedChange={async (checked) => {
              const on = checked === true;
              try {
                await save.mutateAsync({ startingSubscription: on });
                toast.success(
                  on
                    ? "Customer sign-in: also anyone starting a subscription"
                    : "Customer sign-in: no longer anyone starting a subscription",
                );
              } catch (error) {
                toast.error(errorMessage(error));
              }
            }}
            className="mt-1"
          />
          <Label htmlFor="signup-starting-subscription" className="grid gap-0.5 font-normal">
            <span className="font-medium">Also anyone starting a subscription</span>
            <span className="text-xs text-muted-foreground">
              A new visitor confirms their address with a code, then starts a plan signed in, with
              its free trial (one per person). While a plan is on sale this means anyone can make a
              customer account, including people already in your records, who then see their own
              orders, tickets and subscriptions. Sign-up opens to anyone the moment a plan goes on
              sale, whoever publishes or prices it; admins are told when it does.
            </span>
            {value === "open" ? (
              <span
                className="text-xs text-muted-foreground"
                data-testid="starting-subscription-kept"
              >
                {settings.data?.startingSubscription
                  ? "On, and kept: anyone can sign in now, and this applies again if you change who can sign in back."
                  : "Anyone can sign in now; this applies only to the other choices."}
              </span>
            ) : settings.data?.startingSubscription ? (
              <span className="text-xs text-muted-foreground">
                {settings.data.planOnSale
                  ? "A plan is on sale now, so anyone can get a code."
                  : "No plan is on sale now; the moment one is, anyone can get a code."}
              </span>
            ) : null}
          </Label>
        </div>
      </CardContent>
    </Card>
  );
}
