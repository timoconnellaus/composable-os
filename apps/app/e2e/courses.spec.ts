// Stage 42 end to end, one test per journey: staff build and publish a course with a (fake) video
// in the course builder block; a student signs in, buys the course on the web with the payments
// gatekeeper's fake provider, watches a lesson in the player block, and their progress is kept,
// while someone who did not buy cannot play it; and (stage 32a) a student starts a course
// subscription with a free trial, holds every course through it, and cancels it at its period's
// end, which staff see among the subscriptions ending. The blocks are the pack's own web blocks, mounted
// where they sit (`/blocks`, development only), calling the host's HTTP surface from the browser
// as a client app would. In local dev Courses and Programs are the org's own extensions
// (scripts/dev-setup.mjs), and videos go to the fake Stream (STREAM_FAKE).
import {
  type APIRequestContext,
  type Browser,
  type BrowserContext,
  expect,
  type Page,
  request as playwrightRequest,
  test,
} from "@playwright/test";
import { open, unique } from "./helpers.ts";
import {
  addFakeResource,
  connectFake,
  connectionId,
  fakeAddress,
  openIntegrations,
  sentMail,
} from "./integration-helpers.ts";

async function op<T>(
  request: APIRequestContext,
  name: string,
  input: unknown,
  ok = true,
): Promise<T> {
  const response = await request.post(`/api/v1/op/${name}`, {
    data: input,
    headers: { "idempotency-key": crypto.randomUUID() },
  });
  const body = (await response.json()) as { data?: T; error?: { code?: string } };
  if (ok) expect(response.status(), `${name}: ${JSON.stringify(body).slice(0, 300)}`).toBe(200);
  return (ok ? body.data : body.error) as T;
}

const block = (name: string, component: string, props: Record<string, unknown> = {}) =>
  `/blocks?block=${name}&component=${component}&props=${encodeURIComponent(JSON.stringify(props))}`;

/** The same path on this test's own origin (the fake Stream answers on the host's). */
const here = (url: string, baseURL: string) => {
  const u = new URL(url);
  return `${new URL(baseURL).origin}${u.pathname}${u.search}`;
};

/** Both packs on, the payments fake bound, and a ready video in the library. */
async function setUp(page: Page, baseURL: string): Promise<{ video: string }> {
  for (const id of ["programs", "content", "courses"]) {
    await op(page.request, "extension.install", { id, shipped: true }, false);
  }
  const origin = new URL(baseURL).origin;
  await op(page.request, "order.settings.update", { currency: "AUD", returnOrigins: [origin] });
  await op(page.request, "integration.setVendor", { vendor: "payments", enabled: true });
  const connections = await op<{ items: { id: string; vendor: string; status: string }[] }>(
    page.request,
    "connection.list",
    {},
  );
  let payments = connections.items.find(
    (c) => c.vendor === "payments" && c.status === "active",
  )?.id;
  if (!payments) {
    payments = (
      await op<{ connection: { id: string } }>(page.request, "connection.create", {
        vendor: "payments",
        scope: "org",
      })
    ).connection.id;
  }
  await op(page.request, "connection.bindResource", {
    id: payments,
    url: "payments://merchant/fake",
  });
  // A video, sent to the (fake) Stream as the admin's picker sends it.
  const asked = await op<{ item: { id: string }; upload: { url: string } }>(
    page.request,
    "media.videoUpload",
    {
      name: unique("wrists-") + ".mp4",
      bytes: 2048,
    },
  );
  const sent = await page.request.post(here(asked.upload.url, baseURL), {
    multipart: { file: { name: "wrists.mp4", mimeType: "video/mp4", buffer: Buffer.alloc(2048) } },
  });
  expect(sent.status()).toBe(200);
  const ready = await op<{ state: string }>(page.request, "media.videoRefresh", {
    id: asked.item.id,
  });
  expect(ready.state).toBe("ready");
  return { video: asked.item.id };
}

