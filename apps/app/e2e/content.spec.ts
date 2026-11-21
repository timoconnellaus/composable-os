// Stage 28 end to end, one journey (criterion 14): staff write a post in the rich text editor
// (typing, and a paste the editor turns into blocks), schedule it, publish it, and the public reads
// it with no account through the host's HTTP surface. In local dev Content is the org's own
// extension (scripts/dev-setup.mjs), installed by an admin here as a product that lists the pack
// would have it.
import {
  type APIRequestContext,
  expect,
  request as playwrightRequest,
  test,
} from "@playwright/test";
import { unique } from "./helpers.ts";

async function op<T>(request: APIRequestContext, name: string, input: unknown): Promise<T> {
  const response = await request.post(`/api/v1/op/${name}`, {
    data: input,
    headers: { "idempotency-key": crypto.randomUUID() },
  });
  const body = (await response.json()) as { data?: T; error?: unknown };
  expect(response.status(), `${name}: ${JSON.stringify(body).slice(0, 300)}`).toBe(200);
  return body.data as T;
}

test("staff write, schedule and publish a post, and the public reads it", async ({
  page,
  baseURL,
}) => {
  test.setTimeout(180_000);
  await op(page.request, "extension.install", { id: "content", shipped: true }).catch(
    () => undefined,
  );
  const title = unique("Opening night ");
  const post = await op<{ id: string; values: { slug: string } }>(page.request, "record.create", {
    object: "content.post",
    values: { title },
  });
  const slug = post.values.slug;

  // The public reads nothing of a draft: the same answer as a post that never was.
  const anyone = await playwrightRequest.newContext({ baseURL });
  const read = async () => {
    const response = await anyone.post("/api/v1/op/content.get", {
      data: { object: "content.post", slug },
    });
    return { status: response.status(), body: (await response.json()) as Record<string, unknown> };
  };
  expect(await read()).toMatchObject({ status: 404, body: { error: { message: "Not found" } } });

  // Write the body in the editor: typed words, then a paste of HTML.
  await page.goto(`/x/content.post/${post.id}`);
  const details = page.getByTestId("record-fields");
  await details.getByRole("button", { name: "Edit Details" }).click();
  const editor = details.getByTestId("rich-text-editor");
  await editor.click();
  await page.keyboard.type("Doors open at seven.");
  await page.keyboard.press("Enter");
  await editor.evaluate((element) => {
    const data = new DataTransfer();
    data.setData(
      "text/html",
      "<p>Bring <b>ID</b><script>alert(1)</script></p><table><tr><td>Bar opens at six</td></tr></table>",
    );
    data.setData("text/plain", "Bring ID. Bar opens at six");
    element.dispatchEvent(
      new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }),
    );
  });
  await expect(editor).toContainText("Bar opens at six");
  await details.getByRole("button", { name: "Save" }).click();
  await expect(details.getByRole("button", { name: "Edit Details" })).toBeVisible();

  // What was stored is the platform's rich text, with no markup in it.
  const stored = await op<{ values: { body: { blocks: { type: string }[] } } }>(
    page.request,
    "record.get",
    { object: "content.post", id: post.id },
  );
  const body = JSON.stringify(stored.values.body);
  expect(body).toContain("Doors open at seven.");
  expect(body).toContain('"bold":true');
  expect(body).toContain("Bar opens at six");
  expect(body).not.toMatch(/<|script|alert/);

  // Schedule it an hour ahead: scheduled, and still nothing for the public.
  const card = page.getByTestId("publish-card");
  await expect(card.getByTestId("publish-state")).toHaveText("Draft");
  await card.getByRole("button", { name: "Schedule" }).click();
  await expect(card.getByTestId("publish-state")).toHaveText("Scheduled");
  expect((await read()).status).toBe(404);

  // Publish it now: the public reads it, with only what it may read.
  await card.getByRole("button", { name: "Publish now" }).click();
  await expect(card.getByTestId("publish-state")).toHaveText("Published");
  await expect(card.getByTestId("versions")).toContainText("Version 1 (live)");
  const published = await read();
  expect(published.status).toBe(200);
  expect(published.body).toMatchObject({
    data: { kind: "record", id: post.id, values: { title, slug } },
  });
  expect(JSON.stringify(published.body)).toContain("Doors open at seven.");
  expect(JSON.stringify(published.body)).not.toContain('"author"');
  await anyone.dispose();
});
