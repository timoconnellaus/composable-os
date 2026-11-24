// Payment method (stage 48), for the web: the card the signed-in customer pays their
// subscriptions with is kept by the payment provider, and changed on the provider's page, with
// their past invoices (subscription.portal). One button for every subscription they pay. The shell
// shows this section only to someone who pays one; the host refuses the page to anyone else.
import { type AccountHooks, accountErrorWords } from "@composable-os/client";
import { useState } from "react";
import { Button } from "../ui-button/button.tsx";

export function PaymentMethod({
  account,
  returnUrl,
}: {
  account: Pick<AccountHooks, "useBillingPortal">;
  /** Where the provider's page's back link goes (one of the host's listed origins). */
  returnUrl: string;
}) {
  const portal = account.useBillingPortal();
  const [problem, setProblem] = useState<string | null>(null);

  async function open() {
    setProblem(null);
    try {
      // The provider's page opens on its own: it cannot be put in a frame.
      const opened = await portal.mutateAsync({ returnUrl });
      window.location.assign(opened.url);
    } catch (e) {
      setProblem(accountErrorWords(e));
    }
  }

  return (
    <div className="grid gap-3">
      <p className="text-sm">
        Your card is kept by the payment provider. Change it, or see your past invoices, on their
        page.
      </p>
      <div>
        <Button type="button" disabled={portal.isPending} onClick={() => void open()}>
          Change card and see invoices
        </Button>
      </div>
      {problem ? <p role="alert">{problem}</p> : null}
    </div>
  );
}
