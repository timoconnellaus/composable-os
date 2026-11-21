// Stage 23 end to end: the HTTP surface through cos-app's real Worker entry (src/server.ts), in
// front of TanStack Start and its staff-only middleware. Signed in, the caller is staff; with no
// session, the public; an old app's version is told to update.
import { expect, request as playwrightRequest, test } from "@playwright/test";

test("the surface answers staff, the public and an old app through the real entry", async ({
  page,
  baseURL,
}) => {
  // Signed in (the suite's saved session): staff.
  const list = await page.request.post("/api/v1/op/organisation.list", { data: {} });
  expect(list.status()).toBe(200);
  expect(await list.json()).toHaveProperty("data.items");
  const manifest = await page.request.get("/api/v1/manifest");
  expect((await manifest.json()).data.audience).toBe("staff");

  // No session: the public. A staff operation does not exist for them.
  const anonymous = await playwrightRequest.newContext({
    baseURL,
    storageState: { cookies: [], origins: [] },
  });
  const who = await (await anonymous.get("/api/v1/manifest")).json();
  expect(who.data.audience, JSON.stringify(who).slice(0, 200)).toBe("public");
  const closed = await anonymous.post("/api/v1/op/person.create", { data: { givenName: "x" } });
  expect(closed.status(), await closed.text()).toBe(404);
  expect(await closed.json()).toEqual({
    error: { code: "unknown_operation", message: 'No operation named "person.create"' },
  });
  expect((await (await anonymous.get("/api/v1/manifest")).json()).data.audience).toBe("public");

  // A version no longer served.
  const old = await anonymous.post("/api/v0/op/me.get", { data: {} });
  expect(old.status()).toBe(426);
  expect((await old.json()).error.code).toBe("upgrade_required");

  // Customer sign-in is mounted: without its setup it says so, the same for every address.
  const code = await anonymous.post("/api/customer-auth/email-otp/send-verification-otp", {
    data: { email: "someone@example.com", type: "sign-in" },
  });
  expect([200, 503]).toContain(code.status());
  await anonymous.dispose();
});
