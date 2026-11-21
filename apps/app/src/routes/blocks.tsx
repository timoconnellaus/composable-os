// Development only: one pack's web block mounted on its own, for the e2e specs and for a person
// trying a block before copying it (stage 41). `/blocks?block=programs-builder&component=
// ProgramBuilder&props={"programId":"rec_…"}` renders that export of the block with the pack's
// hooks (as the prop named for the pack: `programs`, `ticketing`) over a client that calls the
// host's HTTP surface from the browser, as a client app's would: signed in as staff, it is staff;
// with a customer's cookie, that customer; with neither, the public.
//
// The blocks are read where they sit (`packs/<id>/blocks/<block>/`), their base-layer imports
// joined to `blocks/` by pack-blocks-plugin.ts. A production build mounts nothing.
import {
  createProgramsHooks,
  PROGRAMS_HOOKS_CALL,
  type ProgramsClient,
} from "@composable-os/pack-programs/client";
import {
  createTicketingHooks,
  TICKETING_HOOKS_CALL,
  type TicketingClient,
} from "@composable-os/pack-ticketing/client";

/** A pack's client holding every operation (the `operations` is what the hooks read). */
type FullClient<C> = C & { operations: Record<string, unknown> };

import { useMutation, useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { type ComponentType, useEffect, useState } from "react";

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
    ])
  : {};

/** An error as the HTTP surface sends it, with the host's details. */
class SurfaceError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
  }
}

async function call(name: string, input: unknown, write: boolean): Promise<unknown> {
  const response = await fetch(`/api/v1/op/${name}`, {
    method: "POST",
    credentials: "same-origin",
    headers: {
      "content-type": "application/json",
      ...(write ? { "idempotency-key": crypto.randomUUID() } : {}),
    },
    body: JSON.stringify(input ?? {}),
  });
  const body = (await response.json()) as {
    data?: unknown;
    error?: { code?: string; message?: string; details?: unknown };
  };
  if (!response.ok || body.error) {
    // A tool's refusal carries the host's own words inside it.
    const inner = (body.error?.details as { details?: unknown } | undefined)?.details;
    throw new SurfaceError(
      body.error?.code ?? "internal",
      body.error?.message ?? "Refused",
      inner ?? body.error?.details,
    );
  }
  return body.data;
}

/**
 * A typed client's shape, over the browser's own calls, holding every operation a pack's hooks
 * call (`calls`, the pack's `*_HOOKS_CALL`): this page shows every block (ADR 0453).
 */
function browserClient<C>(calls: Record<string, readonly string[]>): C {
  const operations = Object.fromEntries(
    Object.values(calls)
      .flat()
      .map((name) => [name, { kind: "query", invalidates: [] }]),
  );
  return {
    operations,
    query: (name: string, input: unknown) => ({
      queryKey: [name, input],
      queryFn: () => call(name, input, false),
    }),
    mutation: (name: string) => ({
      mutationKey: [name],
      mutationFn: (input: unknown) => call(name, input, true),
    }),
  } as C;
}

// biome-ignore lint/suspicious/noExplicitAny: the hooks are typed by each pack; this passes them through.
type AnyHooks = any;

function usePackHooks(pack: string): AnyHooks {
  // The app's own React Query: a query is refetched when the block asks, as a client app's is.
  const react = { useQuery, useMutation, useState, useEffect } as never;
  if (pack === "programs") {
    return createProgramsHooks(
      react,
      browserClient<FullClient<ProgramsClient>>(PROGRAMS_HOOKS_CALL),
    );
  }
  if (pack === "ticketing") {
    return createTicketingHooks(
      react,
      browserClient<FullClient<TicketingClient>>(TICKETING_HOOKS_CALL),
    );
  }
  return null;
}

function BlocksPage() {
  const { block, component, props } = Route.useSearch();
  const [Component, setComponent] = useState<ComponentType<Record<string, unknown>> | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const pack = block?.split("-")[0] ?? "";
  const hooks = usePackHooks(pack);
  useEffect(() => {
    if (!block || !component) return;
    const key = Object.keys(files).find((path) => path.includes(`/packs/${pack}/blocks/${block}/`));
    if (!key) {
      setFailed(`No web block ${block}`);
      return;
    }
    files[key]?.()
      .then((module) => {
        const found = module[component];
        if (typeof found !== "function") setFailed(`${block} has no export ${component}`);
        else setComponent(() => found as ComponentType<Record<string, unknown>>);
      })
      .catch((error: unknown) => setFailed(String(error)));
  }, [block, component, pack]);
  if (!import.meta.env.DEV) return <p>Blocks are mounted here in development only.</p>;
  if (!block || !component) return <p>Name a block and its export: /blocks?block=…&component=…</p>;
  if (failed) return <p role="alert">{failed}</p>;
  if (!Component || !hooks) return <p aria-busy="true">Loading {block}…</p>;
  const extra = props ? (JSON.parse(props) as Record<string, unknown>) : {};
  return (
    <main className="mx-auto max-w-5xl p-6" data-block={block}>
      <Component {...{ [pack]: hooks, ...extra }} />
    </main>
  );
}
