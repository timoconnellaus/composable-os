// Family (stage 48), for the web: who the signed-in customer acts for (a child linked to them)
// and who acts for them (a parent or guardian). The links are the business's: staff make and end
// them (ADR 0540), so linking a child is a sentence here, not a form. Who is linked is the host's
// answer (me.family).
import type { AccountHooks } from "@composable-os/client";

export function YourFamily({ account }: { account: Pick<AccountHooks, "useFamily"> }) {
  const family = account.useFamily();
  if (family.isPending) return <p aria-busy="true">Loading your family…</p>;
  if (family.error || !family.data) return <p role="alert">We could not load your family.</p>;
  const { dependants, guardians } = family.data;
  return (
    <div className="grid gap-3">
      {dependants.length ? (
        <div className="grid gap-1">
          <h3 className="font-medium">You act for</h3>
          <ul className="grid gap-1" aria-label="You act for">
            {dependants.map((p) => (
              <li key={p.personId}>{p.name}</li>
            ))}
          </ul>
        </div>
      ) : null}
      {guardians.length ? (
        <div className="grid gap-1">
          <h3 className="font-medium">A parent or guardian who acts for you</h3>
          <ul className="grid gap-1" aria-label="Acts for you">
            {guardians.map((p) => (
              <li key={p.personId}>{p.name}</li>
            ))}
          </ul>
        </div>
      ) : null}
      {!dependants.length && !guardians.length ? (
        <p className="text-muted-foreground text-sm">Nobody is linked to your account.</p>
      ) : null}
      <p className="text-sm">
        To book for a child or agree for them, ask the business to link them to your account.
      </p>
    </div>
  );
}
