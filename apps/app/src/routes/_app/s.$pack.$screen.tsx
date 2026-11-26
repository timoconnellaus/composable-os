// A shipped pack's staff screen in the admin (stage 47, ADR 0660): `/s/<pack>/<screen>`. Rendered
// only when the host lists it for the signed-in person (`screens.mine`); any other is "not found",
// whatever the URL says. Client-only (`ssr: false`): a screen's data is read in the browser as the
// person, never rendered or dehydrated on the server. The route carries ids only: `?record=<id>`
// opens a record screen on that record (ADR 0708), as its tab on the record page does, for an
// account that cannot open the record page (a pack role following a notice's link); the block,
// and the host behind it, decide what that record shows.
import { Skeleton } from "@composable-os/ui/components/skeleton";
import { createFileRoute } from "@tanstack/react-router";
import { PageLayout } from "#/components/layout/page-layout";
import {
  isBuiltScreen,
  NotFoundPage,
  ScreenView,
  useMyScreens,
} from "#/components/screens/screens";

/** A record id as the host makes them: letters, digits, `_` and `-`. */
const RECORD_ID = /^[A-Za-z0-9_-]{1,64}$/;

export const Route = createFileRoute("/_app/s/$pack/$screen")({
  ssr: false,
  validateSearch: (search: Record<string, unknown>): { record?: string } =>
    typeof search.record === "string" && RECORD_ID.test(search.record)
      ? { record: search.record }
      : {},
  head: () => ({ meta: [{ name: "robots", content: "noindex" }] }),
  component: ScreenPage,
});

function ScreenPage() {
  const { pack, screen } = Route.useParams();
  const { record } = Route.useSearch();
  const mine = useMyScreens();
  if (mine.isPending) return <Skeleton className="m-6 h-48" />;
  const found = mine.data?.screens.find((s) => s.pack === pack && s.key === screen);
  // Listed by the host and held by this build (an org extension's screens are not built in).
  if (!found || !isBuiltScreen(pack, screen)) return <NotFoundPage />;
  return (
    <PageLayout title={found.label}>
      {/* Keyed by the screen and its record: moving between them closes one and opens the other. */}
      <ScreenView
        key={`${pack}/${screen}/${record ?? ""}`}
        screen={found}
        {...(found.record && record ? { recordId: record } : {})}
      />
    </PageLayout>
  );
}
