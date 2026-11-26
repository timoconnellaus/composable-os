// The shared inbox's web screens (stage 36 step 3), one journey: two staff work one conversation.
// An admin sets the inbox's categories (Settings → Inbox) and a shared saved reply; an email
// arrives from a member (through the fake provider's development route, written by the host's own
// writers as the inbound hook of step 2 will); a member of staff finds it unassigned, takes it,
// and the admin, on the same conversation, sees who has it. The admin files it and leaves a note
// mentioning them; the member puts the saved reply into the reply box with the person's first name
// filled in, and marks the conversation waiting. The email's HTML is shown as text, its snippet and
// its full body. Moving to the person's other conversation leaves the reply behind. The Person's
// page lists the conversation.
//
// The category and the saved reply are fixed names made only when missing, so a reused local
// database does not fill up with one per run.
//
// Sending the reply is step 2's (`message.send`): the Send button is off here. Rules and edge
// cases (private conversations, who may write shared replies, slots) are in core's vitest.
import { type APIRequestContext, expect, test } from "@playwright/test";
import { open, staffAccount, unique } from "./helpers.ts";

async function op<T>(request: APIRequestContext, name: string, input: unknown): Promise<T> {
  const response = await request.post(`/api/v1/op/${name}`, {
    data: input,
    headers: { "idempotency-key": crypto.randomUUID() },
  });
  const body = (await response.json()) as { data?: T };
  expect(response.status(), `${name}: ${JSON.stringify(body).slice(0, 300)}`).toBe(200);
  return body.data as T;
}

