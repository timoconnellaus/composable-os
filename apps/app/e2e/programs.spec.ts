// Stage 41 end to end, one test per journey: a coach builds, publishes and assigns a program in
// the builder block; a client signs in with an emailed code, logs a session in the today block
// and corrects the set in the history block. The blocks are the pack's own web blocks, mounted
// where they sit (`/blocks`, development only), calling the host's HTTP surface from the browser
// as a client app would. In local dev Programs is the org's own extension (scripts/dev-setup.mjs),
// installed by an admin here as a product that lists the pack would have it.
import { type APIRequestContext, expect, type Page, test } from "@playwright/test";
import { open, unique } from "./helpers.ts";
import {
  addFakeResource,
  connectFake,
  connectionId,
  fakeAddress,
  openIntegrations,
  sentMail,
} from "./integration-helpers.ts";

async function op<T>(request: APIRequestContext, name: string, input: unknown): Promise<T> {
  const response = await request.post(`/api/v1/op/${name}`, {
    data: input,
    headers: { "idempotency-key": crypto.randomUUID() },
  });
  const body = (await response.json()) as { data?: T; error?: unknown };
  expect(response.status(), `${name}: ${JSON.stringify(body).slice(0, 300)}`).toBe(200);
  return body.data as T;
}

const block = (name: string, component: string, props: Record<string, unknown> = {}) =>
  `/blocks?block=${name}&component=${component}&props=${encodeURIComponent(JSON.stringify(props))}`;

/** The pack, a bank of two exercises and a client; returns their ids. */
async function setUp(page: Page) {
  await op(page.request, "extension.install", { id: "programs", shipped: true }).catch(
    () => undefined,
  );
  const row = await op<{ id: string }>(page.request, "record.create", {
    object: "programs.exercise",
    values: { name: unique("Ring row "), measure: "weight_reps" },
  });
  const pike = await op<{ id: string }>(page.request, "record.create", {
    object: "programs.exercise",
    values: { name: unique("Pike press "), measure: "reps" },
  });
  return { row: row.id, pike: pike.id };
}

test("a coach builds a program, publishes it and assigns it", async ({ page }) => {
  test.setTimeout(180_000);
  const bank = await setUp(page);
  const rowName = (
    await op<{ values: { name: string } }>(page.request, "record.get", {
      object: "programs.exercise",
      id: bank.row,
    })
  ).values.name;
  const clientName = unique("Client ");
  const client = await op<{ id: string }>(page.request, "person.create", { givenName: clientName });
  const program = await op<{ id: string }>(page.request, "record.create", {
    object: "programs.program",
    values: { title: unique("Block "), kind: "client", layout: { weeks: [{ sessions: [] }] } },
  });

  await page.goto(block("programs-builder", "ProgramBuilder", { programId: program.id }));
  const builder = page.getByTestId("program-builder");
  await expect(builder).toBeVisible();
  // A session with a block, and an exercise picked from the bank by typing.
  await builder.getByRole("button", { name: "Add session" }).click();
  await builder.getByRole("button", { name: "Add block" }).click();
  await builder.getByLabel("Add an item to block A").fill(rowName);
  await builder.getByRole("button", { name: rowName }).click();
  const item = builder.getByTestId("item").first();
  await expect(item.getByTestId("prescription")).toContainText(rowName);
  await item.getByLabel("Set 1 reps", { exact: true }).fill("10");
  await item.getByLabel("Set 1 load").fill("20");
  // A tempo the schema refuses is shown where it is, and saved once it is right.
  await item.getByLabel("Set 1 tempo").fill("ZZ");
  await expect(item.getByTestId("fault")).toBeVisible();
  await expect(builder.getByTestId("save-status")).toHaveAttribute("data-state", "refused");
  await item.getByLabel("Set 1 tempo").fill("32X1");
  await expect(builder.getByTestId("save-status")).toHaveAttribute("data-state", "saved", {
    timeout: 15_000,
  });
  await expect(item.getByTestId("fault")).toHaveCount(0);
  // A second week, copied from the first.
  await builder.getByRole("button", { name: "Copy this week" }).click();
  await expect(builder.getByRole("tab")).toHaveCount(2);
  await expect(builder.getByTestId("save-status")).toHaveAttribute("data-state", "saved", {
    timeout: 15_000,
  });

  // Published by the coach (an admin here), then assigned to the client from Monday.
  await builder.getByRole("button", { name: "Publish", exact: true }).click();
  await expect(builder.getByTestId("publish-said")).toHaveText("Published as version 1.");
  await builder.getByLabel("A client").fill(clientName.slice(0, 12));
  await builder.getByRole("button", { name: clientName }).click();
  await builder.getByLabel("Starts").fill("2028-01-03");
  await builder.getByRole("button", { name: "Assign the published version" }).click();
  await expect(builder.getByTestId("assign-said")).toContainText("Assigned version 1: 2 sessions");

  const sessions = await op<{ items: { values: Record<string, unknown> }[] }>(
    page.request,
    "record.list",
    {
      object: "programs.session",
      filter: { field: "person", op: "eq", value: client.id },
    },
  );
  expect(sessions.items.map((s) => s.values.date).sort()).toEqual(["2028-01-03", "2028-01-10"]);
  const plan = sessions.items[0]?.values.plan as {
    blocks: { items: { exercises: { sets: Record<string, unknown>[] }[] }[] }[];
  };
  expect(plan.blocks[0]?.items[0]?.exercises[0]?.sets[0]).toMatchObject({
    kind: "reps",
    reps: 10,
    load: 20,
    tempo: "32X1",
  });
});

