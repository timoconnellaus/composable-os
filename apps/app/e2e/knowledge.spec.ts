// Stage 38 step 6 (ADR 0708): the Knowledge pack's journeys, one test each.
//
// - A visitor, signed out, searches the help centre on a business's site and reads the page it
//   finds, opened at the section the match was under; a procedure with the same word is never
//   found.
// - A member of staff opens To read in the admin, reads a procedure as published and confirms it,
//   and it leaves their list; the owner opens Read status and sees who has confirmed and who has
//   not.
// - A coach (a fixed role) follows the notice's link to the record from their small shell, which
//   opens the reader; reads, confirms, and has nothing left to read; Read status is not theirs.
//
// The help centre's blocks are mounted where they sit (`/blocks`, development only), as a client
// app's site mounts them; staff use the admin's declared screens. Counts other specs could change
// (who must read: every member) are read from the host just before they are compared. Every name
// here is invented.
import { type APIRequestContext, expect, type Page, test } from "@playwright/test";
import { open, openScreen, staffAccount, unique, waitForScreen, watchRefusals } from "./helpers.ts";

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

const text = (t: string) => ({ type: "text", text: t });

/** Knowledge on (the global setup installs it; installing again changes nothing). */
async function setUp(page: Page) {
  await op(page.request, "extension.install", { id: "knowledge", shipped: true }, false);
}

/** A procedure written and published by the owner (a person), asking `roles` to confirm it. */
async function publishedProcedure(page: Page, title: string, roles: string[], word: string) {
  const made = await op<{ id: string }>(page.request, "record.create", {
    object: "knowledge.procedure",
    values: {
      title,
      summary: "What the coach on duty does first.",
      body: {
        blocks: [
          { type: "paragraph", content: [text("Stay calm and fetch the first aid kit.")] },
          { type: "heading", level: 1, content: [text("Afterwards")] },
          { type: "paragraph", content: [text(`Write it up in the ${word} book the same day.`)] },
        ],
      },
      mustRead: { everyone: false, roles },
    },
  });
  const published = await op<{ version: number }>(page.request, "record.publish", {
    object: "knowledge.procedure",
    id: made.id,
  });
  expect(published.version).toBe(1);
  return made.id;
}

test("a visitor searches the help centre and reads the page it finds", async ({
  page,
  browser,
  baseURL,
}) => {
  test.setTimeout(120_000);
  await setUp(page);
  const word = unique("kerbside").toLowerCase();
  const topic = await op<{ id: string }>(page.request, "record.create", {
    object: "knowledge.helptopic",
    values: { name: unique("Getting here "), order: 1 },
  });
  const title = unique("Parking ");
  const made = await op<{ id: string }>(page.request, "record.create", {
    object: "knowledge.helppage",
    values: {
      title,
      summary: "Free after 6pm behind the building.",
      topic: topic.id,
      order: 1,
      body: {
        blocks: [
          { type: "paragraph", content: [text("Most people walk or cycle.")] },
          { type: "heading", level: 1, content: [text("Where to park")] },
          { type: "paragraph", content: [text(`Use the ${word} bays behind the building.`)] },
        ],
      },
    },
  });
  await op(page.request, "record.publish", { object: "knowledge.helppage", id: made.id });
  // A procedure with the same word, published: staff only, never found by a visitor.
  await publishedProcedure(page, unique("Closing the car park "), ["admin"], word);
  const slug = (
    await op<{ values: { slug: string } }>(page.request, "record.get", {
      object: "knowledge.helppage",
      id: made.id,
    })
  ).values.slug;

  const visitor = await browser.newContext({ baseURL, storageState: { cookies: [], origins: [] } });
  try {
    const site = await visitor.newPage();
    await site.goto(block("knowledge-help-centre", "HelpCentre"));
    const search = site.getByRole("searchbox", { name: "Search help" });
    await expect(search).toBeVisible({ timeout: 30_000 });
    await search.fill(word.slice(0, -2));
    const results = site.getByRole("list", { name: "Search results" });
    const found = results.getByRole("link");
    await expect(found).toHaveCount(1, { timeout: 15_000 });
    await expect(found).toHaveText(title);
    await expect(results).toContainText("Where to park");
    // The match is under a heading: the link opens the page at that section.
    const href = (await found.getAttribute("href")) as string;
    expect(href).toBe(`/help/${slug}#where-to-park`);

    // The site's help page (the block the site's /help/<address> route renders).
    await site.goto(`${block("knowledge-help-page", "HelpPage", { slug })}#where-to-park`);
    const article = site.getByRole("article", { name: title });
    await expect(article).toBeVisible({ timeout: 30_000 });
    await expect(article.locator("#where-to-park")).toHaveText("Where to park");
    await expect(article).toContainText(`Use the ${word} bays behind the building.`);
  } finally {
    await visitor.close();
  }
});

