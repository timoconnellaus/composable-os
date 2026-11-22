// What a reviewer sees for a queued extension tool, in the Approvals inbox and the chat's card.
import { toolInputs } from "./describe.ts";

/**
 * A queued extension tool (ADR 0022 amendment, 2026-11-22): it is not dry-run, so there is no diff
 * to show. The reviewer sees that it has not run and what it will be run with.
 */
export function ToolCallPreview({ input, pending }: { input: unknown; pending: boolean }) {
  const inputs = toolInputs(input);
  return (
    <div className="grid gap-1.5 text-sm" data-testid="tool-call-preview">
      {pending && (
        <p className="text-muted-foreground">
          Nothing has run yet. The tool runs once you approve, and what it changes is decided then.
        </p>
      )}
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