test("staff build and publish a course with a video", async ({ page, baseURL }) => {
  test.setTimeout(180_000);
  const { video } = await setUp(page, baseURL ?? "");
  const title = unique("Handstands ");
  const course = await op<{ id: string }>(page.request, "record.create", {
    object: "courses.course",
    values: { title, price: 99 },
  });
  await page.goto(block("courses-builder", "CourseBuilder", { courseId: course.id }));
  const builder = page.getByRole("region", { name: "Course builder" });
  await builder.getByLabel("New section").fill("Start here");
  await builder.getByRole("button", { name: "Add section" }).click();
  await builder.getByRole("button", { name: "Add video" }).click();
  await builder.getByLabel("Lesson title").fill("Wrist prep");
  await builder.getByRole("combobox").first().selectOption(video);
  await builder.getByRole("button", { name: "Publish" }).click();
  await expect(builder.getByRole("status")).toHaveText("Published");

  // The public reads it in the catalogue; its lesson's video is a holder's only.
  const anonymous = await playwrightRequest.newContext({
    baseURL,
    storageState: { cookies: [], origins: [] },
  });
  const catalogue = await op<{ courses: { id: string; title: string; lessons: number }[] }>(
    anonymous,
    "x.courses.catalogue",
    {},
  );
  expect(catalogue.courses.find((c) => c.id === course.id)).toMatchObject({ title, lessons: 1 });
  expect(await op<{ code: string }>(anonymous, "media.play", { id: video }, false)).toMatchObject({
    code: "not_found",
  });
  await anonymous.dispose();
});

test("a student buys a course on the web, watches a lesson and keeps their progress; a non-buyer cannot play it", async ({
  page,
  browser,
  baseURL,
}) => {
  test.setTimeout(300_000);
  const origin = new URL(baseURL ?? "").origin;
  const { video } = await setUp(page, baseURL ?? "");
  const title = unique("Mobility ");
  const course = await op<{ id: string; values: { slug: string } }>(page.request, "record.create", {
    object: "courses.course",
    values: {
      title,
      price: 49,
      outline: {
        sections: [
          {
            key: "start",
            title: "Start",
            lessons: [{ kind: "video", key: "hips", title: "Hips", video: { media: video } }],
          },
        ],
      },
    },
  });
  await op(page.request, "record.publish", { object: "courses.course", id: course.id });
  const slug = (
    await op<{ values: { slug: string } }>(page.request, "record.get", {
      object: "courses.course",
      id: course.id,
    })
  ).values.slug;

  try {
    const student = await signInStudent(page, browser, baseURL ?? "");

    // The course page: buy, pay on the provider's (fake) page, come back.
    const studentPage = await student.newPage();
    await studentPage.goto(
      block("courses-course", "CoursePage", {
        slug,
        returnUrl: `${origin}/blocks`,
        signedIn: true,
      }),
    );
    await studentPage.getByRole("button", { name: /^Buy/ }).click();
    await expect(studentPage.getByRole("heading", { name: /Fake payment page/i })).toBeVisible({
      timeout: 30_000,
    });
    await studentPage.getByRole("button", { name: "Pay", exact: true }).click();
    await expect
      .poll(
        async () =>
          (
            await op<{ courses: { id: string }[] }>(student.request, "x.courses.myCourses", {})
          ).courses.map((c) => c.id),
        {
          timeout: 30_000,
        },
      )
      .toContain(course.id);

    // The player: the video plays with a token the host signed; marking it done is kept.
    await studentPage.goto(
      block("courses-player", "LessonPlayer", { courseId: course.id, lessonKey: "hips" }),
    );
    const player = studentPage.locator("video");
    await expect(player).toHaveAttribute("src", /fake-stream\/.+\/manifest\/video\.m3u8$/);
    const src = (await player.getAttribute("src")) ?? "";
    expect((await student.request.get(here(src, baseURL ?? ""))).status()).toBe(200);
    await studentPage.getByRole("button", { name: "Mark as done" }).click();
    await expect(studentPage.getByRole("button", { name: "Done", exact: true })).toBeVisible();
    const kept = await op<{ items: { values: { lessonKey: string; state: string } }[] }>(
      page.request,
      "record.list",
      {
        object: "courses.progress",
        filter: { field: "course", op: "eq", value: course.id },
      },
    );
    expect(kept.items.map((r) => r.values)).toEqual([
      expect.objectContaining({ lessonKey: "hips", state: "done" }),
    ]);
    // Back on the lesson later, it is still done.
    await studentPage.reload();
    await expect(studentPage.getByRole("button", { name: "Done", exact: true })).toBeVisible();
    await student.close();

    // Someone who did not buy: no token, and the video's id alone does not play.
    const stranger = await playwrightRequest.newContext({
      baseURL,
      storageState: { cookies: [], origins: [] },
    });
    expect(await op<{ code: string }>(stranger, "media.play", { id: video }, false)).toMatchObject({
      code: "not_found",
    });
    await stranger.dispose();
  } finally {
    await resetSignUp(page);
  }
});