test("a member reads and confirms what is theirs to read, and the owner sees who has not", async ({
  page,
  browser,
  baseURL,
}) => {
  test.setTimeout(150_000);
  await setUp(page);
  const title = unique("When someone is hurt ");
  const member = await staffAccount(browser, page, baseURL ?? "", unique("Robin "));
  const other = await staffAccount(browser, page, baseURL ?? "", unique("Sam "));
  try {
    const id = await publishedProcedure(page, title, ["member"], unique("incident"));

    // The member: To read, from the admin's navigation.
    await openScreen(member.page, "Knowledge", "To read");
    const toRead = member.page.getByRole("region", { name: "To read" });
    await toRead.getByRole("button", { name: `Read ${title}` }).click();
    const reader = member.page.getByRole("article", { name: title });
    await expect(reader).toContainText("Version 1, published");
    await expect(reader).toContainText("Write it up in the");
    await reader
      .getByRole("button", { name: `I have read and understood "${title}" (version 1)` })
      .click();
    await expect(reader.getByRole("status")).toContainText(
      "Confirmed: you have read and understood version 1",
    );
    // Confirmed: it has left the list, and is with what they confirmed.
    await reader.getByRole("button", { name: "All procedures" }).click();
    await expect(toRead.getByRole("button", { name: `Read ${title}` })).toHaveCount(0);
    await expect(
      member.page.getByRole("region", { name: "Confirmed" }).getByText(title),
    ).toBeVisible();

    // The owner: Read status, who has confirmed this version and who has not.
    await openScreen(page, "Knowledge", "Read status");
    await page.getByRole("button", { name: `Who has read ${title}` }).click();
    await waitForScreen(page);
    const table = page.getByRole("table", { name: `Who has read ${title}` });
    await expect(table.locator(`tr[data-person="${member.id}"]`)).toHaveAttribute(
      "data-state",
      "confirmed",
    );
    await expect(table.locator(`tr[data-person="${other.id}"]`)).toHaveAttribute(
      "data-state",
      "to_read",
    );
    await expect(table.locator(`tr[data-person="${other.id}"]`)).toContainText("Not yet");
    // The count, as the host has it now (other specs make members too).
    const status = await op<{
      procedure: { people: { confirmed: unknown }[] };
    }>(page.request, "x.knowledge.readStatus", { id });
    const confirmed = status.procedure.people.filter((p) => p.confirmed).length;
    await expect(page.getByText(/have confirmed this version\./)).toHaveText(
      `${confirmed} of ${status.procedure.people.length} have confirmed this version.`,
    );
  } finally {
    await member.context.close();
    await other.context.close();
  }
});

test("a coach follows the notice's link from their small shell, reads and confirms", async ({
  page,
  browser,
  baseURL,
}) => {
  test.setTimeout(150_000);
  await setUp(page);
  const title = unique("Fire alarm ");
  const coach = await staffAccount(browser, page, baseURL ?? "", unique("Coach "), {
    packRole: "bookings.coach",
  });
  try {
    const id = await publishedProcedure(page, title, ["bookings.coach"], unique("assembly"));
    const watch = watchRefusals(coach.page);
    await open(coach.page, "/");
    await expect(coach.page.locator('[data-shell="fixed-role"]')).toBeVisible();
    const knowledge = coach.page.getByTestId("screens-nav-Knowledge").getByRole("link");
    await expect(knowledge).toHaveText(["Procedures", "To read"]);

    // The notice ("Please read: …") links to the record; the small shell opens the reader.
    await coach.page.goto(`/x/knowledge.procedure/${id}`);
    await expect(coach.page).toHaveURL(new RegExp(`/s/knowledge/reader\\?record=${id}$`));
    await waitForScreen(coach.page);
    const reader = coach.page.getByRole("article", { name: title });
    await expect(reader).toContainText("Version 1, published");
    await reader
      .getByRole("button", { name: `I have read and understood "${title}" (version 1)` })
      .click();
    await expect(reader.getByRole("status")).toContainText("Confirmed");

    // Nothing of it left to read.
    await openScreen(coach.page, "Knowledge", "To read");
    await expect(
      coach.page.getByRole("region", { name: "To read" }).getByRole("button", {
        name: `Read ${title}`,
      }),
    ).toHaveCount(0);
    // Read status is not the coach's: not listed, and its address is "not found".
    await coach.page.goto("/s/knowledge/readStatus");
    await expect(coach.page.getByTestId("not-found")).toBeVisible();
    // The only call the coach's screens were refused is the sections' names (a full role's).
    await watch.settled();
    expect(watch.refused.filter((r) => !r.includes("record.list"))).toEqual([]);
  } finally {
    await coach.context.close();
  }
});
