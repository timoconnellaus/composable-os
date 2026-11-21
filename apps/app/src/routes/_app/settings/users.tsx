// Settings → Users and roles (admin): every user (user.list) with their role (user.updateRole),
// pack role (user.setPackRole, ADR 0436) and permissions granted one by one (user.setPermissions,
// ADR 0449); staff invites (user.invite, user.invites, user.revokeInvite, ADR 0455); and the
// connection the host's own mail goes out from (sign-in codes and invite notices). The last
// admin cannot be demoted; that refusal is shown inline on the row.

import { CHANNEL_RESOURCE_PATTERNS, CHANNEL_VENDORS } from "@composable-os/core/client";
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@composable-os/ui/components/select";
import { Skeleton } from "@composable-os/ui/components/skeleton";
import { createFileRoute } from "@tanstack/react-router";
import { LockIcon } from "lucide-react";
import { type FormEvent, useState } from "react";
import { toast } from "sonner";
import { ErrorState } from "#/components/empty-state";
import { PageLayout } from "#/components/layout/page-layout";
import { formatDate, initials } from "#/lib/format";
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
}: {
  idPrefix: string;
  value: string[];
  onChange: (next: string[]) => void;
}) {
  const { grantable } = useAccessChoices();
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
  const { packRoles } = useAccessChoices();
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
        permissions: packRole === NONE ? permissions : [],
      });
      toast.success(
        result.signIn === "access"
          ? `${result.email} is invited. Add them to the Cloudflare Access policy to let them in.`
          : result.invitationEmail === "sent"
            ? `${result.email} is invited and has an email saying how to sign in.`
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
          {packRole !== NONE ? (
            <p className="text-xs text-muted-foreground">
              {packRoles.find((r) => r.name === packRole)?.description} This is all the account may
              do.
            </p>
          ) : (
            <PermissionChecks idPrefix="invite" value={permissions} onChange={setPermissions} />
          )}
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

type ListedUser = {
  id: string;
  name?: string;
  email?: string;
  role?: Role;
  packRole?: string | null;
  permissions?: string[];
  image?: string | null;
  createdAt?: string;
};

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
        {(users.data.items as ListedUser[]).map((u) => {
          const name = u.name ?? u.email ?? u.id;
          const role = (u.role ?? "member") as Role;
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

/** Permissions granted one by one (ADR 0449), set whole with user.setPermissions. */
function GrantsDialog({ user, onClose }: { user: ListedUser; onClose: () => void }) {
  const save = useOpMutation("user.setPermissions", { invalidates: ["user.list"] });
  const [value, setValue] = useState<string[]>(user.permissions ?? []);
  const name = user.name ?? user.email ?? user.id;
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
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button
            disabled={save.isPending}
            onClick={async () => {
              try {
                await save.mutateAsync({ id: user.id, permissions: value });
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
    invalidates: ["customer.settings.get"],
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
          Sign-in codes and invite emails, for staff and customers, go out from this org email
          connection, sent by the host itself. Until one is chosen, nobody can sign in by code.
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
      </CardContent>
    </Card>
  );
}
