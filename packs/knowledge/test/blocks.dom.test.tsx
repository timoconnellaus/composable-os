// Stage 38 step 6 (ADR 0708): the confirm button, pressed as a person presses it, in a DOM
// (happy-dom under Node; test/vitest.dom.config.ts). It confirms the version on screen, not the one
// the person's list names, and a refusal from the host is shown and never taken as done. The
// refusal is in the shape the admin's staff client throws for the confirm tool's wrapped
// `ack.confirm` refusal (apps/app/src/lib/staff-client.ts keeps the tool's inner details).
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ProcedureScreen as NativeReader } from "../blocks/knowledge-native-procedures/procedures-screen.tsx";
import { ProcedureReader } from "../blocks/knowledge-procedures/procedures.tsx";
import type { KnowledgeHooks, Published, ToReadAnswer } from "../client/index.ts";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const TITLE = "When someone is hurt";

/** The reader shows version 4: what `content.staffGet` answered when it was opened. */
const procedure: Published & { pictures: boolean } = {
  object: "knowledge.procedure",
  id: "rec_injury",
  values: {
    title: TITLE,
    body: { blocks: [{ type: "paragraph", content: [{ type: "text", text: "Stay calm." }] }] },
  },
  names: { section: "Safety" },
  version: 4,
  publishedAt: "2026-03-03T09:00:00.000Z",
  pictures: true,
};

/** The person's list, read earlier, still names version 3. */
const mine: ToReadAnswer = {
  toRead: [
    {
      id: "rec_injury",
      title: TITLE,
      version: 3,
      publishedAt: "2026-02-03T09:00:00.000Z",
      since: "2026-02-03T09:00:00.000Z",
    },
  ],
  confirmed: [],
};

/** The staff client's error for the tool's `not_current` refusal (its inner details kept). */
function notCurrent(current: number) {
  return Object.assign(
    new Error(`Version 4 is not the current one: read version ${current} and confirm that`),
    { code: "extension_error", details: { reason: "not_current", current } },
  );
}

function hooks(mutateAsync: (input: { id: string; version: number }) => Promise<unknown>) {
  const answered = (data: unknown) => ({
    data,
    error: null,
    isPending: false,
    refetch: async () => undefined,
  });
  return {
    useProcedure: () => answered(procedure),
    useToRead: () => answered(mine),
    useConfirm: () => ({
      mutate() {},
      mutateAsync,
      data: undefined,
      isPending: false,
      error: null,
    }),
  } as unknown as KnowledgeHooks;
}

let root: Root | null = null;
afterEach(() => {
  act(() => root?.unmount());
  root = null;
  document.body.innerHTML = "";
});

async function mount(node: ReactNode): Promise<HTMLElement> {
  const container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => root?.render(node));
  return container;
}

async function press(element: Element | null | undefined) {
  expect(element, "the button").toBeTruthy();
  await act(async () => {
    element?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

const LABEL = `I have read and understood "${TITLE}" (version 4)`;

describe("the web reader's confirm button", () => {
  const button = (c: HTMLElement) =>
    [...c.querySelectorAll("button")].find((b) => b.textContent === LABEL);

  it("confirms the version on screen, not the one the list names, and then says so", async () => {
    const sent = vi.fn(async (input: { id: string; version: number }) => ({
      id: input.id,
      version: input.version,
      confirmedAt: "2026-03-04T08:00:00.000Z",
    }));
    const c = await mount(<ProcedureReader knowledge={hooks(sent)} id="rec_injury" />);
    await press(button(c));
    expect(sent).toHaveBeenCalledTimes(1);
    expect(sent).toHaveBeenCalledWith({ id: "rec_injury", version: 4 });
    expect(c.querySelector('[role="status"]')?.textContent).toContain(
      "Confirmed: you have read and understood version 4",
    );
  });

  it("shows the host's refusal and never shows it as done", async () => {
    const refused = vi.fn(async () => {
      throw notCurrent(5);
    });
    const c = await mount(<ProcedureReader knowledge={hooks(refused)} id="rec_injury" />);
    await press(button(c));
    expect(refused).toHaveBeenCalledWith({ id: "rec_injury", version: 4 });
    const alert = c.querySelector('[role="alert"]');
    expect(alert?.getAttribute("data-refusal")).toBe("not_current");
    expect(alert?.textContent).toContain("A newer version has been published");
    expect(c.querySelector('[role="status"]')).toBeNull();
    expect(c.textContent).not.toContain("Confirmed");
  });
});

describe("the native reader's confirm button", () => {
  const nativeProps = { openUrl: () => {}, mediaUrl: () => "", width: 750 };
  const button = (c: HTMLElement) =>
    [...c.querySelectorAll("rn-pressable")].find((b) => b.textContent === LABEL);

  it("confirms the version on screen", async () => {
    const sent = vi.fn(async (input: { id: string; version: number }) => ({
      id: input.id,
      version: input.version,
      confirmedAt: "2026-03-04T08:00:00.000Z",
    }));
    const c = await mount(
      <NativeReader knowledge={hooks(sent)} id="rec_injury" {...nativeProps} />,
    );
    await press(button(c));
    expect(sent).toHaveBeenCalledWith({ id: "rec_injury", version: 4 });
    expect(c.querySelector('[data-testid="confirmed"]')?.textContent).toContain(
      "Confirmed: you have read and understood version 4",
    );
  });

  it("shows the host's refusal and never shows it as done", async () => {
    const refused = vi.fn(async () => {
      throw notCurrent(5);
    });
    const c = await mount(
      <NativeReader knowledge={hooks(refused)} id="rec_injury" {...nativeProps} />,
    );
    await press(button(c));
    expect(c.querySelector('[data-role="alert"]')?.textContent).toContain(
      "A newer version has been published",
    );
    expect(c.querySelector('[data-testid="confirmed"]')).toBeNull();
  });
});
