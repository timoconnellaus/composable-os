// The capacity panel on a record page (stage 26, ADR 0433): for an object that declares a
// capacity, how many places the record has, how many are held while someone pays, how many are
// taken, and how many are left, with its pool's numbers when it draws on a parent's places.
// Staff edit the places in the record's own field; this card only reads (capacity.get).
import { Skeleton } from "@composable-os/ui/components/skeleton";
import { Link } from "@tanstack/react-router";
import { useOp } from "#/lib/query";

const STATUS: Record<string, string> = {
  available: "On sale",
  low: "Few left",
  sold_out: "Sold out",
};

const SHOW: Record<string, string> = {
  exact: "the number left",
  low: "a low-stock warning",
  availability: "only available or sold out",
};

function count(value: number | null | undefined) {
  return value === null || value === undefined ? "Unlimited" : String(value);
}

export function CapacityCard({ object, id }: { object: string; id: string }) {
  const capacity = useOp("capacity.get", { object, id });
  if (capacity.isPending) return <Skeleton className="h-32 w-full rounded-lg" />;
  if (capacity.error || !capacity.data) return null;
  const data = capacity.data;
  return (
    <section className="grid gap-3 rounded-lg border p-4 text-sm" data-testid="capacity-card">
      <div className="flex items-center justify-between">
        <h3 className="font-medium">Places</h3>
        <span className="text-muted-foreground">{STATUS[data.status] ?? data.status}</span>
      </div>
      <dl className="grid grid-cols-2 gap-1">
        <dt className="text-muted-foreground">Places</dt>
        <dd data-testid="capacity-places">{count(data.places)}</dd>
        <dt className="text-muted-foreground">Held (paying)</dt>
        <dd data-testid="capacity-held">{data.held ?? 0}</dd>
        <dt className="text-muted-foreground">Taken (paid)</dt>
        <dd data-testid="capacity-taken">{data.taken ?? 0}</dd>
        <dt className="text-muted-foreground">Available</dt>
        <dd data-testid="capacity-available">{count(data.available)}</dd>
      </dl>
      {data.pool && (
        <p className="text-muted-foreground">
          Also draws on{" "}
          <Link
            to="/x/$object/$id"
            params={{ object: data.pool.object, id: data.pool.id }}
            className="underline"
          >
            its pool
          </Link>
          : {count(data.pool.available)} of {count(data.pool.places)} left.
        </p>
      )}
      {data.show && (
        <p className="text-muted-foreground">Customers and the public see {SHOW[data.show]}.</p>
      )}
    </section>
  );
}
