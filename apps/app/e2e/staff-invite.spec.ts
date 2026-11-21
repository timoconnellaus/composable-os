// Staff invites end to end (ADR 0455), through cos-app's real Worker entry, the real sign-in page
// and the fake provider's outbox as the host's mail connection: an admin invites a person as a
// viewer on Settings → Users; that person asks for a code on the sign-in page, signs in with the
// code the host emailed, and lands in the app as a viewer; the same code a second time is refused.
//
// The invitee is a colleague (at the outbox's own domain), so the host's mail to them is the fake
// outbox's "Send internal mail" kind, which the admin lets apply without review, as an admin does
// for email-send's "Send email to colleagues". A code whose send is queued for review is deleted
// at once (ADR 0455), so approving it in Approvals would not sign anyone in.
import { type APIRequestContext, expect, type Page, test } from "@playwright/test";
import { open } from "./helpers.ts";
import {
  addFakeResource,
  connectFake,
  fakeAddress,
  openIntegrations,
  sentMail,
} from "./integration-helpers.ts";

const escapeRe = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Lets the fake outbox's mail to colleagues apply without review, or not. */
async function autoApproveColleagueMail(request: APIRequestContext, enabled: boolean) {
  const response = await request.post("/api/v1/op/outbound.setAutoApprove", {
    data: { tag: "fake.internal", enabled },
    headers: { "idempotency-key": crypto.randomUUID() },
  });
  expect(response.status(), await response.text()).toBe(200);
}

/**
 * Approves the invite notice to `to` if it waits for review (it does on a fresh database, where the
 * colleague kind is only known once the notice was submitted). It holds no secret.
 */
async function approveInviteNotice(page: Page, to: string): Promise<void> {
  await open(page, "/approvals");
  await expect(page.getByRole("heading", { level: 1, name: "Approvals" })).toBeVisible();
  const action = page
    .getByTestId("pending-action")
    .filter({ has: page.getByTestId("outbound-preview").filter({ hasText: to }) });
  // The page loads its queue after the heading: give the notice time to show, if it waits.
  const waiting = await action
    .first()
    .waitFor({ timeout: 10_000 })
    .then(() => true)
    .catch(() => false);
  if (!waiting) return;
  const set = page.getByTestId("change-set").filter({ has: action.first() });
  await set.getByRole("button", { name: /^Approve( \d+)?$/ }).click();
  await expect(set.getByTestId("decision-result")).toContainText("Applied");
}

test("an admin invites a person, who signs in once with the emailed code as a viewer", async ({
  page,
  browser,
  baseURL,
}) => {
  test.setTimeout(120_000);
  const outbox = fakeAddress("hostmail");
  const invitee = fakeAddress("coach");

  // The host's mail goes out from an org outbox chosen on Settings → Users.
  await openIntegrations(page);
  const connection = await connectFake(page, outbox, "org");
  await addFakeResource(page, connection, "Outbox", outbox);
  await open(page, "/settings/users");
  await expect(page.getByRole("heading", { level: 1, name: "Users and roles" })).toBeVisible();
  await page.getByLabel("Mail connection").click();
  await page.getByRole("option", { name: new RegExp(escapeRe(outbox)) }).click();
  await expect(page.getByText("The host's mail connection is saved")).toBeVisible();

  let autoApproved = false;
  try {
    // The invite.
    const form = page.getByRole("form", { name: "Invite someone" });
    await form.getByLabel("Email").fill(invitee);
    await form.getByLabel("Role").click();
    await page.getByRole("option", { name: "Viewer" }).click();
    await form.getByRole("button", { name: "Send invite" }).click();
    const row = page.getByTestId("invite-row").filter({ hasText: invitee });
    await expect(row).toBeVisible();
    await expect(row).toContainText("Viewer");
    // The host's mail to colleagues applies without review from now on. A send still waiting for
    // review holds back every later one on the same outbox (the gatekeeper applies them in
    // order), so the invite notice, if it waits, is approved first.
    await autoApproveColleagueMail(page.request, true);
    autoApproved = true;
    await approveInviteNotice(page, invitee);
    // The invited person, in a browser with no session, asks for a code.
    const guest = await browser.newContext({ baseURL, storageState: { cookies: [], origins: [] } });
    const person = await guest.newPage();
    await person.goto("/sign-in");
    const ask = person.getByRole("form", { name: "Sign in with a code" });
    // Hydrated first: the form is controlled, so text typed before React takes over is lost.
    await expect(ask.getByRole("button", { name: "Email me a code" })).toBeEnabled();
    await ask.getByLabel("Email").fill(invitee);
    await expect(ask.getByLabel("Email")).toHaveValue(invitee);
    await ask.getByRole("button", { name: "Email me a code" }).click();
    const enter = person.getByRole("form", { name: "Enter your code" });
    await expect(enter).toBeVisible();

    let code = "";
    await expect
      .poll(
        async () => {
          const mail = await sentMail(page.request, outbox);
          const sent = mail.find((m) => m.to.includes(invitee) && /sign-in code/.test(m.subject));
          code = /(\d{6})/.exec(sent?.text ?? "")?.[1] ?? "";
          return code;
        },
        { timeout: 30_000 },
      )
      .toMatch(/^\d{6}$/);

    await enter.getByLabel("Code").fill(code);
    await enter.getByRole("button", { name: "Sign in" }).click();
    await expect(person).not.toHaveURL(/\/sign-in/, { timeout: 20_000 });

    // In the app, as a viewer: they read, and cannot write.
    const manifest = await (await person.request.get("/api/v1/manifest")).json();
    expect(manifest.data.audience).toBe("staff");
    const write = await person.request.post("/api/v1/op/person.create", {
      data: { givenName: "Not allowed" },
      headers: { "idempotency-key": crypto.randomUUID() },
    });
    expect(write.status(), await write.text()).toBe(403);
    await open(person, "/settings/users");
    await expect(
      person.getByTestId("user-row").filter({ hasText: invitee }).getByText("Viewer"),
    ).toBeVisible();
    // The invite is accepted: it is no longer pending.
    await page.reload();
    await expect(page.getByTestId("invite-row").filter({ hasText: invitee })).toHaveCount(0);

    // The same code a second time, from another browser: refused like any wrong code.
    const other = await browser.newContext({ baseURL, storageState: { cookies: [], origins: [] } });
    const again = await other.request.post("/api/auth/sign-in/email-otp", {
      data: { email: invitee, otp: code },
      headers: { origin: baseURL ?? "" },
    });
    expect(again.status()).toBe(400);
    expect(await again.json()).toEqual({ code: "INVALID_OTP", message: "Invalid code" });
    await other.close();
    await guest.close();
  } finally {
    // Other specs expect the fake outbox's mail to wait for review.
    if (autoApproved) await autoApproveColleagueMail(page.request, false);
  }
});