test("a client signs in, logs a session and corrects it in their history", async ({
  page,
  browser,
  baseURL,
}) => {
  test.setTimeout(240_000);
  const bank = await setUp(page);
  const email = `${unique("member")}@members.test`.toLowerCase();
  const person = await op<{ id: string }>(page.request, "person.create", {
    givenName: unique("Member "),
    emails: [{ email }],
  });
  const program = await op<{ id: string }>(page.request, "record.create", {
    object: "programs.program",
    values: {
      title: unique("Today "),
      kind: "client",
      layout: {
        weeks: [
          {
            sessions: [
              {
                name: "Press",
                day: 1,
                blocks: [
                  {
                    label: "A",
                    items: [
                      {
                        kind: "all",
                        label: "A1",
                        exercises: [
                          {
                            exercise: bank.row,
                            sets: [{ kind: "reps", reps: 8, load: 20, rest: 5 }],
                          },
                        ],
                      },
                    ],
                  },
                ],
              },
            ],
          },
        ],
      },
    },
  });
  await op(page.request, "record.publish", { object: "programs.program", id: program.id });
  await op(page.request, "x.programs.assign", {
    programId: program.id,
    personId: person.id,
    startDate: "2028-02-07",
  });

  // The default policy: an ordinary outbound send waits for a person.
  await op(page.request, "policy.update", { preset: "balanced" });
  // The org's outbox sends customers their codes; members of this gym sign up with them.
  const outbox = fakeAddress("codes");
  await openIntegrations(page);
  const connection = await connectFake(page, outbox, "org");
  await addFakeResource(page, connection, "Outbox", outbox);
  await op(page.request, "customer.settings.update", {
    signup: "open",
    emailConnectionId: await connectionId(connection),
  });
  try {
    // A code that would wait for review is never sent (ADR 0456): the admin lets the host's
    // sign-in mail go out without review on Settings → Users, as staff-invite.spec.ts does.
    await open(page, "/settings/users");
    const signInMail = page.getByTestId("sign-in-mail");
    await expect(signInMail).toContainText("Send sign-in codes");
    if ((await signInMail.getAttribute("data-ready")) !== "true") {
      await signInMail.getByRole("switch").click();
      await page
        .getByRole("alertdialog")
        .getByRole("button", { name: "Send without review" })
        .click();
    }
    await expect(signInMail).toHaveAttribute("data-ready", "true");
    await memberLogsTheirSession(page, browser, baseURL ?? "", email, outbox, person.id);
  } finally {
    // Leave sign-in mail reviewed again, and sign-up by invite, for the other specs.
    await op(page.request, "outbound.setAutoApprove", { tag: "fake.signin", enabled: false }).catch(
      () => undefined,
    );
    await op(page.request, "customer.settings.update", { signup: "invite_only" }).catch(
      () => undefined,
    );
  }
});

