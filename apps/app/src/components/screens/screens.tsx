// The shipped packs' staff screens in the admin (stage 47, ADR 0660). The host says which screens
// the signed-in person may open (`screens.mine`); the navigation, the record tabs and the screen's
// page render that answer and nothing else. A screen not in it renders "not found", and a block's
// own calls are the host's to refuse anyway.
//
// A screen's code is built into the admin (screens-plugin.ts) as one chunk each, loaded when it
// is opened. It is given its pack's hooks over the staff client (#/lib/staff-client: the host's
// HTTP surface on this origin, with the staff session) and nothing from the shell but its record's
// id. Each screen is wrapped in an error boundary, so one that throws leaves the shell standing.
// When a screen closes, everything its client read or sent is forgotten (`forgetScreen`).

import { SCREENS } from "virtual:cos-screens";
import type { HookCalls } from "@composable-os/client";
import { Skeleton } from "@composable-os/ui/components/skeleton";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useRouteContext } from "@tanstack/react-router";
import { TriangleAlertIcon } from "lucide-react";
import {
  Component,
  type ComponentType,
  type ErrorInfo,
  type ReactNode,
  useEffect,
  useMemo,
  useState,
} from "react";
import { EmptyState } from "#/components/empty-state";

export { NotFoundPage } from "#/components/not-found";

import type { CoreOutput } from "@composable-os/core";
import { callOp } from "#/lib/operations";
import { forgetScreen, staffClient } from "#/lib/staff-client";

type MyScreens = CoreOutput<"screens.mine">["screens"];
export type MyScreen = MyScreens[number];

/** The screens the host lets the signed-in person open (`screens.mine`). */
/**
 * The screens the host lets the signed-in person open (`screens.mine`), keyed by the account, so
 * another account signed in on the same page never sees this one's list.
 */
export function useMyScreens() {
  const { user } = useRouteContext({ from: "/_app" });
  return useQuery({
    queryKey: [...MY_SCREENS_KEY, user.id],
    queryFn: () => callOp("screens.mine", {}),
    staleTime: 60_000,
  });
}

/** Every account's `screens.mine` (the key's prefix). */
export const MY_SCREENS_KEY = ["op", "screens.mine"] as const;

/** How often a screen's refusals may ask for the list again (the first asks at once). */
const REFUSAL_ASK_MS = 5_000;
let lastRefusalAsk = 0;

/** One screen's failure, kept to the screen: the shell and the navigation stay. */
class ScreenBoundary extends Component<
  { label: string; children: ReactNode },
  { failed: boolean }
> {
  override state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  override componentDidCatch(_error: unknown, _info: ErrorInfo) {
    // Nothing of the error is logged or sent: a block's error may carry what it was showing.
  }

  override render() {
    if (!this.state.failed) return this.props.children;
    return (
      <EmptyState
        icon={TriangleAlertIcon}
        title={`${this.props.label} stopped working`}
        description="Reload the page to try again. The rest of the app still works."
        className="my-6"
      />
    );
  }
}

type Loaded = {
  Component: ComponentType<Record<string, unknown>>;
  createHooks: (react: unknown, client: unknown) => unknown;
  calls: Readonly<Record<string, readonly string[]>>;
};

/**
 * Core's own staff screens (`pack: "core"`, `CORE_SCREENS` in screens.mine): the admin's own
 * components, each a chunk of its own, given nothing from the shell. Stage 44 step 6: Sign at
 * the desk.
 */
const CORE_SCREENS: Readonly<Record<string, () => Promise<ComponentType>>> = {
  desk: () =>
    import("#/components/agreements/sign-at-desk").then((m) => m.SignAtDeskScreen as ComponentType),
};

/** Whether the build holds this screen (a screen the host lists that this build lacks: none). */
export const isBuiltScreen = (pack: string, key: string) =>
  pack === "core" ? Object.hasOwn(CORE_SCREENS, key) : `${pack}/${key}` in SCREENS;

