// Settings → Devices (stage 51 step 1, built with stage 44 step 6; ADR 0780): the business's own
// enrolled devices, of every use. An admin enrols one (its name and use; the host answers a
// single-use enrolment code, typed at the desk origin's /enrol on the device), sees each with who
// enrolled it, when it was last seen, the browser and network it last came from and any change
// flagged, a lock-out from wrong codes, changes its use, and revokes it. The host decides every
// one of these (an admin who is a person; every admin is told); the page only shows its answers.
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
import { createFileRoute } from "@tanstack/react-router";
import { type FormEvent, useState } from "react";
import { toast } from "sonner";
import { PageLayout } from "#/components/layout/page-layout";
import { formatDateTime } from "#/lib/format";
import { errorMessage, useOp, useOpMutation } from "#/lib/query";

export const Route = createFileRoute("/_app/settings/devices")({
  component: DevicesPage,
});

const USE_WORDS: Record<string, string> = {
  signing: "Desk signing",
  role: "Device role",
  till: "Till",
};

const STATE_WORDS: Record<string, string> = {
  waiting: "Waiting for its code",
  unclaimed: "Code ran out",
  active: "Enrolled",
  lapsed: "Unused for 30 days: enrol it again",
  revoked: "Revoked",
};

const REVOKE_WORDS: Record<string, string> = {
  admin: "by an admin",
  clone: "its credential was copied",
  lapsed: "unused for 30 days",
};

function DevicesPage() {
  const list = useOp("device.list", {});
  const [enrolling, setEnrolling] = useState(false);
  return (
    <PageLayout
      title="Devices"
      width="md"
      back={{ to: "/settings", label: "Settings" }}
      description="The business's own tablets, each enrolled by an admin for one use. A desk signing tablet holds no sign-in: a member signs on it in a session someone on the staff starts."
      actions={
        list.data?.configured ? (
          <Button onClick={() => setEnrolling(true)}>Enrol a device</Button>
        ) : undefined
      }
    >
      {list.isLoading ? (
        <Skeleton className="h-32 w-full" />
      ) : list.isError ? (
        <p className="text-sm text-destructive">{errorMessage(list.error)}</p>
      ) : (
        <>
          {!list.data?.configured && (
            <Card>
              <CardContent className="pt-6 text-sm text-muted-foreground">
                This deployment has no desk hostname or no DESK_SECRET, so no device can be
                enrolled. A deployment on its own domain gets the desk at desk. before its name.
              </CardContent>
            </Card>
          )}
          {list.data?.deskUrl && (
            <p className="text-sm text-muted-foreground">
              The desk is at <span className="font-mono">{list.data.deskUrl}</span>.
            </p>
          )}
          <div className="grid gap-3" data-testid="devices">
            {list.data?.devices.length === 0 && (
              <p className="text-sm text-muted-foreground">No device is enrolled yet.</p>
            )}
            {list.data?.devices.map((device) => (
              <DeviceCard key={device.id} device={device} />
            ))}
          </div>
        </>
      )}
      {enrolling && (
        <EnrolDialog deskUrl={list.data?.deskUrl ?? null} onClose={() => setEnrolling(false)} />
      )}
    </PageLayout>
  );
}

type Device = NonNullable<ReturnType<typeof useOp<"device.list">>["data"]>["devices"][number];

