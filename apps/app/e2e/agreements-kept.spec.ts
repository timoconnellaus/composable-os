// Agreements, step 8 (stage 44, ADR 0646): what is kept after an erase. One journey: staff erase a
// person who signed a paper form, then find the kept agreement under Settings → Agreements → Kept
// after erase by the name it holds, open it, hold it from the retention purge and release it. All
// text is fixture text, not wording anyone should use.
import { type APIRequestContext, expect, test } from "@playwright/test";
import { open, unique } from "./helpers.ts";

async function op<T>(request: APIRequestContext, name: string, input: unknown): Promise<T> {
  const response = await request.post(`/api/v1/op/${name}`, {
    data: input,
    headers: { "idempotency-key": crypto.randomUUID() },
  });
  const body = (await response.json()) as { data?: T };
  expect(response.status(), `${name}: ${JSON.stringify(body).slice(0, 300)}`).toBe(200);
  return body.data as T;
}

const POINT = "agrkept";
const FIXTURE = `import { defineExtension } from "@composable-os/sdk";
export default defineExtension({
  id: "agrkept",
  version: "0.0.1",
  contractVersion: 1,
  label: "Agreement point (kept fixture)",
  permissions: { modules: [] },
  objects: {
    plan: {
      label: "Plan", plural: "Plans", titleField: "name",
      fields: { name: { type: "text", label: "Name" } },
      agreements: { point: "${POINT}", label: "A fixture plan" },
    },
  },
});
`;

test("staff find a kept agreement after an erase, open it, hold it and release it", async ({
  page,
}) => {
  test.setTimeout(120_000);
  await op(page.request, "extension.install", { id: "agrkept", files: { "index.ts": FIXTURE } });
  const title = `Kept waiver ${unique("doc")}`;
  const { id } = await op<{ id: string }>(page.request, "agreement.create", {
    title,
    kind: "waiver",
  });
  const saved = await op<{ hash: string; rev: number }>(page.request, "agreement.draft.save", {
    id,
    body: { blocks: [{ type: "paragraph", content: [{ type: "text", text: "Fixture text." }] }] },
    tickLabel: "I have read the fixture",
  });
  const { version } = await op<{ version: { id: string } }>(page.request, "agreement.publish", {
    documentId: id,
    draftHash: saved.hash,
    draftRev: saved.rev,
    number: 1,
    change: "small",
  });
  await op(page.request, "agreement.attach", { documentId: id, points: [POINT] });
  const person = await op<{ id: string }>(page.request, "person.create", {
    givenName: unique("Kept"),
  });
  const typedName = `Fixture ${unique("Signer")}`;
  await op(page.request, "agreement.recordPaper", {
    personId: person.id,
    versionId: version.id,
    signedOn: new Date().toISOString().slice(0, 10),
    typedName,
  });
  const erased = await op<{ agreementsKept?: { count: number; until: string | null } }>(
    page.request,
    "person.erase",
    { id: person.id },
  );
  expect(erased.agreementsKept?.count).toBe(1);

  await open(page, "/settings/agreements/kept");
  await expect(page.getByTestId("agreement-retention")).toContainText("years from each erase");
  await page.getByLabel("The address the copy went to, or the name typed").fill(typedName);
  await page.getByRole("button", { name: "Find" }).click();
  const found = page.getByTestId("kept-agreements");
  await expect(found).toContainText(`${title}, version 1`);
  await expect(found).toContainText("kept until");
  await found.getByRole("button", { name: "Open" }).click();
  await expect(page.getByTestId("kept-opened")).toContainText(typedName);
  await found.getByRole("button", { name: "Hold" }).click();
  await expect(found.getByText("On hold")).toBeVisible();
  await found.getByRole("button", { name: "Release" }).click();
  await expect(found).toContainText("kept until");
});
