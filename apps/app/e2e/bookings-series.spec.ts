// Stage 45 step 1 (ADR 0620) end to end, one journey: staff swap the coach on one class of a
// series on its record page, then change the series' time on the series' page. The class moves
// with the rest of the series and keeps its swapped coach; the series' other class keeps the
// series' coach. Local dev has no cron ticks, so the minute cron that makes the classes is run
// through the dev-only route (as the webhook spec does).
import { type APIRequestContext, expect, type Page, test } from "@playwright/test";
import { open, unique } from "./helpers.ts";
import { runMinuteCron } from "./integration-helpers.ts";

async function op<T>(request: APIRequestContext, name: string, input: unknown, ok = true) {
  const response = await request.post(`/api/v1/op/${name}`, {
    data: input,
    headers: { "idempotency-key": crypto.randomUUID() },
  });
  const body = (await response.json()) as { data?: T; error?: unknown };
  if (ok) expect(response.status(), `${name}: ${JSON.stringify(body).slice(0, 300)}`).toBe(200);
  return body.data as T;
}

const DAY = 86_400_000;
const WEEKDAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];

/** Edits one field of a record's Details card and saves it. */
async function editDetails(page: Page, fill: (form: ReturnType<Page["locator"]>) => Promise<void>) {
  await page.getByRole("button", { name: "Edit Details" }).click();
  const form = page.locator("form").filter({ has: page.getByRole("button", { name: "Save" }) });
  await fill(form);
  await form.getByRole("button", { name: "Save" }).click();
  await expect(page.getByRole("button", { name: "Edit Details" })).toBeVisible();
}

test("staff swap the coach on one class, then move the series: the class moves and keeps its coach", async ({
  page,
}) => {
  test.setTimeout(180_000);
  for (const id of ["bookings"]) {
    await op(page.request, "extension.install", { id, shipped: true }, false);
  }
  const type = await op<{ id: string }>(page.request, "record.create", {
    object: "bookings.classtype",
    values: { name: unique("Strength ") },
  });
  const regular = await op<{ id: string }>(page.request, "record.create", {
    object: "bookings.coach",
    values: { name: unique("Regular ") },
  });
  const standIn = unique("Stand-in ");
  const other = await op<{ id: string }>(page.request, "record.create", {
    object: "bookings.coach",
    values: { name: standIn },
  });
  // Two classes a week apart, on a weekday three days from now, at 12:00 UTC.
  const first = new Date(Date.now() + 3 * DAY);
  const dates = [first, new Date(first.getTime() + 7 * DAY)].map((d) =>
    d.toISOString().slice(0, 10),
  );
  const series = await op<{ id: string }>(page.request, "record.create", {
    object: "bookings.series",
    values: {
      classType: type.id,
      weekdays: [WEEKDAYS[first.getUTCDay()]],
      time: "12:00",
      length: 60,
      places: 6,
      coach: regular.id,
      firstDate: dates[0],
      lastDate: dates[1],
      timezone: "UTC",
    },
  });
  const classes = async () =>
    (
      await op<{ items: { id: string; values: Record<string, unknown> }[] }>(
        page.request,
        "record.list",
        {
          object: "bookings.class",
          filter: { field: "series", op: "eq", value: series.id },
          sort: { field: "startsAt", direction: "asc" },
        },
      )
    ).items;
  await expect
    .poll(async () => {
      await runMinuteCron(page.request);
      return (await classes()).length;
    })
    .toBe(2);
  const [swapped, kept] = await classes();
  if (!swapped || !kept) throw new Error("expected two classes");

  // The coach swapped for that one date, on the class's page.
  await open(page, `/x/bookings.class/${swapped.id}`);
  await editDetails(page, async (form) => {
    await form.getByRole("combobox", { name: "Coach" }).click();
    await page.getByRole("option", { name: standIn, exact: true }).click();
  });
  const own = await op<{ detached: boolean; fields: { field: string }[] }>(
    page.request,
    "recurring.exceptions",
    { object: "bookings.class", id: swapped.id },
  );
  expect(own).toMatchObject({ detached: false, fields: [{ field: "coach" }] });

  // The series moves to 13:00, on its page.
  await open(page, `/x/bookings.series/${series.id}`);
  await editDetails(page, async (form) => {
    await form.getByLabel("Starts at (local time)").fill("13:00");
  });

  await expect
    .poll(async () =>
      (await classes()).map((c) => [String(c.values.startsAt).slice(11, 16), c.values.coach]),
    )
    .toEqual([
      ["13:00", other.id],
      ["13:00", regular.id],
    ]);
  // The class's page shows its own coach still.
  await open(page, `/x/bookings.class/${swapped.id}`);
  await expect(page.locator('[data-field="coach"]')).toContainText(standIn);
});