function DeviceCard({ device }: { device: Device }) {
  const revoke = useOpMutation("device.revoke", { invalidates: ["device."] });
  const setUse = useOpMutation("device.setUse", { invalidates: ["device."] });
  const [confirming, setConfirming] = useState(false);
  const [changing, setChanging] = useState(false);
  const [use, setUseValue] = useState<"signing" | "role" | "till">(device.use);
  const [role, setRole] = useState(device.role ?? "");
  const revoked = device.state === "revoked";
  return (
    <Card data-testid={`device-${device.id}`}>
      <CardHeader className="flex flex-row items-start justify-between gap-3">
        <div className="grid gap-1">
          <CardTitle className="text-base">{device.name}</CardTitle>
          <p className="text-sm text-muted-foreground">
            {USE_WORDS[device.use] ?? device.use}
            {device.role ? ` (${device.role})` : ""} · enrolled by {device.enrolledBy.name} on{" "}
            {formatDateTime(device.enrolledAt)}
          </p>
        </div>
        <Badge
          variant={revoked ? "destructive" : device.state === "active" ? "default" : "outline"}
        >
          {STATE_WORDS[device.state] ?? device.state}
        </Badge>
      </CardHeader>
      <CardContent className="grid gap-2 text-sm">
        {device.lastSeenAt && <p>Last seen {formatDateTime(device.lastSeenAt)}</p>}
        {device.browser && (
          <p className="text-muted-foreground">
            Browser: {device.browser}
            {device.network ? ` · network ${device.network}` : ""}
          </p>
        )}
        {device.flags.length > 0 && (
          <ul className="grid gap-1" aria-label="Changes flagged">
            {device.flags.slice(-5).map((flag) => (
              <li key={`${flag.kind}-${flag.at}`}>
                <Badge variant="outline">
                  {flag.kind === "browser" ? "Another browser" : "Another network"} since{" "}
                  {formatDateTime(flag.at)}
                </Badge>
              </li>
            ))}
          </ul>
        )}
        {device.lockedUntil && (
          <p className="text-destructive">
            Locked after wrong codes until {formatDateTime(device.lockedUntil)}
          </p>
        )}
        {revoked && (
          <p className="text-muted-foreground">
            Revoked {device.revokedAt ? formatDateTime(device.revokedAt) : ""}:{" "}
            {device.revokeReason === "admin" && device.revokedBy
              ? `by ${device.revokedBy}`
              : REVOKE_WORDS[device.revokeReason ?? ""]}
          </p>
        )}
        {!revoked && (
          <div className="flex flex-wrap gap-2 pt-1">
            <Button variant="outline" size="sm" onClick={() => setChanging((v) => !v)}>
              Change use
            </Button>
            <Button variant="destructive" size="sm" onClick={() => setConfirming(true)}>
              Revoke
            </Button>
          </div>
        )}
        {changing && !revoked && (
          <form
            className="flex flex-wrap items-end gap-2"
            onSubmit={(event: FormEvent) => {
              event.preventDefault();
              setUse.mutate(
                {
                  deviceId: device.id,
                  use,
                  ...(use === "role" ? { role } : {}),
                },
                {
                  onSuccess: () => {
                    toast.success("Its use was changed; every admin is told");
                    setChanging(false);
                  },
                  onError: (error) => toast.error(errorMessage(error)),
                },
              );
            }}
          >
            <div className="grid gap-1">
              <Label htmlFor={`use-${device.id}`}>Use</Label>
              <select
                id={`use-${device.id}`}
                className="h-9 rounded-md border bg-background px-2"
                value={use}
                onChange={(e) => setUseValue(e.target.value as typeof use)}
              >
                <option value="signing">Desk signing</option>
                <option value="role">A device role</option>
                <option value="till">A till</option>
              </select>
            </div>
            {use === "role" && (
              <div className="grid gap-1">
                <Label htmlFor={`role-${device.id}`}>Device role</Label>
                <Input
                  id={`role-${device.id}`}
                  placeholder="pack.role"
                  value={role}
                  onChange={(e) => setRole(e.target.value)}
                />
              </div>
            )}
            <Button type="submit" size="sm" disabled={setUse.isPending}>
              Save
            </Button>
          </form>
        )}
      </CardContent>
      <Dialog open={confirming} onOpenChange={setConfirming}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Revoke {device.name}?</DialogTitle>
            <DialogDescription>
              Its credential opens nothing again, and any signing session on it ends now. Every
              admin is told. To use it again, enrol it again.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirming(false)}>
              Keep it
            </Button>
            <Button
              variant="destructive"
              disabled={revoke.isPending}
              onClick={() =>
                revoke.mutate(
                  { deviceId: device.id },
                  {
                    onSuccess: () => {
                      toast.success(`${device.name} was revoked`);
                      setConfirming(false);
                    },
                    onError: (error) => toast.error(errorMessage(error)),
                  },
                )
              }
            >
              Revoke
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  );
}

function EnrolDialog({ deskUrl, onClose }: { deskUrl: string | null; onClose: () => void }) {
  const enrol = useOpMutation("device.enrol", { invalidates: ["device."] });
  const [name, setName] = useState("");
  const [made, setMade] = useState<{ code: string; enrolUrl: string; expiresAt: string } | null>(
    null,
  );
  const submit = (event: FormEvent) => {
    event.preventDefault();
    enrol.mutate(
      { name: name.trim(), use: "signing" },
      {
        onSuccess: (result) =>
          setMade({ code: result.code, enrolUrl: result.enrolUrl, expiresAt: result.expiresAt }),
        onError: (error) => toast.error(errorMessage(error)),
      },
    );
  };
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Enrol a device</DialogTitle>
          <DialogDescription>
            For desk signing: a member signs on it in a session someone on the staff starts. A
            check-in tablet and a till come with their packs.
          </DialogDescription>
        </DialogHeader>
        {made ? (
          <div className="grid gap-3 text-sm">
            <p>
              On the tablet, open <span className="font-mono">{made.enrolUrl}</span> and type this
              code. It works once, until {formatDateTime(made.expiresAt)}.
            </p>
            <p
              className="rounded-md border p-4 text-center font-mono text-3xl tracking-widest"
              data-testid="enrol-code"
            >
              {made.code}
            </p>
            <p className="text-muted-foreground">Every admin has been told.</p>
            <DialogFooter>
              <Button onClick={onClose}>Done</Button>
            </DialogFooter>
          </div>
        ) : (
          <form onSubmit={submit} className="grid gap-3">
            <div className="grid gap-1">
              <Label htmlFor="device-name">Name</Label>
              <Input
                id="device-name"
                placeholder="Front desk tablet"
                value={name}
                maxLength={80}
                onChange={(e) => setName(e.target.value)}
              />
            </div>
            {!deskUrl && (
              <p className="text-sm text-destructive">This deployment has no desk hostname.</p>
            )}
            <DialogFooter>
              <Button type="button" variant="outline" onClick={onClose}>
                Cancel
              </Button>
              <Button type="submit" disabled={!name.trim() || enrol.isPending}>
                Enrol
              </Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}
