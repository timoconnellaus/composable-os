// Development only: one pack's web block mounted on its own, for the e2e specs and for a person
// trying a block before copying it (stage 41). `/blocks?block=programs-builder&component=
// ProgramBuilder&props={"programId":"rec_…"}` renders that export of the block with the pack's
// hooks (as the prop named for the pack: `programs`, `ticketing`) over a client that calls the
// host's HTTP surface from the browser, as a client app's would: signed in as staff, it is staff;
// with a customer's cookie, that customer; with neither, the public. A prop given as
// `"signIn": "customer"` is the host's own customer sign-in by code (the two calls a client app's
// sign-in block makes through its own routes), for a block that signs a guest in on the spot.
//
// The blocks are read where they sit (`packs/<id>/blocks/<block>/`), their base-layer imports
// joined to `blocks/` by pack-blocks-plugin.ts. A production build mounts nothing. Each pack's
// hooks come from the build's generated map (`PACK_HOOKS`, screens-plugin.ts), so the app's source
// names no pack (stage 47). The admin shows a shipped pack's declared staff screens in its own
// shell (`/s/<pack>/<screen>`); this page stays for blocks that are not screens and for specs that
// mount a block with props.
//
// The base layer's web blocks that call the host (`blocks/web-*`: the agreement blocks, stage 44)
// mount here too, and every block is also given the agreements hooks as `agreements`
// (createAgreementsHooks from @composable-os/client), for the inline agreement step.
import {
  AGREEMENTS_HOOKS_CALL,
  type AgreementsClient,
  createAgreementsHooks,
  type HookCalls,
} from "@composable-os/client";

/** A client holding every operation (the `operations` is what the hooks read). */
type FullClient<C> = C & { operations: Record<string, unknown> };

import { PACK_HOOKS } from "virtual:cos-screens";
import { useMutation, useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { type ComponentType, useEffect, useState } from "react";
import { staffClient } from "#/lib/staff-client";

interface BlocksSearch {
  block?: string;
  component?: string;
  props?: string;
}

export const Route = createFileRoute("/blocks")({
  validateSearch: (search: Record<string, unknown>): BlocksSearch => ({
    ...(typeof search.block === "string" ? { block: search.block } : {}),
    ...(typeof search.component === "string" ? { component: search.component } : {}),
    ...(typeof search.props === "string"
      ? { props: search.props }
      : search.props && typeof search.props === "object"
        ? { props: JSON.stringify(search.props) }
        : {}),
  }),
  head: () => ({ meta: [{ name: "robots", content: "noindex" }] }),
  component: BlocksPage,
});

/** Every pack's web block files, loaded when asked for (development only). */
const files: Record<string, () => Promise<Record<string, unknown>>> = import.meta.env.DEV
  ? import.meta.glob<Record<string, unknown>>([
      "../../../../packs/*/blocks/*/*.tsx",
      // Native blocks are React Native: a phone renders them, never this page.
      "!../../../../packs/*/blocks/*-native-*/*.tsx",
      // The base layer's web blocks that call the host (sign-in posts to the app's own routes).
      "../../../../blocks/web-*/*.tsx",
    ])
  : {};

/** A typed client's shape over the browser's own calls (#/lib/staff-client), holding every
 * operation a pack's hooks call (`calls`, the pack's `*_HOOKS_CALL`): this page shows every block
 * (ADR 0453). */
function browserClient<C>(calls: Readonly<Record<string, HookCalls>>): C {
  return staffClient<C>(calls, "blocks");
}

// biome-ignore lint/suspicious/noExplicitAny: the hooks are typed by each pack; this passes them through.
type AnyHooks = any;

function customerAuth(path: string, body: unknown): Promise<Response> {
  return fetch(`/api/customer-auth${path}`, {
    method: "POST",
    credentials: "same-origin",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

/** The host's customer sign-in by code, from the browser (it sets the customer's cookie). */
const customerSignIn = {
  requestCode: async (email: string) =>
    (await customerAuth("/email-otp/send-verification-otp", { email, type: "sign-in" })).ok,
  // The host's answer says whether the account is ready or waits for staff to merge people.
  confirm: async (email: string, otp: string) => {
    const response = await customerAuth("/sign-in/email-otp", { email, otp });
    if (!response.ok) return null;
    const { account } = (await response.json()) as { account?: unknown };
    return account === "ready" ? ("ready" as const) : ("needs_attention" as const);
  },
};

/**
 * The pack's hooks over the browser's client, loaded with its headless entry. Every pack's is in
 * the build's generated map (screens-plugin.ts): this page names no pack.
 */
function usePackHooks(pack: string): AnyHooks {
  const [hooks, setHooks] = useState<{ pack: string; hooks: AnyHooks } | null>(null);
  useEffect(() => {
    let live = true;
    const load = PACK_HOOKS[pack];
    if (!load) return;
    void load().then(({ createHooks, calls }) => {
      if (!live) return;
      // The app's own React Query: a query is refetched when the block asks, as a client app's is.
      const react = { useQuery, useMutation, useState, useEffect };
      const make = createHooks as (react: unknown, client: unknown) => AnyHooks;
      setHooks({
        pack,
        hooks: make(react, browserClient(calls as Record<string, HookCalls>)),
      });
    });
    return () => {
      live = false;
    };
  }, [pack]);
  return hooks?.pack === pack ? hooks.hooks : null;
}

function BlocksPage() {
  const { block, component, props } = Route.useSearch();
  const [Component, setComponent] = useState<ComponentType<Record<string, unknown>> | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  // A base-layer block (`web-…`) belongs to no pack.
  const base = block?.startsWith("web-") ?? false;
  const pack = base ? "" : (block?.split("-")[0] ?? "");
  const hooks = usePackHooks(pack);
  const [agreements] = useState(() =>
    createAgreementsHooks(
      { useQuery, useMutation } as never,
      browserClient<FullClient<AgreementsClient>>(AGREEMENTS_HOOKS_CALL),
    ),
  );
  useEffect(() => {
    if (!block || !component) return;
    // A block may have several files (the roster week and its assign panel): the export is looked
    // for in each.
    const keys = Object.keys(files).filter((path) =>
      path.includes(base ? `/blocks/${block}/` : `/packs/${pack}/blocks/${block}/`),
    );
    if (!keys.length) {
      setFailed(`No web block ${block}`);
      return;
    }
    Promise.all(keys.map((key) => files[key]?.()))
      .then((modules) => {
        const found = modules.map((module) => module?.[component]).find((f) => f !== undefined);
        if (typeof found !== "function") setFailed(`${block} has no export ${component}`);
        else setComponent(() => found as ComponentType<Record<string, unknown>>);
      })
      .catch((error: unknown) => setFailed(String(error)));
  }, [block, component, pack, base]);
  if (!import.meta.env.DEV) return <p>Blocks are mounted here in development only.</p>;
  if (!block || !component) return <p>Name a block and its export: /blocks?block=…&component=…</p>;
  if (failed) return <p role="alert">{failed}</p>;
  if (!Component || (!hooks && !base)) return <p aria-busy="true">Loading {block}…</p>;
  const extra = props ? (JSON.parse(props) as Record<string, unknown>) : {};
  if (extra.signIn === "customer") extra.signIn = customerSignIn;
  return (
    <main className="mx-auto max-w-5xl p-6" data-block={block}>
      <Component {...{ ...(base ? {} : { [pack]: hooks }), agreements, ...extra }} />
    </main>
  );
}
