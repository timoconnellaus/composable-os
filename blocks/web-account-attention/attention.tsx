// Needs your attention (stage 48), for the web: the top of My account. What needs the signed-in
// customer, or a child they act for, soonest first: a document to agree to, a card payment that
// failed, a payment their bank waits on, the rest of a deposit, an order they started paying for,
// a pass about to run out or used up, a free trial about to end, a form they were asked to fill
// in. Each says whose it is when it is a child's, and leads to where it is dealt with: a section
// of the page (`onSection`; money owed on an order, the order's row in Orders, where it is paid),
// the provider's page for a payment to confirm (only an `https:` address, `followableUrl`), or the
// form (`onFillForm`, where the app has the form's page). An item goes once the host says its cause is
// fixed. What needs attention is the host's answer (me.attention, ADR 0711): nothing is worked out
// here, and where an item leads is a lookup among the sections the host lists.
import {
  type AccountHooks,
  type AccountSection,
  type AttentionTarget,
  attentionTarget,
  attentionWords,
  followableUrl,
} from "@composable-os/client";
import { Button } from "../ui-button/button.tsx";

type Hooks = Pick<AccountHooks, "useAttention"> & Partial<Pick<AccountHooks, "useSubscriptions">>;

export function NeedsAttention({
  account,
  sections,
  onSection,
  onFillForm,
}: {
  account: Hooks;
  /** The sections the page shows, as the host listed them. */
  sections: readonly AccountSection[];
  /** Goes to a section of the page; for money owed on an order, to that order in it. */
  onSection: (key: string, order?: string) => void;
  /** Opens a form the customer was asked to fill in, by its personal link's id. */
  onFillForm?: (linkId: string) => void;
}) {
  const attention = account.useAttention();
  const subscriptions = account.useSubscriptions?.();
  if (attention.isPending) return <p aria-busy="true">Checking what needs your attention…</p>;
  if (attention.error || !attention.data) {
    return <p role="alert">We could not check what needs your attention.</p>;
  }
  const items = attention.data.items;
  const go = (target: AttentionTarget) => {
    if (target.kind === "section") onSection(target.key, target.order);
    else if (target.kind === "page") {
      if (followableUrl(target.url)) window.location.assign(target.url);
    } else onFillForm?.(target.link);
  };
  return (
    <section
      className="grid gap-3 rounded-md border p-4"
      aria-labelledby="account-attention-title"
      data-testid="needs-attention"
    >
      <h2 id="account-attention-title" className="text-lg font-semibold">
        Needs your attention
      </h2>
      {items.length ? (
        <ul className="grid gap-2">
          {items.map((item) => {
            const words = attentionWords(item);
            const target = attentionTarget(item, sections, subscriptions?.data?.items);
            const usable = target && (target.kind !== "form" || onFillForm) ? target : null;
            return (
              <li
                key={item.key}
                className="flex flex-wrap items-center justify-between gap-3"
                data-kind={item.kind}
                data-person={item.person.self ? "self" : item.person.id}
              >
                <div className="grid gap-0.5">
                  {words.whose ? (
                    <span className="text-muted-foreground text-xs font-medium uppercase">
                      {words.whose}
                    </span>
                  ) : null}
                  <strong>{words.title}</strong>
                  {words.detail ? <span className="text-sm">{words.detail}</span> : null}
                </div>
                {usable && words.action ? (
                  <Button type="button" variant="outline" onClick={() => go(usable)}>
                    {words.action}
                  </Button>
                ) : null}
              </li>
            );
          })}
        </ul>
      ) : (
        <p className="text-muted-foreground text-sm">Nothing needs your attention.</p>
      )}
    </section>
  );
}