test("a student starts a course subscription with a free trial, holds every course, and cancels it at its period's end", async ({
  page,
  browser,
  baseURL,
}) => {
  test.setTimeout(300_000);
  const origin = new URL(baseURL ?? "").origin;
  await setUp(page, baseURL ?? "");
  const title = unique("Every course ");
  const course = await op<{ id: string }>(page.request, "record.create", {
    object: "courses.course",
    values: {
      title: unique("Flexibility "),
      price: 39,
      outline: {
        sections: [
          {
            key: "s",
            title: "S",
            lessons: [
              {
                kind: "text",
                key: "t",
                title: "T",
                body: { blocks: [{ type: "paragraph", content: [{ type: "text", text: "x" }] }] },
              },
            ],
          },
        ],
      },
    },
  });
  await op(page.request, "record.publish", { object: "courses.course", id: course.id });
  await op<{ id: string }>(page.request, "record.create", {
    object: "courses.plan",
    values: { title, price: 29, trialDays: 7 },
  });
  try {
    const student = await signInStudent(page, browser, baseURL ?? "");
    const studentPage = await student.newPage();

    // Subscribe: the trial is the host's to give; the provider's (fake) page takes the card.
    await studentPage.goto(
      block("courses-subscribe", "Subscribe", { returnUrl: `${origin}/blocks`, signedIn: true }),
    );
    const card = studentPage.getByRole("region", { name: "Subscribe" });
    await expect(card.getByText(title)).toBeVisible();
    await card.getByRole("button", { name: "Start your 7-day free trial" }).first().click();
    await expect(studentPage.getByRole("heading", { name: /Fake payment page/i })).toBeVisible({
      timeout: 30_000,
    });
    await expect(studentPage.getByText(/Nothing is charged until/)).toBeVisible();
    await studentPage.getByRole("button", { name: "Pay", exact: true }).click();

    // Once the provider confirms, every published course is theirs, through the subscription.
    await expect
      .poll(
        async () =>
          (
            await op<{ courses: { id: string; why: string }[] }>(
              student.request,
              "x.courses.myCourses",
              {},
            )
          ).courses.find((c) => c.id === course.id)?.why,
        { timeout: 30_000 },
      )
      .toBe("subscription");

    // Their subscription on the web: on trial; cancelling keeps it to the period's end.
    await studentPage.goto(
      block("courses-subscription", "MySubscription", { returnUrl: `${origin}/blocks` }),
    );
    const mine = studentPage.getByRole("region", { name: "My subscription" });
    await expect(mine.getByTestId("subscription-status").first()).toContainText("Free until");
    studentPage.once("dialog", (dialog) => void dialog.accept());
    await mine.getByRole("button", { name: "Cancel subscription" }).first().click();
    await expect(mine.getByRole("status")).toContainText("Asked to cancel");
    await expect
      .poll(
        async () => {
          await studentPage.reload();
          return mine.getByTestId("subscription-status").first().textContent();
        },
        { timeout: 30_000 },
      )
      .toContain("ending on");
    await expect(mine.getByRole("button", { name: "Keep my subscription" })).toBeVisible();
    // Still every course until then.
    expect(
      (
        await op<{ courses: { id: string }[] }>(student.request, "x.courses.myCourses", {})
      ).courses.map((c) => c.id),
    ).toContain(course.id);
    await student.close();

    // Staff see it among the subscriptions that are ending.
    await open(page, "/subscriptions?view=ending");
    await expect(page.getByRole("link", { name: title })).toBeVisible();
  } finally {
    await resetSignUp(page);
  }
});

