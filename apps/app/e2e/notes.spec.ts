// Client notes (stage 56 step 2): an admin keeps a kind of note in Settings → Notes, with its
// template and who reads a note of it; on a person's page a note of that kind is written from its
// template at the kind's level, and shows on the timeline with its kind and level. A sensitive
// note is listed locked and opened one at a time.
import { expect, test } from "@playwright/test";
import { createPerson, open, unique } from "./helpers.ts";

test("keep a kind of note and write one from its template", async ({ page }) => {
  const token = unique("nk");
  const kindName = `Intake ${token}`;

  // Settings → Notes: a new kind, kept to the client's coaches, with a required section.
  await open(page, "/settings/notes");
  await expect(page.getByTestId("note-kind-list")).toContainText("Session note");
  await page.getByTestId("note-kind-new").click();
  const editor = page.getByTestId("note-kind-editor");
  await editor.getByLabel("Name").fill(kindName);
  await editor.getByTestId("note-kind-default").click();
  await page.getByRole("option", { name: "Client's coaches" }).click();
  await editor.getByTestId("note-kind-add-section").click();
  await editor.getByLabel("Section 1 label").fill("Goals");
  await editor.getByRole("checkbox", { name: "Must be filled in" }).click();
  await editor.getByRole("button", { name: "Save" }).click();
  const row = page.getByTestId("note-kind").filter({ hasText: kindName });
  await expect(row).toContainText("Client's coaches");
  await expect(row).toContainText("1 section");

  // On a person's page: the kind's template, at the kind's level.
  await createPerson(page, { given: "Noor", family: `Notes${token}` });
  const composer = page.getByRole("form", { name: "Add activity" });
  await composer.getByLabel("Kind").click();
  await page.getByRole("option", { name: kindName }).click();
  await expect(composer.getByLabel("Who can read it")).toHaveText("Client's coaches");
  const add = composer.getByRole("button", { name: "Add note" });
  await expect(add).toBeDisabled();
  await composer.getByLabel("Goals *").fill(`Run 5k ${token}`);
  await add.click();

  const entry = page.getByRole("listitem").filter({ hasText: `Run 5k ${token}` });
  await expect(entry).toBeVisible();
  await expect(entry.getByTestId("note-markers")).toContainText(kindName);
  await expect(entry.getByTestId("note-level")).toHaveText("Client's coaches");

  // A sensitive note is listed locked; opening it shows its text.
  await composer.getByLabel("Kind").click();
  await page.getByRole("option", { name: "Sensitive", exact: true }).click();
  await composer.getByLabel("Activity text").fill(`Knee ${token}`);
  await add.click();
  const locked = page
    .getByRole("listitem")
    .filter({ has: page.getByTestId("note-level").getByText("Sensitive") })
    .first();
  await expect(locked).toContainText("opening it is recorded");
  await expect(locked).not.toContainText(`Knee ${token}`);
  await locked.getByRole("button", { name: "Open" }).click();
  await expect(locked.getByTestId("opened-note")).toContainText(`Knee ${token}`);
});
