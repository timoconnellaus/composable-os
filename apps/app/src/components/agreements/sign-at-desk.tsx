// Sign at the desk, for staff (stage 44 step 6, decision 22, ADR 0649): start a desk signing
// session for one Person on a tablet an admin enrolled, and watch it. Choose the Person (on the
// Person page, theirs; on the Sign at the desk screen, found by name), see the titles of what they
// and their children have due (nothing else of their record), tick the children they sign for,
// choose the tablet, start: the code to type on it, then its state from the host (waiting, claimed
// on which device and when, done or ended and why), and End.
//
// The host decides everything: who may start one (agreements:desk, a person: a coach granted it
// too), whom for, which device, and every limit. This only shows its answers.
import { Badge } from "@composable-os/ui/components/badge";
import { Button } from "@composable-os/ui/components/button";
import { Card, CardContent, CardHeader, CardTitle } from "@composable-os/ui/components/card";
import { Checkbox } from "@composable-os/ui/components/checkbox";
import { Input } from "@composable-os/ui/components/input";
import { Label } from "@composable-os/ui/components/label";
import { RadioGroup, RadioGroupItem } from "@composable-os/ui/components/radio-group";
import { Skeleton } from "@composable-os/ui/components/skeleton";
import { useState } from "react";
import { toast } from "sonner";
import { formatDateTime } from "#/lib/format";
import { errorMessage, useOp, useOpMutation } from "#/lib/query";

const ENDED: Record<string, string> = {
  finished: "Done: they finished on the tablet",
  staff: "Ended by staff",
  unclaimed: "The code ran out before it was typed",
  idle: "Ended: nobody touched the tablet for 3 minutes",
  limit: "Ended: 20 minutes passed",
  replaced: "Ended: another session was claimed on the tablet",
  wrong_device: "Ended: the code was typed on another device",
  failed_claim: "Ended: a wrong code was typed on the tablet",
  revoked: "Ended: the tablet was revoked",
  device_changed: "Ended: the tablet's use was changed",
  erased: "Ended: the person was erased",
};

/** The whole flow for one Person (the Person page's panel). */
export function SignAtDesk({ personId }: { personId: string }) {
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [code, setCode] = useState<{ code: string; deskUrl: string } | null>(null);
  if (sessionId && code) {
    return (
      <SessionState
        sessionId={sessionId}
        code={code.code}
        deskUrl={code.deskUrl}
        onAgain={() => {
          setSessionId(null);
          setCode(null);
        }}
      />
    );
  }
  return (
    <Prepare
      personId={personId}
      onStarted={(id, started) => {
        setSessionId(id);
        setCode(started);
      }}
    />
  );
}

/**
 * The Sign at the desk screen (a core screen, `screens.mine`): find the Person first, by their
 * full name or an email address of theirs exactly. The host matches nothing partial and lists
 * nobody else, and every search is on record.
 */
export function SignAtDeskScreen() {
  const [query, setQuery] = useState("");
  const [asked, setAsked] = useState("");
  const [chosen, setChosen] = useState<{ personId: string; name: string } | null>(null);
  const found = useOp("agreement.desk.find", { query: asked }, { enabled: asked.length >= 3 });
  if (chosen) {
    return (
      <div className="grid gap-4">
        <div className="flex items-center justify-between gap-2">
          <p className="font-medium">{chosen.name}</p>
          <Button variant="outline" size="sm" onClick={() => setChosen(null)}>
            Someone else
          </Button>
        </div>
        <SignAtDesk personId={chosen.personId} />
      </div>
    );
  }
  return (
    <Card>
      <CardHeader>
        <CardTitle>Who is signing?</CardTitle>
      </CardHeader>
      <CardContent className="grid gap-3">
        <form
          className="grid gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            setAsked(query.trim());
          }}
        >
          <Label htmlFor="desk-find">Their full name, or their email address</Label>
          <div className="flex gap-2">
            <Input
              id="desk-find"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              autoComplete="off"
            />
            <Button type="submit" disabled={query.trim().length < 3}>
              Find
            </Button>
          </div>
        </form>
        {found.isError && <p className="text-sm text-destructive">{errorMessage(found.error)}</p>}
        <ul className="grid gap-1" aria-label="People found">
          {found.data?.people.map((p) => (
            <li key={p.personId}>
              <Button variant="ghost" onClick={() => setChosen(p)}>
                {p.name}
              </Button>
            </li>
          ))}
        </ul>
        {found.data && found.data.people.length === 0 && (
          <p className="text-sm text-muted-foreground">
            Nobody with exactly that name or address. Check the spelling, or ask for their email
            address.
          </p>
        )}
      </CardContent>
    </Card>
  );
}

