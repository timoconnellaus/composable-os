// Who may do what in the inbox's screens, from the permissions the host reports for the signed-in
// account (the session's navPermissions), never guessed from the role: a pack-role account holds
// none of them, and an account without `inbox:read` gets a plain "no access" page instead of the
// error a refused call would show. The host still checks every call.
import { useRouteContext } from "@tanstack/react-router";
import { LockIcon } from "lucide-react";
import { EmptyState } from "#/components/empty-state";

export function useInboxAccess(): { reads: boolean; works: boolean } {
  const { navPermissions } = useRouteContext({ from: "/_app" });
  return {
    reads: navPermissions.includes("inbox:read"),
    works: navPermissions.includes("inbox:work"),
  };
}

export function NoInboxAccess({ what = "the inbox" }: { what?: string }) {
  return (
    <EmptyState
      icon={LockIcon}
      title={`You do not have access to ${what}`}
      description="An admin decides who reads and works the shared inbox."
    />
  );
}
