// What a reviewer sees for a queued extension tool, and the dry run's notes on any action, in the
// Approvals inbox and the chat's card.
import { toolInputs } from "./describe.ts";

/**
 * A queued extension tool (ADR 0022 amendment, 2026-11-22): it is not dry-run, so there is no diff
 * to show. The reviewer sees that it has not run and what it will be run with. A tool queued
 * before that release (`ranAtQueue`) was run by the old dry run: its changes may already have
 * been made, and the reviewer is told so.
 */
export function ToolCallPreview({
  input,
  pending,
  ranAtQueue,
  tool = true,
}: {
  input: unknown;
  pending: boolean;
  ranAtQueue: boolean;
  /**
   * False for any other call with nothing (or not everything) to preview: it runs on approval,
   * or the dry run noted what it could not show. Its inputs are then what there is to judge, so
   * the agent's reason is never the only description of what will happen.
   */
  tool?: boolean;
}) {
  const inputs = toolInputs(input);
  return (
    <div className="grid gap-1.5 text-sm" data-testid={tool ? "tool-call-preview" : "call-inputs"}>
      {!tool && (
        <p className="text-muted-foreground">
          {pending
            ? "Not all of this can be shown before it runs. It runs, once you approve, with:"
            : "It ran with:"}
        </p>
      )}
      {tool &&
        pending &&
        (ranAtQueue ? (
          <p className="text-destructive" data-testid="tool-ran-at-queue">
            Queued before an update that fixed how tools are checked: this tool already ran when it
            was queued, so its changes may already have been made. Approving runs it again and would
            repeat them. Rejecting it is recommended; check the records it names first.
          </p>
        ) : (
          <p className="text-muted-foreground">
            Nothing has run yet. The tool runs once you approve, and what it changes is decided
            then.
          </p>
        ))}
      {inputs.length > 0 && (
        <dl className="grid gap-x-3 gap-y-0.5 rounded-md border p-2.5 text-xs sm:grid-cols-[8rem_1fr]">
          {inputs.map(({ name, value }) => (
            <div key={name} className="contents">
              <dt className="text-muted-foreground">{name}</dt>
              <dd className="min-w-0 break-all font-mono">{value}</dd>
            </div>
          ))}
        </dl>
      )}
    </div>
  );
}

/** What the dry run could not show: parts that run only on approval, calls that need their own. */
export function DryRunNotes({ notes }: { notes: readonly string[] }) {
  if (!notes.length) return null;
  return (
    <ul className="grid gap-0.5 text-xs text-muted-foreground" data-testid="dry-run-notes">
      {notes.map((note) => (
        <li key={note}>{note}</li>
      ))}
    </ul>
  );
}
