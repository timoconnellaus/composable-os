// The host's plain checkout start (stage 25; public): `/buy?object=<object>&id=<recordId>`. The
// buyer gives an email address, a quantity and how they pay; the host starts the order, prices
// it from the record, and the buyer goes on to their order page to pay. Client apps have their
// own; this one is for development and for a deployment without one.
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
import { RadioGroup, RadioGroupItem } from "@composable-os/ui/components/radio-group";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { type FormEvent, useEffect, useState } from "react";
import { guestStart } from "../server/orders.public.ts";

interface BuySearch {
  object?: string;
  id?: string;
}

export const Route = createFileRoute("/buy")({
  validateSearch: (search: Record<string, unknown>): BuySearch => ({
    ...(typeof search.object === "string" && search.object ? { object: search.object } : {}),
    ...(typeof search.id === "string" && search.id ? { id: search.id } : {}),
  }),
  head: () => ({ meta: [{ name: "robots", content: "noindex" }] }),
  component: BuyPage,
});

function BuyPage() {
  const { object, id } = Route.useSearch();
  const navigate = useNavigate();
  const [pay, setPay] = useState<"full" | "deposit">("full");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  // Until React hydrates, a click would submit the form natively; keep it disabled until then.
  const [hydrated, setHydrated] = useState(false);
  useEffect(() => setHydrated(true), []);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!object || !id) return;
    setError(null);
    const form = new FormData(event.currentTarget);
    const quantity = Number(form.get("quantity"));
    if (!Number.isInteger(quantity) || quantity < 1) {
      setError("Quantity must be a whole number of at least 1");
      return;
    }
    setPending(true);
    try {
      const result = await guestStart({
        data: {
          object,
          recordId: id,
          quantity,
          email: String(form.get("email") ?? ""),
          pay,
        },
      });
      if (!result.ok) {
        setError(result.error.message);
        setPending(false);
        return;
      }
      await navigate({
        to: "/order/$id",
        params: { id: result.data.id },
        search: { token: result.data.token },
      });
    } catch {
      setError("Could not start the order. Try again in a moment.");
      setPending(false);
    }
  }

  return (
    <div className="flex min-h-svh justify-center px-4 py-8 sm:items-center sm:p-6">
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle>Buy</CardTitle>
          <CardDescription>
            You pay on the payment provider's own page after this. Keep the link to your order: it
            is the way back to it.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {!object || !id ? (
            <p className="text-sm text-muted-foreground" role="alert">
              This link does not say what to buy.
            </p>
          ) : (
            <form onSubmit={onSubmit} className="grid gap-4">
              <div className="grid gap-2">
                <Label htmlFor="buy-email">Email</Label>
                <Input
                  id="buy-email"
                  name="email"
                  type="email"
                  autoComplete="email"
                  required
                  maxLength={320}
                />
              </div>
              <div className="grid gap-2">
                <Label htmlFor="buy-quantity">Quantity</Label>
                <Input
                  id="buy-quantity"
                  name="quantity"
                  type="number"
                  min={1}
                  max={1000}
                  defaultValue={1}
                  required
                  className="w-28"
                />
              </div>
              <fieldset className="grid gap-2">
                <legend className="mb-2 text-sm font-medium">How you pay</legend>
                <RadioGroup value={pay} onValueChange={(v) => setPay(v as "full" | "deposit")}>
                  <div className="flex items-center gap-2">
                    <RadioGroupItem value="full" id="buy-pay-full" />
                    <Label htmlFor="buy-pay-full" className="font-normal">
                      Pay in full
                    </Label>
                  </div>
                  <div className="flex items-center gap-2">
                    <RadioGroupItem value="deposit" id="buy-pay-deposit" />
                    <Label htmlFor="buy-pay-deposit" className="font-normal">
                      Pay a deposit
                    </Label>
                  </div>
                </RadioGroup>
              </fieldset>
              {error && (
                <p className="text-sm text-destructive" role="alert">
                  {error}
                </p>
              )}
              <Button type="submit" data-testid="buy-continue" disabled={!hydrated || pending}>
                {pending ? "Starting your order…" : "Continue"}
              </Button>
            </form>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