/** One of core's screens, loaded when shown, in the same boundary as a pack's. */
function CoreScreenView({ screen }: { screen: MyScreen }) {
  const [View, setView] = useState<ComponentType | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let live = true;
    const load = Object.hasOwn(CORE_SCREENS, screen.key) ? CORE_SCREENS[screen.key] : undefined;
    if (!load) {
      setFailed(true);
      return;
    }
    load()
      .then((component) => {
        if (live) setView(() => component);
      })
      .catch(() => {
        if (live) setFailed(true);
      });
    return () => {
      live = false;
    };
  }, [screen.key]);
  if (failed) {
    return (
      <EmptyState
        icon={TriangleAlertIcon}
        title={`${screen.label} could not be loaded`}
        description="Reload the page to try again."
        className="my-6"
      />
    );
  }
  if (!View) return <Skeleton className="h-48" aria-busy="true" />;
  return (
    <ScreenBoundary label={screen.label}>
      <div data-screen={`core/${screen.key}`}>
        <View />
      </div>
    </ScreenBoundary>
  );
}

/**
 * One screen, loaded when shown, with its pack's hooks as the prop named for the pack and its
 * record's id as the prop it declares. Forgets its data when it closes.
 */
export function ScreenView({
  screen,
  recordId,
}: {
  screen: MyScreen;
  /** The record a record screen is shown on; absent when opened from the navigation. */
  recordId?: string;
}) {
  if (screen.pack === "core") return <CoreScreenView screen={screen} />;
  return <PackScreenView screen={screen} {...(recordId ? { recordId } : {})} />;
}

function PackScreenView({ screen, recordId }: { screen: MyScreen; recordId?: string }) {
  const scope = `${screen.pack}/${screen.key}`;
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [failed, setFailed] = useState(false);
  const queryClient = useQueryClient();
  useEffect(() => {
    let live = true;
    const load = SCREENS[scope];
    if (!load) {
      setFailed(true);
      return;
    }
    load()
      .then((module) => {
        if (!live) return;
        if (typeof module.Component !== "function" || typeof module.createHooks !== "function") {
          setFailed(true);
          return;
        }
        setLoaded({
          Component: module.Component as Loaded["Component"],
          createHooks: module.createHooks as Loaded["createHooks"],
          calls: module.calls,
        });
      })
      .catch(() => {
        if (live) setFailed(true);
      });
    return () => {
      live = false;
    };
  }, [scope]);
  // What the screen read and sent is held no longer than it is open.
  useEffect(() => () => forgetScreen(queryClient, scope), [queryClient, scope]);
  const hooks = useMemo(
    () =>
      loaded
        ? loaded.createHooks(
            { useQuery, useMutation, useState, useEffect },
            staffClient(loaded.calls as Record<string, HookCalls>, scope, () => {
              // A refusal can mean a right was taken away: ask the host again at once, so a
              // screen that is no longer theirs goes now, not when the cached list goes stale.
              // Refusals that keep coming (retries, polling) ask at most once in a while.
              const now = Date.now();
              if (now - lastRefusalAsk < REFUSAL_ASK_MS) return;
              lastRefusalAsk = now;
              void queryClient.invalidateQueries({ queryKey: MY_SCREENS_KEY });
            }),
          )
        : null,
    [loaded, scope, queryClient],
  );
  if (failed) {
    return (
      <EmptyState
        icon={TriangleAlertIcon}
        title={`${screen.label} could not be loaded`}
        description="Reload the page to try again."
        className="my-6"
      />
    );
  }
  if (!loaded || !hooks) return <Skeleton className="h-48" aria-busy="true" />;
  const Screen = loaded.Component;
  const props: Record<string, unknown> = { [screen.pack]: hooks };
  if (screen.record && recordId) props[screen.record.as] = recordId;
  return (
    <ScreenBoundary label={screen.label}>
      <div data-screen={scope}>
        <Screen {...props} />
      </div>
    </ScreenBoundary>
  );
}

/** The navigation's sections: one per `nav.group`, its screens in order. Groups by name. */
export function screenGroups(
  screens: readonly MyScreen[],
): { group: string; screens: MyScreen[] }[] {
  const groups = new Map<string, MyScreen[]>();
  for (const screen of screens) {
    if (!screen.nav || !isBuiltScreen(screen.pack, screen.key)) continue;
    const list = groups.get(screen.nav.group) ?? [];
    list.push(screen);
    groups.set(screen.nav.group, list);
  }
  return [...groups.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([group, list]) => ({
      group,
      screens: list.sort((a, b) => (a.nav?.order ?? 0) - (b.nav?.order ?? 0)),
    }));
}

/** Record tab values of screens: `s:<pack>.<screen>`. */
export const isScreenTab = (tab: unknown): tab is string =>
  typeof tab === "string" && /^s:[a-z][a-z0-9]*\.[a-zA-Z0-9]+$/.test(tab);
