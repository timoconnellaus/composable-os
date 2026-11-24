// The admin's small shell for a fixed-role account (stage 47, ADR 0660): a coach, the door, a
// rostered cleaner (ADR 0436). Its screens (from `screens.mine`), its account menu and sign out;
// no records, dashboards, settings, assistant, search, notifications or create dialogs. It makes
// one call, `screens.mine`, which every pack role reaches: nothing it renders asks the host for
// anything the role is refused. Whether an account gets this shell is the host's answer
// (`getSession`, read from the account); a page forced to show the full shell would have every
// other call refused by the host anyway.
import { Button } from "@composable-os/ui/components/button";
import {
  Sidebar,
  SidebarContent,
  SidebarHeader,
  SidebarInset,
  SidebarProvider,
  SidebarTrigger,
} from "@composable-os/ui/components/sidebar";
import { Skeleton } from "@composable-os/ui/components/skeleton";
import { cn } from "@composable-os/ui/lib/utils";
import { Link, Outlet, useRouteContext } from "@tanstack/react-router";
import { SmartphoneIcon } from "lucide-react";
import { useEffect } from "react";
import { SHELL_HEADER_HEIGHT } from "../assistant/dock-state.ts";
import { EmptyState } from "../empty-state.tsx";
import { useProductName } from "../product-name.ts";
import { UserMenu } from "../user-menu.tsx";
import { screenGroups, useMyScreens } from "./screens.tsx";
import { ScreensNav } from "./screens-nav.tsx";

export function FixedRoleLayout() {
  const { principal, signOutUrl } = useRouteContext({ from: "/_app" });
  const productName = useProductName();
  // Marks the signed-in shell interactive, as the full shell does (the e2e specs wait for it).
  useEffect(() => {
    document.documentElement.dataset.hydrated = "true";
  }, []);
  return (
    <SidebarProvider className="h-dvh overflow-hidden" data-shell="fixed-role">
      <Sidebar
        aria-label="Main navigation"
        className="h-dvh pt-[env(safe-area-inset-top)] pb-[env(safe-area-inset-bottom)]"
      >
        <SidebarHeader>
          <div className="px-2 py-1.5 text-lg font-semibold tracking-tight">{productName}</div>
        </SidebarHeader>
        <SidebarContent>
          <ScreensNav />
        </SidebarContent>
      </Sidebar>
      <SidebarInset className="min-h-0 min-w-0 overflow-hidden pr-[env(safe-area-inset-right)]">
        <header
          className={cn(
            "@container z-10 flex shrink-0 items-center gap-2 border-b bg-background px-4 pt-[env(safe-area-inset-top)]",
            SHELL_HEADER_HEIGHT,
          )}
          data-testid="app-header"
        >
          <SidebarTrigger aria-label="Toggle navigation" />
          <div className="flex-1" />
          <UserMenu principal={principal} signOutUrl={signOutUrl} confirmEmail={false} />
        </header>
        <div className="min-h-0 min-w-0 flex-1 overflow-y-auto" id="main" tabIndex={-1}>
          {/* Its home is the index route's, which renders FixedRoleHome for a pack role. */}
          <Outlet />
        </div>
      </SidebarInset>
    </SidebarProvider>
  );
}

/** Home for a fixed-role account: its screens, or a page saying its work is in the app. */
export function FixedRoleHome() {
  const mine = useMyScreens();
  if (mine.isPending) return <Skeleton className="m-6 h-48" />;
  const groups = screenGroups(mine.data?.screens ?? []);
  if (!groups.length) {
    return (
      <EmptyState
        icon={SmartphoneIcon}
        title="Your work is in the app"
        description="There is nothing for your account to open here. Sign in to the staff app on your phone."
        className="mx-4 my-6 sm:mx-auto sm:max-w-xl"
      />
    );
  }
  return (
    <div className="mx-auto grid w-full max-w-3xl gap-6 px-4 py-6 sm:px-6">
      <h1 className="text-xl font-semibold" data-page-title tabIndex={-1}>
        Your screens
      </h1>
      {groups.map(({ group, screens }) => (
        <section key={group} className="grid gap-2" aria-label={group}>
          <h2 className="text-sm font-medium text-muted-foreground">{group}</h2>
          <div className="flex flex-wrap gap-2">
            {screens.map((screen) => (
              <Button key={`${screen.pack}/${screen.key}`} asChild variant="outline">
                <Link to="/s/$pack/$screen" params={{ pack: screen.pack, screen: screen.key }}>
                  {screen.label}
                </Link>
              </Button>
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}