async function memberLogsTheirSession(
  page: Page,
  browser: import("@playwright/test").Browser,
  baseURL: string,
  email: string,
  outbox: string,
  personId: string,
): Promise<void> {
  // The member, in a browser of their own, asks for a code and signs in with it.
  const member = await browser.newContext({ baseURL, storageState: { cookies: [], origins: [] } });
  const origin = new URL(baseURL ?? "").origin;
  const asked = await member.request.post("/api/customer-auth/email-otp/send-verification-otp", {
    data: { email, type: "sign-in" },
    headers: { origin },
    timeout: 60_000,
  });
  expect(asked.status(), await asked.text()).toBe(200);
  // The code goes straight out, as the host's sign-in mail.
  let code: string | undefined;
  await expect
    .poll(
      async () => {
        const mail = (await sentMail(page.request, outbox)).filter((m) => m.to.includes(email));
        code = /\b(\d{6})\b/.exec(mail.at(-1)?.text ?? "")?.[1];
        return code;
      },
      { timeout: 30_000 },
    )
    .toMatch(/^\d{6}$/);
  const signedIn = await member.request.post("/api/customer-auth/sign-in/email-otp", {
    data: { email, otp: code },
    headers: { origin },
    timeout: 60_000,
  });
  expect(signedIn.status(), await signedIn.text()).toBe(200);

  // Their day, in the today block: the session, a set logged with one tap on its tick (the reps
  // typed, the load suggested from the target, effort tapped), the rest timer, finished.
  const memberPage = await member.newPage();
  await memberPage.goto(block("programs-today", "Today", { date: "2028-02-07" }));
  await memberPage.getByRole("button", { name: "Press" }).click();
  const view = memberPage.getByTestId("session-view");
  await expect(view).toBeVisible();
  await expect(view.getByTestId("progress")).toContainText("0 of 1 sets");
  const set = view.getByTestId("set-row").first();
  await expect(set.getByLabel("Set 1 load")).toHaveAttribute("placeholder", "20");
  await set.getByRole("button", { name: "Set 1 effort" }).click();
  await set.getByRole("button", { name: "8.5", exact: true }).click();
  // Typed and ticked straight away, with the field still focused.
  await set.getByLabel("Set 1 reps done").fill("7");
  await set.getByRole("button", { name: "Set 1 done" }).click();
  await expect(view.getByRole("timer")).toBeVisible();
  await expect(view.getByTestId("progress")).toContainText("1 of 1 sets");
  // The exercise folds away once its last set is ticked; opened again, the set is done.
  await view.getByTestId("exercise-folded").click();
  await expect(view.getByTestId("set-row").first()).toHaveAttribute("data-done", "true");
  await view.getByRole("button", { name: "Finish session" }).click();
  await expect(view.getByRole("button", { name: "Done" })).toBeVisible();

  // Looking back, in the history block: the session with its sets done, opened set by set, and
  // the logged set corrected (the host's logUpdate: what was done, never the target).
  await memberPage.goto(block("programs-history", "SessionHistory", { until: "2028-02-07" }));
  const history = memberPage.getByTestId("session-history");
  const past = history.getByTestId("past-session").first();
  await expect(past.getByTestId("sets-done")).toHaveText("1 of 1 sets");
  await past.getByRole("button", { name: /Press/ }).click();
  const pastSet = past.getByTestId("past-set").first();
  await expect(pastSet.getByTestId("past-set-done")).toHaveText("7 reps @ 20 kg · RPE 8.5");
  await pastSet.getByRole("button", { name: "Correct" }).click();
  await pastSet.getByLabel("Set 1 reps done").fill("6");
  await pastSet.getByRole("button", { name: "Save" }).click();
  await expect(pastSet.getByTestId("past-set-done")).toHaveText("6 reps @ 20 kg · RPE 8.5");
  await member.close();

  const logged = await op<{ items: { values: Record<string, unknown> }[] }>(
    page.request,
    "record.list",
    {
      object: "programs.log",
      filter: { field: "person", op: "eq", value: personId },
    },
  );
  expect(logged.items.map((l) => l.values)).toEqual([
    expect.objectContaining({
      actualReps: 6,
      actualLoad: 20,
      rpe: 8.5,
      targetReps: 8,
      recordedAs: "self",
    }),
  ]);
}
