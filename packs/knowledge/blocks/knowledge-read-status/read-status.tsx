// Read status (stage 38 step 6, ADR 0708): for those who manage procedures, every published
// procedure staff must read with how many have confirmed its current version of how many must,
// and for one, everyone who must read it: who confirmed and when, who has not and since when;
// with an export as CSV. Declared as the admin's Read status screen, gated by the pack's
// `readStatus` tool: admins and those granted knowledge:manage, a person only.
//
// Who may see this is the host's answer (ADR 0702 as amended by ADR 0706): the tool is refused to
// anyone else, and this then shows the refusal and nothing more. What it shows is only the tool's
// answer, kept no longer than it is on screen (`gcTime: 0` in the hook); nothing is stored or
// logged here, and the CSV is made from the answer on screen when the person asks for it.
import type { KnowledgeHooks, ProcedureStatus } from "@composable-os/pack-knowledge/client";
import {
  dayWords,
  knowledgeRefusal,
  readStatusCsv,
  versionLine,
} from "@composable-os/pack-knowledge/client";
import { useId, useState } from "react";
import { Button } from "../ui-button/button.tsx";

export type ReadStatusHooks = Pick<KnowledgeHooks, "useReadStatus">;

function Refused({ error }: { error: unknown }) {
  const refusal = knowledgeRefusal(error);
  return (
    <p role="alert" data-refusal={refusal.kind}>
      {refusal.kind === "forbidden"
        ? "Read status is for admins and the people they allow to manage procedures."
        : refusal.message}
    </p>
  );
}

/** Saves the CSV the person asked for, as a file: nothing of it is kept here. */
function download(name: string, text: string) {
  const url = URL.createObjectURL(new Blob([text], { type: "text/csv;charset=utf-8" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

const fileName = (title: string, version: number) =>
  `${
    title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 60) || "procedure"
  }-version-${version}-read-status.csv`;

function People({ status, locale }: { status: ProcedureStatus; locale?: string }) {
  const title = status.title ?? "Untitled";
  const confirmed = status.people.filter((p) => p.confirmed);
  const waiting = status.people.filter((p) => !p.confirmed);
  return (
    <div className="grid gap-3">
      <p className="text-sm text-muted-foreground">
        {versionLine(status.version, status.publishedAt, locale)} · must read:{" "}
        {status.everyone ? "everyone" : status.roles.join(", ") || "nobody"}
      </p>
      <p role="status">
        {confirmed.length} of {status.people.length} have confirmed this version.
      </p>
      <div>
        <Button
          type="button"
          variant="outline"
          onClick={() => download(fileName(title, status.version), readStatusCsv(status))}
        >
          Export as CSV
        </Button>
      </div>
      <table className="w-full text-left text-sm" aria-label={`Who has read ${title}`}>
        <thead>
          <tr>
            <th scope="col" className="py-1 pr-2">
              Name
            </th>
            <th scope="col" className="py-1 pr-2">
              Confirmed
            </th>
          </tr>
        </thead>
        <tbody>
          {[...waiting, ...confirmed].map((p) => (
            <tr
              key={p.account}
              className="border-t"
              data-person={p.account}
              data-state={p.confirmed ? "confirmed" : "to_read"}
            >
              <td className="py-1 pr-2">
                <span className="font-medium">{p.name}</span>
                <span className="block text-xs text-muted-foreground">{p.email}</span>
              </td>
              <td className="py-1 pr-2">
                {p.confirmed
                  ? `Yes, on ${dayWords(p.confirmed.confirmedAt, locale)}`
                  : `Not yet${p.since ? `: to read since ${dayWords(p.since, locale)}` : ""}${
                      p.lastConfirmed
                        ? ` (last confirmed version ${p.lastConfirmed.version} on ${dayWords(p.lastConfirmed.confirmedAt, locale)})`
                        : ""
                    }`}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function OneProcedure({
  knowledge,
  id,
  onBack,
  locale,
}: {
  knowledge: ReadStatusHooks;
  id: string;
  onBack: () => void;
  locale?: string;
}) {
  const answer = knowledge.useReadStatus(id);
  const headingId = useId();
  const status = answer.data?.procedure ?? null;
  return (
    <section className="grid max-w-3xl gap-3" aria-labelledby={headingId}>
      <div>
        <Button type="button" variant="outline" onClick={onBack}>
          Every procedure
        </Button>
      </div>
      <h2 id={headingId} className="text-lg font-semibold">
        {status?.title ?? "Read status"}
      </h2>
      {answer.isPending ? <p aria-busy="true">Loading who has read it…</p> : null}
      {answer.error ? <Refused error={answer.error} /> : null}
      {status ? <People status={status} {...(locale ? { locale } : {})} /> : null}
    </section>
  );
}

export function ReadStatus({ knowledge, locale }: { knowledge: ReadStatusHooks; locale?: string }) {
  const all = knowledge.useReadStatus();
  const [open, setOpen] = useState<string | null>(null);
  if (open) {
    return (
      <OneProcedure
        knowledge={knowledge}
        id={open}
        onBack={() => setOpen(null)}
        {...(locale ? { locale } : {})}
      />
    );
  }
  if (all.isPending) return <p aria-busy="true">Loading read status…</p>;
  if (all.error) return <Refused error={all.error} />;
  const procedures = all.data?.procedures ?? [];
  if (!procedures.length) {
    return <p>No published procedure asks anyone to confirm it yet.</p>;
  }
  return (
    <div className="grid max-w-3xl gap-2">
      <ul className="grid gap-2" aria-label="Procedures staff must read">
        {procedures.map((p) => (
          <li
            key={p.id}
            className="flex flex-wrap items-center justify-between gap-2 rounded-md border p-3"
            data-status-for={p.id}
          >
            <div className="grid gap-1">
              <span className="font-medium">{p.title ?? "Untitled"}</span>
              <span className="text-xs text-muted-foreground">
                {versionLine(p.version, p.publishedAt, locale)}
              </span>
              <span className="text-sm" data-counts="">
                {p.confirmed} of {p.mustRead} confirmed
              </span>
            </div>
            <Button
              type="button"
              variant="outline"
              onClick={() => setOpen(p.id)}
              aria-label={`Who has read ${p.title ?? "the procedure"}`}
            >
              Who has read it
            </Button>
          </li>
        ))}
      </ul>
    </div>
  );
}