function Prepare({
  personId,
  onStarted,
}: {
  personId: string;
  onStarted: (sessionId: string, started: { code: string; deskUrl: string }) => void;
}) {
  const prepared = useOp("agreement.desk.prepare", { personId });
  const devices = useOp("agreement.desk.devices", {});
  const start = useOpMutation("agreement.desk.start", { invalidates: ["agreement.desk."] });
  const [children, setChildren] = useState<string[]>([]);
  const [deviceId, setDeviceId] = useState<string>("");
  if (prepared.isLoading || devices.isLoading) return <Skeleton className="h-32 w-full" />;
  if (prepared.isError)
    return <p className="text-sm text-destructive">{errorMessage(prepared.error)}</p>;
  const p = prepared.data;
  const list = devices.data?.devices ?? [];
  const chosenDevice = deviceId || (list.length === 1 ? (list[0]?.id ?? "") : "");
  if (!p) return null;
  return (
    <Card data-testid="sign-at-desk">
      <CardHeader>
        <CardTitle>Sign at the desk</CardTitle>
      </CardHeader>
      <CardContent className="grid gap-4 text-sm">
        <div className="grid gap-1">
          <p className="font-medium">Due for {p.name}</p>
          {p.due.length ? (
            <ul className="list-inside list-disc">
              {p.due.map((title) => (
                <li key={title}>{title}</li>
              ))}
            </ul>
          ) : (
            <p className="text-muted-foreground">Nothing due.</p>
          )}
        </div>
        {p.dependants.length > 0 && (
          <fieldset className="grid gap-2">
            <legend className="font-medium">They sign for</legend>
            {p.dependants.map((child) => (
              <div key={child.personId} className="flex items-start gap-2">
                <Checkbox
                  id={`desk-child-${child.personId}`}
                  checked={children.includes(child.personId)}
                  onCheckedChange={(on) =>
                    setChildren((was) =>
                      on ? [...was, child.personId] : was.filter((c) => c !== child.personId),
                    )
                  }
                />
                <Label htmlFor={`desk-child-${child.personId}`} className="font-normal">
                  {child.name}
                  {child.due.length ? ` (${child.due.join(", ")})` : " (nothing due)"}
                </Label>
              </div>
            ))}
          </fieldset>
        )}
        {p.refused === "minor" && (
          <p className="text-destructive">
            A parent or guardian signs for them: start the session for their parent or guardian.
          </p>
        )}
        {p.refused === "no_address" && (
          <p className="text-destructive">
            They have no email address, and the copy goes there every time. Add one, or they sign on
            paper or on their own phone.
          </p>
        )}
        {p.copyTo && <p className="text-muted-foreground">The copy goes to {p.copyTo}.</p>}
        <div className="grid gap-2">
          <p className="font-medium">Tablet</p>
          {list.length === 0 ? (
            <p className="text-muted-foreground">
              No tablet is enrolled for desk signing. An admin enrols one in Settings, Devices.
            </p>
          ) : (
            <RadioGroup value={chosenDevice} onValueChange={setDeviceId}>
              {list.map((d) => (
                <div key={d.id} className="flex items-center gap-2">
                  <RadioGroupItem id={`desk-device-${d.id}`} value={d.id} />
                  <Label htmlFor={`desk-device-${d.id}`} className="font-normal">
                    {d.name}
                    {d.lastSeenAt ? ` (last seen ${formatDateTime(d.lastSeenAt)})` : ""}
                  </Label>
                </div>
              ))}
            </RadioGroup>
          )}
        </div>
        <div>
          <Button
            disabled={!chosenDevice || p.refused !== null || start.isPending}
            onClick={() =>
              start.mutate(
                { personId, deviceId: chosenDevice, dependantIds: children },
                {
                  onSuccess: (result) =>
                    onStarted(result.session.id, { code: result.code, deskUrl: result.deskUrl }),
                  onError: (error) => toast.error(errorMessage(error)),
                },
              )
            }
          >
            Start
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

function SessionState({
  sessionId,
  code,
  deskUrl,
  onAgain,
}: {
  sessionId: string;
  code: string;
  deskUrl: string;
  onAgain: () => void;
}) {
  const state = useOp(
    "agreement.desk.get",
    { sessionId },
    {
      refetchInterval: (query) => (query.state.data?.session.state === "ended" ? false : 2_000),
    },
  );
  const end = useOpMutation("agreement.desk.end", { invalidates: ["agreement."] });
  const s = state.data?.session;
  return (
    <Card data-testid="desk-session">
      <CardHeader>
        <CardTitle>Sign at the desk</CardTitle>
      </CardHeader>
      <CardContent className="grid gap-3 text-sm">
        {s?.state === "waiting" && (
          <>
            <p>
              On {s.device.name}, at <span className="font-mono">{deskUrl}</span>, type this code.
              It works once, until {formatDateTime(s.codeExpiresAt)}.
            </p>
            <p
              className="rounded-md border p-4 text-center font-mono text-3xl tracking-widest"
              data-testid="desk-code"
            >
              {code}
            </p>
          </>
        )}
        {s?.state === "claimed" && (
          <p data-testid="desk-state">
            Claimed on {s.claimedOn?.name ?? "the tablet"}
            {s.claimedAt ? ` at ${formatDateTime(s.claimedAt)}` : ""}. Signed so far: {s.signed}.
          </p>
        )}
        {s?.state === "ended" && (
          <div className="grid gap-1" data-testid="desk-state">
            <p>
              {ENDED[s.endReason ?? ""] ?? "Ended"}
              {s.endReason === "wrong_device" && s.claimedOn ? ` (${s.claimedOn.name})` : ""}.
            </p>
            <p className="text-muted-foreground">Signed in it: {s.signed}.</p>
          </div>
        )}
        {s && (
          <Badge variant="outline" className="w-fit">
            {s.state === "waiting" ? "Waiting" : s.state === "claimed" ? "On the tablet" : "Ended"}
          </Badge>
        )}
        <div className="flex gap-2">
          {s && s.state !== "ended" ? (
            <Button
              variant="outline"
              disabled={end.isPending}
              onClick={() =>
                end.mutate({ sessionId }, { onError: (error) => toast.error(errorMessage(error)) })
              }
            >
              End
            </Button>
          ) : (
            <Button variant="outline" onClick={onAgain}>
              Start another
            </Button>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