test("two staff work one conversation: take it, see who has it, file it, note it, reply with a saved reply", async ({
  page,
  browser,
  baseURL,
}) => {
  test.setTimeout(150_000);
  const token = unique();
  const category = "Bookings (e2e)";
  const savedTitle = "Moving a class (e2e)";
  const given = `Ada${token}`;

  // Settings → Inbox: the admin adds the category when it is not there yet, keeping the rest.
  await open(page, "/settings/inbox");
  await expect(page.getByRole("button", { name: "Save categories" })).toBeVisible();
  if ((await page.getByTestId("inbox-category").filter({ hasText: category }).count()) === 0) {
    await page.getByLabel("New category").fill(category);
    await page.getByRole("button", { name: "Add", exact: true }).click();
    await page.getByRole("button", { name: "Save categories" }).click();
    await expect(page.getByText("Categories saved")).toBeVisible();
  }
  await expect(page.getByTestId("inbox-category").filter({ hasText: category })).toHaveCount(1);

  // A shared saved reply with the person's first name in it, made when it is not there yet.
  await open(page, "/inbox/saved-replies");
  const existing = page.getByTestId("saved-reply").filter({ hasText: savedTitle });
  await expect(page.locator('[aria-busy="true"]')).toHaveCount(0);
  if ((await existing.count()) === 0) {
    await page.getByRole("button", { name: "New saved reply" }).click();
    const dialog = page.getByRole("dialog", { name: "New saved reply" });
    await dialog.getByLabel("Title").fill(savedTitle);
    await dialog.getByLabel("Words").fill("Hi ");
    await dialog.getByRole("button", { name: "Their first name" }).click();
    await dialog.getByLabel("Words").press("End");
    await dialog.getByLabel("Words").pressSequentially(", of course: which class suits you?");
    await dialog.getByLabel("Shared with everyone on the inbox").check();
    await dialog.getByRole("button", { name: "Save reply" }).click();
    await expect(page.getByText("Reply saved")).toBeVisible();
  }
  await expect(
    page.getByTestId("saved-reply").filter({ hasText: savedTitle }).getByText("Shared"),
  ).toBeVisible();

  // An email arrives from a member the business knows.
  const person = await op<{ id: string }>(page.request, "person.create", {
    givenName: given,
    familyName: "Byron",
    emails: [{ email: `${token}@example.com` }],
  });
  const subject = `Can I move my class? ${token}`;
  // An earlier conversation of theirs, about something else.
  const earlier = await page.request.post("/gatekeeper/fake/inbox", {
    data: { personId: person.id, subject: `My locker ${token}`, text: "Is there a locker free?" },
  });
  expect(earlier.ok(), await earlier.text()).toBe(true);
  const { conversationId: otherId } = (await earlier.json()) as { conversationId: string };
  const seeded = await page.request.post("/gatekeeper/fake/inbox", {
    data: {
      personId: person.id,
      subject,
      text: "Hello, can I move Tuesday's class? <b>Thanks</b>",
      full: "Hello, can I move Tuesday's class? <b>Thanks</b>\n\n<i>Sent from my phone</i>",
    },
  });
  expect(seeded.ok(), await seeded.text()).toBe(true);
  const { conversationId } = (await seeded.json()) as { conversationId: string };

  // A member of staff finds it in the unassigned view and opens it.
  const member = await staffAccount(browser, page, baseURL as string, `Grace ${token}`);
  await open(member.page, "/inbox?view=unassigned");
  const row = member.page.locator(`[data-conversation="${conversationId}"]`);
  await expect(row).toContainText(`${given} Byron`);
  await expect(row).toContainText("Unassigned");
  await row.getByRole("link").click();
  await expect(member.page).toHaveURL(new RegExp(`/inbox/${conversationId}`));
  // What they wrote, as text: the tag is shown, never made bold.
  const message = member.page.getByTestId("conversation-message");
  await expect(message.getByTestId("message-body")).toHaveText(
    "Hello, can I move Tuesday's class? <b>Thanks</b>",
  );
  await expect(message.locator("b")).toHaveCount(0);
  // The full email from blob storage, as text too.
  await message.getByRole("button", { name: "Show full email" }).click();
  await expect(message.getByTestId("message-body")).toContainText("<i>Sent from my phone</i>");
  await expect(message.locator("b, i")).toHaveCount(0);

  // The admin has it open too; the member takes it; the admin sees who has it.
  await open(page, `/inbox/${conversationId}`);
  await expect(page.getByTestId("assignee")).toHaveText("Nobody has it yet");
  await member.page.getByRole("button", { name: "Take it" }).click();
  await expect(member.page.getByTestId("assignee")).toHaveText("You have it");
  await expect(page.getByTestId("assignee")).toHaveText(`Grace ${token} has it`, {
    timeout: 30_000,
  });
  await expect(page.getByRole("button", { name: "Take it" })).toHaveCount(0);

  // The admin files it and leaves a note for the member.
  await page.getByLabel("Category").click();
  await page.getByRole("option", { name: category }).click();
  await expect(page.getByLabel("Category")).toContainText(category);
  await page.getByRole("tab", { name: "Note" }).click();
  await page.getByRole("textbox", { name: "Note" }).fill("They booked Tuesday last week too.");
  await page.getByRole("button", { name: "Mention" }).click();
  await page.getByRole("menuitemcheckbox", { name: `Grace ${token}` }).click();
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "Add note" }).click();
  await expect(page.getByText("Note added")).toBeVisible();

  // The member sees the note (staff only) and replies with the saved reply.
  await member.page.reload();
  await expect(member.page.getByTestId("conversation-note")).toContainText(
    "They booked Tuesday last week too.",
  );
  await expect(member.page.getByTestId("conversation-note")).toContainText("Staff only");
  // They glance at the person's other conversation and come back (both now read in this tab).
  const other = member.page.getByRole("link", { name: `My locker ${token}` });
  await other.click();
  await expect(member.page).toHaveURL(new RegExp(`/inbox/${otherId}`));
  await expect(
    member.page.getByTestId("conversation-message").filter({ hasText: "Is there a locker free?" }),
  ).toBeVisible();
  // Nothing of the conversation they came from: its message, its note.
  await expect(
    member.page.getByTestId("conversation-message").filter({ hasText: "Tuesday" }),
  ).toHaveCount(0);
  await expect(member.page.getByTestId("conversation-note")).toHaveCount(0);
  await member.page.goBack();
  await expect(member.page.getByTestId("conversation-note")).toBeVisible();
  await member.page.getByRole("button", { name: "Saved replies" }).click();
  await member.page.getByRole("menuitem", { name: savedTitle }).click();
  await expect(member.page.getByRole("textbox", { name: "Reply" })).toHaveValue(
    `Hi ${given}, of course: which class suits you?`,
  );
  // Sending is not on until email goes out from the inbox (step 2).
  await expect(member.page.getByRole("button", { name: "Send" })).toBeDisabled();

  // The other conversation, read a moment ago in this tab, opens with its own empty reply box:
  // not this one's words and first name (the page is reused from one conversation to the next).
  await other.click();
  await expect(member.page).toHaveURL(new RegExp(`/inbox/${otherId}`));
  await expect(
    member.page.getByTestId("conversation-message").filter({ hasText: "Is there a locker free?" }),
  ).toBeVisible();
  // Nothing of the conversation they came from: its message, its note.
  await expect(
    member.page.getByTestId("conversation-message").filter({ hasText: "Tuesday" }),
  ).toHaveCount(0);
  await expect(member.page.getByTestId("conversation-note")).toHaveCount(0);
  await expect(member.page.getByRole("textbox", { name: "Reply" })).toHaveValue("");
  await member.page.goBack();
  await expect(member.page).toHaveURL(new RegExp(`/inbox/${conversationId}`));
  await expect(member.page.getByTestId("conversation-note")).toBeVisible();

  // Waiting on them.
  await member.page.getByLabel("Status").click();
  await member.page.getByRole("option", { name: "Waiting on them" }).click();
  await expect(member.page.getByTestId("conversation-status")).toHaveText("Waiting on them");

  // The member's own view lists it, filed and waiting; the Person's page lists it.
  await open(member.page, "/inbox?view=mine");
  const mine = member.page.locator(`[data-conversation="${conversationId}"]`);
  await expect(mine).toContainText(category);
  await expect(mine).toContainText("Waiting on them");
  await open(page, `/people/${person.id}?tab=conversations`);
  await expect(page.getByTestId("person-conversation").filter({ hasText: subject })).toBeVisible();

  await member.context.close();
});
