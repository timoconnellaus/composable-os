// The fake host a block's preview runs against: a client with the shape of a generated one
// (`operations`, `query`, `mutation`, as packages/client's PackClient), whose every answer comes
// from the preview file. A block is mounted exactly as a client app mounts it, with its pack's
// real hooks factory (`createBookingsHooks(react, client)`), so what the picture shows is the
// block's own rendering of an answer the operation could give: the answers are typed by each
// operation's output (the pack's `*Operations` type), so a contract change that dummy data no
// longer fits fails `pnpm typecheck`.
//
// A query a block calls that its preview does not answer fails the preview (it is shown as an
// error and the picture script stops on it): a picture never shows a loading state by accident.
// A mutation answers what the preview gives it, or nothing; the pictures are taken before any
// click.
import type { HookCalls } from "@composable-os/client";
import { hooksOperations } from "@composable-os/client";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";

/** What a pack's `*Operations` type looks like: each operation's kind, input and output. */
type Ops = Record<string, { kind: "query" | "mutation"; input: unknown; output: unknown }>;

/** An operation's answer: its output, or a function from its input to its output. */
type Answer<O extends Ops[string]> = O["output"] | ((input: O["input"]) => O["output"]);

/** The preview's answers, by operation name. Only the operations the block calls are needed. */
export type Answers<T extends Ops> = { [K in keyof T]?: Answer<T[K]> };

/** The day every preview is drawn on: the picture script fixes the browser's clock to it. */
export const TODAY = "2026-03-02";
/** The clock's time on that day (a Monday), in the browser's zone (TIME_ZONE). */
export const NOW = "2026-03-02T09:30:00";
/** The zone the pictures are taken in. */
export const TIME_ZONE = "Europe/London";

/** An instant on the preview's day (or another), as the host sends one: ISO, in UTC. */
export function at(time: string, date: string = TODAY): string {
  return new Date(`${date}T${time}:00Z`).toISOString();
}

/** A date `days` after the preview's day, as YYYY-MM-DD. */
export function dayAfter(days: number, date: string = TODAY): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** Thrown for a query the preview does not answer. */
export class Unanswered extends Error {
  override name = "Unanswered";
}

/** Problems a preview ran into, read by the picture script (`window.__screenProblems`). */
export function report(problem: string): void {
  const w = globalThis as unknown as { __screenProblems?: string[] };
  w.__screenProblems ??= [];
  if (!w.__screenProblems.includes(problem)) w.__screenProblems.push(problem);
  console.error(problem);
}

function answer(answers: Record<string, unknown>, name: string, input: unknown): unknown {
  if (!(name in answers)) return undefined;
  const a = answers[name];
  return typeof a === "function" ? (a as (input: unknown) => unknown)(input) : a;
}

/**
 * A client holding every operation `calls` names (a pack's `*_HOOKS_CALL`), answering from
 * `answers`. Typed as the generated client of all of `T`, so the pack's hooks factory gives every
 * hook.
 */
export function fakeClient<T extends Ops>(
  calls: Readonly<Record<string, HookCalls>>,
  answers: Answers<T>,
): { operations: { [K in keyof T]: { kind: T[K]["kind"] } }; baseUrl: string } & {
  query: (
    name: string,
    input: unknown,
  ) => { queryKey: readonly unknown[]; queryFn: () => Promise<never> };
  mutation: (name: string) => {
    mutationKey: readonly unknown[];
    mutationFn: (input: unknown) => Promise<never>;
  };
} {
  const held = answers as Record<string, unknown>;
  const operations = Object.fromEntries(
    hooksOperations(calls).map((name) => [name, { kind: "query" }]),
  ) as { [K in keyof T]: { kind: T[K]["kind"] } };
  return {
    operations,
    baseUrl: "https://host.example.com",
    query: (name, input) => ({
      queryKey: ["preview", name, input],
      queryFn: async () => {
        if (!(name in held)) {
          const problem = `The preview does not answer ${name} (called with ${JSON.stringify(input)})`;
          report(problem);
          throw new Unanswered(problem);
        }
        return answer(held, name, input) as never;
      },
    }),
    mutation: (name) => ({
      mutationKey: ["preview", name],
      mutationFn: async (input) => (answer(held, name, input) ?? {}) as never,
    }),
  };
}

/** The app's React Query, as a pack's hooks factory takes it. */
export const react = { useQuery, useMutation, useState, useEffect };