test("an imported subscriber signs in, takes their continuation offer, holds every course, and is charged nothing until their paid-up date", async ({
  page,
  browser,
  baseURL,
}) => {
  test.setTimeout(300_000);
  const origin = new URL(baseURL ?? "").origin;
  await setUp(page, baseURL ?? "");
  const course = await op<{ id: string }>(page.request, "record.create", {
    object: "courses.course",
    values: {
      title: unique("Mobility "),
      price: 39,
      outline: {
        sections: [
          {
            key: "s",
            title: "S",
            lessons: [
              {
                kind: "text",
                key: "t",
                title: "T",
                body: { blocks: [{ type: "paragraph", content: [{ type: "text", text: "x" }] }] },
              },
            ],
          },
        ],
      },
    },
  });
  await op(page.request, "record.publish", { object: "courses.course", id: course.id });
  const plan = await op<{ id: string }>(page.request, "record.create", {
    object: "courses.plan",
    values: { title: unique("Continuing "), price: 29, trialDays: 7 },
  });
  // The person comes first (the people import), then their offer: paid up elsewhere until a date
  // three weeks away. The import invites the address, so they can sign in with sign-up invite only.
  const email = `${unique("moving")}@students.test`.toLowerCase();
  await op(page.request, "person.create", { givenName: "Moving", emails: [{ email }] });
  const paidUpTo = new Date(Date.now() + 21 * 86_400_000).toISOString().slice(0, 10);
  const imported = await op<{
    results: {
      outcome: string;
      offerId: string;
      signIn: string;
      personId: string;
      freeUntil: string;
    }[];
  }>(page.request, "subscription.offer.import", {
    plan: { object: "courses.plan", id: plan.id },
    rows: [{ email, freeUntil: paidUpTo, reference: "old-sub-1" }],
    invite: true,
  });
  expect(imported.results[0]).toMatchObject({ outcome: "created", signIn: "invited" });
  try {
    const student = await signInStudent(page, browser, baseURL ?? "", {
      email,
      signup: "invite_only",
    });
    const studentPage = await student.newPage();

    // The subscribe block shows their offer in place of the trial.
    await studentPage.goto(
      block("courses-subscribe", "Subscribe", { returnUrl: `${origin}/blocks`, signedIn: true }),
    );
    const card = studentPage.getByRole("region", { name: "Subscribe" });
    await expect(card.getByTestId("continuation-offer")).toContainText("Continue it here");
    await expect(card.getByRole("button", { name: /free trial/ })).toHaveCount(0);
    await card
      .getByRole("button", { name: /^Continue, free until/ })
      .first()
      .click();
    await expect(studentPage.getByRole("heading", { name: /Fake payment page/i })).toBeVisible({
      timeout: 30_000,
    });
    const freeUntil = imported.results[0]?.freeUntil as string;
    await expect(
      studentPage.getByText(`Nothing is charged until ${freeUntil.slice(0, 10)}`),
    ).toBeVisible();
    await studentPage.getByRole("button", { name: "Pay", exact: true }).click();

    // Once the provider confirms, every published course is theirs, through the subscription.
    await expect
      .poll(
        async () =>
          (
            await op<{ courses: { id: string; why: string }[] }>(
              student.request,
              "x.courses.myCourses",
              {},
            )
          ).courses.find((c) => c.id === course.id)?.why,
        { timeout: 30_000 },
      )
      .toBe("subscription");
    // Free until the paid-up date, then charged; no trial on top.
    const mine = await op<{ items: { id: string; state: string; trialEnd: string }[] }>(
      student.request,
      "subscription.list",
      {},
    );
    expect(mine.items).toHaveLength(1);
    expect(mine.items[0]?.state).toBe("trialing");
    expect(mine.items[0]?.trialEnd).toBe(freeUntil);
    // Nothing was charged: no paid order for them.
    const person = imported.results[0];
    const orders = await op<{ items: { paid: number }[] }>(page.request, "order.list", {
      filter: { field: "personId", op: "eq", value: person?.personId },
    });
    expect(orders.items.filter((o) => o.paid > 0)).toEqual([]);
    // The offer is used: it is not shown again.
    await studentPage.goto(
      block("courses-subscribe", "Subscribe", { returnUrl: `${origin}/blocks`, signedIn: true }),
    );
    await expect(
      studentPage.getByRole("region", { name: "Subscribe" }).getByTestId("continuation-offer"),
    ).toHaveCount(0);
    await student.close();

    // Staff see it taken in the report, charged from the paid-up date.
    await open(page, "/subscriptions?view=offers");
    const row = page.getByTestId("offer-row").filter({ hasText: email });
    await expect(row).toHaveAttribute("data-status", "taken");
    await expect(row).toContainText("old-sub-1");
  } finally {
    await resetSignUp(page);
  }
});

