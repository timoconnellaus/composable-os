// Settings → Orders (admins; stage 25): the currency every order is in, how long an unpaid order
// lasts, the least part payment towards a balance, and the sites a buyer may come back to after
// paying (order.settings.get / order.settings.update). Payments are taken on the provider's page.
import { Button } from "@composable-os/ui/components/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@composable-os/ui/components/card";
import { Input } from "@composable-os/ui/components/input";
import { Label } from "@composable-os/ui/components/label";
import { Skeleton } from "@composable-os/ui/components/skeleton";
import { Textarea } from "@composable-os/ui/components/textarea";
import { createFileRoute, Link } from "@tanstack/react-router";
import { LockIcon } from "lucide-react";
import { type FormEvent, useState } from "react";
import { toast } from "sonner";
import { ErrorState } from "#/components/empty-state";
import { PageLayout } from "#/components/layout/page-layout";
import { fromMajorInput, toMajorInput } from "#/lib/money";
import { errorMessage, useOp, useOpMutation } from "#/lib/query";

export const Route = createFileRoute("/_app/settings/orders")({ component: OrderSettingsPage });

function OrderSettingsPage() {
  const { isAdmin } = Route.useRouteContext();
  return (
    <PageLayout
      title="Orders"
      width="md"
      back={{ to: "/settings", label: "Settings" }}
      description={
        <>
          Payments are taken on the payment provider's own page, never in this app. Connect a
          payment account in{" "}
          <Link to="/settings/integrations" className="underline underline-offset-4">
            Settings → Integrations
          </Link>
          .
        </>
      }
    >
      {isAdmin ? (
        <OrderSettingsForm />
      ) : (
        <p
          className="flex items-center gap-2 rounded-md border bg-muted/50 px-3 py-2 text-sm"
          role="note"
        >
          <LockIcon className="size-4" aria-hidden />
          Only admins can change order settings.
        </p>
      )}
    </PageLayout>
  );
}

function OrderSettingsForm() {
  const settings = useOp("order.settings.get", {});
  const update = useOpMutation("order.settings.update");
  const [error, setError] = useState<string | null>(null);

  if (settings.isPending) return <Skeleton className="h-80" />;
  if (settings.isError) {
    return (
      <ErrorState
        title="Could not load order settings"
        error={settings.error}
        onRetry={() => void settings.refetch()}
      />
    );
  }
  const current = settings.data;

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    const form = new FormData(event.currentTarget);
    const currency = String(form.get("currency") ?? "")
      .trim()
      .toUpperCase();
    if (currency && !/^[A-Z]{3}$/.test(currency)) {
      setError("A currency is three letters, e.g. AUD");
      return;
    }
    const expiryMinutes = Number(form.get("expiryMinutes"));
    if (!Number.isInteger(expiryMinutes) || expiryMinutes < 1) {
      setError("Minutes must be a whole number");
      return;
    }
    const pricedIn = currency || current.currency || "AUD";
    const minPartPayment = fromMajorInput(String(form.get("minPartPayment") ?? ""), pricedIn);
    if (minPartPayment === null) {
      setError(`Enter the least part payment in ${pricedIn}, e.g. 10.00`);
      return;
    }
    const returnOrigins = String(form.get("returnOrigins") ?? "")
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);
    try {
      await update.mutateAsync({
        ...(currency ? { currency } : {}),
        expiryMinutes,
        minPartPayment,
        returnOrigins,
      });
      toast.success("Order settings saved");
    } catch (err) {
      setError(errorMessage(err));
    }
  }

  const pricedIn = current.currency ?? "AUD";
  return (
    <Card>
      <CardHeader>
        <CardTitle>Orders and payments</CardTitle>
        <CardDescription>
          Orders already started keep the currency they were started in.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form
          onSubmit={onSubmit}
          className="grid gap-5"
          key={JSON.stringify(current)}
          data-testid="order-settings"
        >
          <div className="grid gap-2">
            <Label htmlFor="order-currency">Currency</Label>
            <Input
              id="order-currency"
              name="currency"
              defaultValue={current.currency ?? ""}
              placeholder="AUD"
              maxLength={3}
              autoCapitalize="characters"
              className="w-28 uppercase"
            />
            <p className="text-xs text-muted-foreground">
              {current.currency
                ? "Every new order is in this currency."
                : "Not set yet: nothing can be sold until it is."}
            </p>
          </div>
          <div className="grid gap-2">
            <Label htmlFor="order-expiry">Minutes an unpaid order lasts</Label>
            <Input
              id="order-expiry"
              name="expiryMinutes"
              type="number"
              min={1}
              required
              defaultValue={current.expiryMinutes}
              className="w-28"
            />
            <p className="text-xs text-muted-foreground">
              An order nothing has been paid on expires after this, and what it held goes back.
            </p>
          </div>
          <div className="grid gap-2">
            <Label htmlFor="order-min-part">Least part payment</Label>
            <Input
              id="order-min-part"
              name="minPartPayment"
              inputMode="decimal"
              required
              defaultValue={toMajorInput(current.minPartPayment, pricedIn)}
              className="w-36"
            />
            <p className="text-xs text-muted-foreground">
              The least a buyer may pay towards a balance at a time, in the order currency.
            </p>
          </div>
          <div className="grid gap-2">
            <Label htmlFor="order-origins">Sites a buyer may come back to</Label>
            <Textarea
              id="order-origins"
              name="returnOrigins"
              defaultValue={current.returnOrigins.join("\n")}
              placeholder="https://shop.example.com"
              rows={4}
            />
            <p className="text-xs text-muted-foreground">
              One site per line. After paying, the provider sends the buyer back to one of these.
            </p>
          </div>
          {error && (
            <p className="text-sm text-destructive" role="alert">
              {error}
            </p>
          )}
          <div>
            <Button type="submit" disabled={update.isPending}>
              {update.isPending ? "Saving…" : "Save"}
            </Button>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}
