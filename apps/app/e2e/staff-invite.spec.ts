// Staff invites end to end (ADR 0455), through cos-app's real Worker entry, the real sign-in page
// and the fake provider's outbox as the host's mail connection: an admin invites a person as a
// viewer on Settings → Users; that person asks for a code on the sign-in page, signs in with the
// code the host emailed, and lands in the app as a viewer; the same code a second time is refused.
//
// Sign-in codes go out as the host's sign-in mail (ADR 0456), which the admin lets apply without
// review on the same screen; the invitee is an outside address. The invite notice is an ordinary
// send: it waits in Approvals, and does not hold back the code. The journey rejects it at the end,
// so it does not stay waiting in the shared database for the specs after it (issue #473).
import { type APIRequestContext, expect, test } from "@playwright/test";
import { open } from "./helpers.ts";
import {
  addFakeResource,
  connectFake,
  fakeAddress,
  openIntegrations,
  sentMail,
} from "./integration-helpers.ts";

const escapeRe = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

async function op<T>(request: APIRequestContext, name: string, input: unknown): Promise<T> {
  const response = await request.post(`/api/v1/op/${name}`, {
    data: input,
    headers: { "idempotency-key": crypto.randomUUID() },
  });
  const body = (await response.json()) as { data?: T };
  expect(response.status(), `${name}: ${JSON.stringify(body).slice(0, 300)}`).toBe(200);
  return body.data as T;
}

type WaitingAction = { id: string; operation: string; status: string; input: unknown };

/** The invite notice to `invitee` waiting in Approvals: its action id, or "" when none waits. */
async function waitingNotice(request: APIRequestContext, invitee: string): Promise<string> {
  const sets = await op<{ items: { id: string }[] }>(request, "approval.list", {
    status: "awaiting_review",
    limit: 100,
  });
  for (const set of sets.items) {
    const detail = await op<{ actions: WaitingAction[] }>(request, "approval.get", {
      changeSetId: set.id,
    });
    const notice = detail.actions.find(
      (a) =>
        a.status === "pending" &&
        a.operation === "integration.outbound" &&
        JSON.stringify(a.input).includes(invitee),
    );
    if (notice) return notice.id;
  }
  return "";
}

test("an admin invites a person, who signs in once with the emailed code as a viewer", async ({
  page,
  browser,
  baseURL,
}) => {
  test.setTimeout(120_000);
  const outbox = fakeAddress("hostmail");
  const invitee = `coach-${crypto.randomUUID().slice(0, 8)}@outside.test`;

  // The host's mail goes out from an org outbox chosen on Settings → Users.
  await openIntegrations(page);
  const connection = await connectFake(page, outbox, "org");
  await addFakeResource(page, connection, "Outbox", outbox);
  await open(page, "/settings/users");
  await expect(page.getByRole("heading", { level: 1, name: "Users and roles" })).toBeVisible();
  await page.getByLabel("Mail connection").click();
  await page.getByRole("option", { name: new RegExp(escapeRe(outbox)) }).click();
  await expect(page.getByText("The host's mail connection is saved")).toBeVisible();

  // Until the host's sign-in mail may go out without review, nobody can sign in by code.
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
  try {
    // The invite.
    const form = page.getByRole("form", { name: "Invite someone" });
    await form.getByLabel("Email").fill(invitee);
    await form.getByLabel("Role", { exact: true }).click();
    await page.getByRole("option", { name: "Viewer" }).click();
    await form.getByRole("button", { name: "Send invite" }).click();
    const row = page.getByTestId("invite-row").filter({ hasText: invitee });
    await expect(row).toBeVisible();
    await expect(row).toContainText("Viewer");
    // The invite notice waits in Approvals.
    await expect.poll(() => waitingNotice(page.request, invitee)).toMatch(/^pac_/);
    // The invited person, in a browser with no session, asks for a code.
    const guest = await browser.newContext({ baseURL, storageState: { cookies: [], origins: [] } });
    const person = await guest.newPage();
    await person.goto("/sign-in");
    // Hydrated first: the form is controlled, so text typed before React takes over is lost.
    const useCode = person.getByRole("button", { name: /Use a code from email/ });
    await expect(useCode).toBeEnabled();
    await useCode.click();
    const ask = person.getByRole("form", { name: "Sign in with a code" });
    // The code form replaces the password form: one email field on the page.
    await expect(person.getByLabel("Email")).toHaveCount(1);
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
    // Leave nothing waiting in Approvals: the other specs count what waits there.
    const notice = await waitingNotice(page.request, invitee);
    if (notice) await op(page.request, "approval.reject", { actionIds: [notice] });
    // Leave the fake outbox's sign-in mail reviewed again for the other specs.
    await page.request.post("/api/v1/op/outbound.setAutoApprove", {
      data: { tag: "fake.signin", enabled: false },
      headers: { "idempotency-key": crypto.randomUUID() },
    });
  }
});
