import type { Principal } from "@composable-os/auth";
import { Avatar, AvatarFallback } from "@composable-os/ui/components/avatar";
import { Button } from "@composable-os/ui/components/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@composable-os/ui/components/dropdown-menu";
import { LogOut, MailCheck, SunMoon } from "lucide-react";
import { useState } from "react";
import { authClient } from "../lib/auth-client.ts";
import { ConfirmEmailDialog, useEmailStatus } from "./confirm-email.tsx";
import { type Theme, useTheme } from "./theme.tsx";

function initials(name: string) {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase())
    .join("");
}

export function UserMenu({
  principal,
  signOutUrl,
  confirmEmail = true,
}: {
  principal: Principal;
  /** Set when sign-out is a plain URL (Cloudflare Access); otherwise Better Auth's API is used. */
  signOutUrl: string | null;
  /**
   * Offers confirming the account's email (`user.emailStatus`). False in a fixed-role account's
   * shell (stage 47), which makes no call its role is refused.
   */
  confirmEmail?: boolean;
}) {
  const { theme, setTheme } = useTheme();
  const emailStatus = useEmailStatus(confirmEmail);
  const [confirming, setConfirming] = useState(false);

  async function signOut() {
    if (signOutUrl) {
      window.location.assign(signOutUrl);
      return;
    }
    await authClient.signOut();
    window.location.assign("/sign-in");
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" className="gap-2 px-2" data-testid="user-menu">
          <Avatar className="size-7">
            <AvatarFallback>{initials(principal.name) || "?"}</AvatarFallback>
          </Avatar>
          <span className="hidden text-sm @lg:inline">{principal.name}</span>
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-56">
        <DropdownMenuLabel className="grid">
          <span>{principal.name}</span>
          <span className="text-xs font-normal text-muted-foreground">{principal.email}</span>
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuSub>
          <DropdownMenuSubTrigger>
            <SunMoon />
            Theme
          </DropdownMenuSubTrigger>
          <DropdownMenuSubContent>
            <DropdownMenuRadioGroup value={theme} onValueChange={(v) => setTheme(v as Theme)}>
              <DropdownMenuRadioItem value="light">Light</DropdownMenuRadioItem>
              <DropdownMenuRadioItem value="dark">Dark</DropdownMenuRadioItem>
              <DropdownMenuRadioItem value="system">System</DropdownMenuRadioItem>
            </DropdownMenuRadioGroup>
          </DropdownMenuSubContent>
        </DropdownMenuSub>
        <DropdownMenuSeparator />
        {emailStatus && !emailStatus.verified && (
          <DropdownMenuItem onSelect={() => setConfirming(true)}>
            <MailCheck />
            Confirm your email
          </DropdownMenuItem>
        )}
        <DropdownMenuItem onSelect={signOut}>
          <LogOut />
          Sign out
        </DropdownMenuItem>
      </DropdownMenuContent>
      {confirmEmail ? (
        <ConfirmEmailDialog open={confirming} onClose={() => setConfirming(false)} />
      ) : null}
    </DropdownMenu>
  );
}
