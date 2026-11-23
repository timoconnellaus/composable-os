// The navigation's sections for the shipped packs' staff screens (stage 47, ADR 0660): one per
// `nav.group`, holding the screens the host lists for the signed-in person (`screens.mine`) and
// nothing else, so a screen they may not open is never named, not even greyed out.
import {
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  useSidebar,
} from "@composable-os/ui/components/sidebar";
import { Link } from "@tanstack/react-router";
import { LayoutPanelLeftIcon } from "lucide-react";
import { screenGroups, useMyScreens } from "./screens.tsx";

export function ScreensNav() {
  const { setOpenMobile } = useSidebar();
  const mine = useMyScreens();
  const groups = screenGroups(mine.data?.screens ?? []);
  return groups.map(({ group, screens }) => (
    <SidebarGroup key={group} data-testid={`screens-nav-${group}`}>
      <SidebarGroupLabel>{group}</SidebarGroupLabel>
      <SidebarGroupContent>
        <SidebarMenu>
          {screens.map((screen) => (
            <SidebarMenuItem key={`${screen.pack}/${screen.key}`}>
              <SidebarMenuButton asChild tooltip={screen.label}>
                <Link
                  to="/s/$pack/$screen"
                  params={{ pack: screen.pack, screen: screen.key }}
                  activeProps={{ "data-active": true, "aria-current": "page" }}
                  onClick={() => setOpenMobile(false)}
                >
                  <LayoutPanelLeftIcon />
                  <span>{screen.label}</span>
                </Link>
              </SidebarMenuButton>
            </SidebarMenuItem>
          ))}
        </SidebarMenu>
      </SidebarGroupContent>
    </SidebarGroup>
  ));
}