/**
 * Sign-up open (or as given), the org's outbox sending the sign-in mail, and a student signed in
 * with an emailed code (to a new address, or the one given), in a context of their own.
 */
async function signInStudent(
  page: Page,
  browser: Browser,
  baseURL: string,
  as: { email?: string; signup?: "open" | "invite_only" | "buyers" } = {},
): Promise<BrowserContext> {
  const origin = new URL(baseURL).origin;
  const outbox = fakeAddress("students");
  await openIntegrations(page);
  const connection = await connectFake(page, outbox, "org");
  await addFakeResource(page, connection, "Outbox", outbox);
  await op(page.request, "customer.settings.update", {
    signup: as.signup ?? "open",
    emailConnectionId: await connectionId(connection),
  });
  await open(page, "/settings/users");
  const signInMail = page.getByTestId("sign-in-mail");
  if ((await signInMail.getAttribute("data-ready")) !== "true") {
    await signInMail.getByRole("switch").click();
    await page
      .getByRole("alertdialog")
      .getByRole("button", { name: "Send without review" })
      .click();
  }
  await expect(signInMail).toHaveAttribute("data-ready", "true");
  const email = as.email ?? `${unique("student")}@students.test`.toLowerCase();
  const student = await browser.newContext({ baseURL, storageState: { cookies: [], origins: [] } });
  const asked = await student.request.post("/api/customer-auth/email-otp/send-verification-otp", {
    data: { email, type: "sign-in" },
    headers: { origin },
  });
  expect(asked.status(), await asked.text()).toBe(200);
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
  const signedIn = await student.request.post("/api/customer-auth/sign-in/email-otp", {
    data: { email, otp: code },
    headers: { origin },
  });
  expect(signedIn.status(), await signedIn.text()).toBe(200);
  return student;
}

async function resetSignUp(page: Page): Promise<void> {
  await op(page.request, "outbound.setAutoApprove", { tag: "fake.signin", enabled: false }, false);
  await op(page.request, "customer.settings.update", { signup: "invite_only" }, false);
}
