// Stage 44 step 4 (ADR 0645): the signed PDF's download routes. The operations decide who may
// have which file (the seam, audiences, actors); the route draws what they return with the email
// gatekeeper's PDF writer and serves it as a download nobody caches:
//
// - a signed-in customer gets their own, over the host's hostname and over the client-app binding;
//   another customer and the public get "not found", and never a version's blank form;
// - a person on the staff gets any one, and a version's blank form to print.
// All text here is fixture text.
import { env } from "cloudflare:workers";
import { createIdentityProvider, getCustomerIdentity } from "@composable-os/auth";
import { inviteCustomer } from "@composable-os/core";
import { createCrmDb } from "@composable-os/db";
import { type AgreementPdf, agreementPdf } from "@composable-os/pdf";
import { beforeAll, describe, expect, it } from "vitest";
import { handleAgreementPdf } from "../src/server/http/agreement-pdf.ts";
import { type ApiEnv, apiContext } from "../src/server/http/api.ts";
import { handleBound } from "../src/server/http/bound.ts";
import type { McpEnv } from "../src/server/mcp/handler.ts";
import { runOperation } from "../src/server/operations.ts";
import { ORIGIN, signUp, type TestUser, testEnv, unique } from "./mcp-helpers.ts";

const CUSTOMER_SECRET = "customer-secret-for-the-pdf-routes-456";
const WEB = "https://shop.test";
const BOUND = "https://host.internal";

const pdfEnv = {
  ...testEnv(),
  CUSTOMER_AUTH_SECRET: CUSTOMER_SECRET,
  CUSTOMER_AUTH_URL: WEB,
} as unknown as ApiEnv & McpEnv;
const db = createCrmDb(env.DB);

const codes = new Map<string, string>();
getCustomerIdentity(pdfEnv, async ({ to, code }) => {
  codes.set(to.toLowerCase(), code);
});

interface Customer {
  email: string;
  personId: string;
  cookie: string;
}

let admin: TestUser;
let ada: Customer;
let bea: Customer;
let versionId: string;
let acceptanceId: string;

const cookiesOf = (response: Response) =>
  response.headers
    .getSetCookie()
    .map((c) => c.split(";")[0])
    .join("; ");

function bound(
  path: string,
  init: { body?: unknown; headers?: Record<string, string>; method?: string } = {},
) {
  return handleBound(
    new Request(`${BOUND}${path}`, {
      method: init.method ?? "POST",
      headers: { "content-type": "application/json", ...init.headers },
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
    }),
    pdfEnv,
  );
}

async function newCustomer(givenName: string): Promise<Customer> {
  const email = `${unique(givenName.toLowerCase())}@example.com`;
  const principal = await createIdentityProvider(pdfEnv).resolve(
    new Request(BOUND, { headers: { cookie: admin.cookie } }),
  );
  const made = await runOperation(pdfEnv, principal, {
    name: "person.create",
    input: { givenName, familyName: "Tester", emails: [{ email }] },
  });
  if (!made.ok) throw new Error(JSON.stringify(made));
  await inviteCustomer(db, email, admin.id, new Date().toISOString());
  const asked = await bound("/api/customer-auth/email-otp/send-verification-otp", {
    body: { email, type: "sign-in" },
    headers: { origin: WEB },
  });
  expect(asked.status).toBe(200);
  const signedIn = await bound("/api/customer-auth/sign-in/email-otp", {
    body: { email, otp: codes.get(email.toLowerCase()) },
    headers: { origin: WEB },
  });
  expect(signedIn.status).toBe(200);
  return { email, personId: (made.data as { id: string }).id, cookie: cookiesOf(signedIn) };
}

async function asAdmin<T>(name: string, input: unknown): Promise<T> {
  const principal = await createIdentityProvider(pdfEnv).resolve(
    new Request(BOUND, { headers: { cookie: admin.cookie } }),
  );
  const result = await runOperation(pdfEnv, principal, { name, input });
  if (!result.ok) throw new Error(JSON.stringify(result));
  return result.data as T;
}

/** A download on the host's own hostname, as cos-app serves it, with this cookie. */
const onHost = (path: string, cookie?: string, method = "GET") =>
  handleAgreementPdf(
    new Request(`${ORIGIN}${path}`, { method, headers: cookie ? { cookie } : {} }),
    { context: (req) => apiContext(req, pdfEnv) },
  );

beforeAll(async () => {
  admin = await signUp(pdfEnv, "admin");
  ada = await newCustomer("Ada");
  bea = await newCustomer("Bea");
  const { id: documentId } = await asAdmin<{ id: string }>("agreement.create", {
    title: unique("Fixture waiver"),
    kind: "waiver",
  });
  const saved = await asAdmin<{ hash: string; rev: number }>("agreement.draft.save", {
    id: documentId,
    body: { blocks: [{ type: "paragraph", content: [{ type: "text", text: "Fixture text." }] }] },
    tickLabel: "I have read this fixture",
  });
  const { version } = await asAdmin<{ version: { id: string } }>("agreement.publish", {
    documentId,
    draftHash: saved.hash,
    draftRev: saved.rev,
    number: 1,
    change: "small",
  });
  versionId = version.id;
  const hash = await env.DB.prepare("SELECT hash FROM core_agreement_version WHERE id = ?")
    .bind(versionId)
    .first<{ hash: string }>();
  // Ada's acceptance, as `accept.ts` writes it (the route's subject is the download, not agreeing).
  acceptanceId = `aga_${unique("pdf")}`;
  await env.DB.prepare(
    "INSERT INTO core_agreement_acceptance (id, document_id, version_id, shown_hash, person_id, by, email, how, typed_name, channel, accepted_at) VALUES (?, ?, ?, ?, ?, 'self', ?, 'typed', 'Fixture Name', 'web', ?)",
  )
    .bind(
      acceptanceId,
      documentId,
      versionId,
      hash?.hash,
      ada.personId,
      ada.email,
      new Date().toISOString(),
    )
    .run();
}, 60_000);

async function expectPdf(response: Response): Promise<Uint8Array> {
  expect(response.status, response.status === 200 ? "" : await response.clone().text()).toBe(200);
  expect(response.headers.get("content-type")).toBe("application/pdf");
  expect(response.headers.get("content-disposition")).toMatch(
    /^attachment; filename="[A-Za-z0-9._-]+\.pdf"$/,
  );
  expect(response.headers.get("cache-control")).toBe("no-store, private");
  expect(response.headers.get("x-content-type-options")).toBe("nosniff");
  const bytes = new Uint8Array(await response.arrayBuffer());
  expect(new TextDecoder("latin1").decode(bytes.slice(0, 8))).toBe("%PDF-1.4");
  return bytes;
}

describe("a customer's own signed PDF", () => {
  it("over the client-app binding and the host's hostname: theirs, drawn from what me.agreements.pdf returns", async () => {
    const path = `/api/v1/agreements/acceptances/${acceptanceId}.pdf`;
    const overBinding = await expectPdf(
      await bound(path, { method: "GET", headers: { cookie: ada.cookie } }),
    );
    const onHostname = await expectPdf(await onHost(path, ada.cookie));
    expect([...overBinding]).toEqual([...onHostname]);
    // The same bytes as the writer draws from the operation's answer.
    const raw = await (
      await bound("/api/v1/op/me.agreements.pdf", {
        body: { acceptanceId },
        headers: { cookie: ada.cookie, "idempotency-key": crypto.randomUUID() },
      })
    ).json();
    const { document } = (raw as { data: { document: AgreementPdf } }).data;
    expect([...agreementPdf(document)]).toEqual([...overBinding]);
  });

  it("another customer and the public: not found; a version's blank form: never theirs", async () => {
    const path = `/api/v1/agreements/acceptances/${acceptanceId}.pdf`;
    for (const response of [
      await bound(path, { method: "GET", headers: { cookie: bea.cookie } }),
      await bound(path, { method: "GET" }),
      await onHost(path, bea.cookie),
      await onHost(path),
      await bound(`/api/v1/agreements/versions/${versionId}.pdf`, {
        method: "GET",
        headers: { cookie: ada.cookie },
      }),
      await onHost(`/api/v1/agreements/versions/${versionId}.pdf`, ada.cookie),
    ]) {
      expect(response.status).toBe(404);
      expect(response.headers.get("content-type")).toMatch(/^application\/json/);
    }
  });

  it("only GET, and only the two shapes of path", async () => {
    expect(
      (await onHost(`/api/v1/agreements/acceptances/${acceptanceId}.pdf`, ada.cookie, "POST"))
        .status,
    ).toBe(405);
    expect((await onHost("/api/v1/agreements/acceptances/../../x.pdf", ada.cookie)).status).toBe(
      404,
    );
    expect(
      (await onHost(`/api/v1/agreements/acceptances/${acceptanceId}`, ada.cookie)).status,
    ).toBe(404);
  });
});

describe("staff", () => {
  it("a person on the staff downloads any acceptance's PDF and a version's blank form", async () => {
    await expectPdf(await onHost(`/api/agreements/acceptances/${acceptanceId}.pdf`, admin.cookie));
    const blank = await expectPdf(
      await onHost(`/api/agreements/versions/${versionId}.pdf`, admin.cookie),
    );
    expect(new TextDecoder("latin1").decode(blank)).not.toContain(acceptanceId);
    // Every staff download of a signed PDF is audited.
    const row = await env.DB.prepare(
      "SELECT result FROM core_audit WHERE operation = 'agreement.acceptance.pdf' AND result LIKE ?",
    )
      .bind(`%${acceptanceId}%`)
      .first<{ result: string }>();
    expect(row?.result).toBeTruthy();
    expect(row?.result).not.toContain("Fixture Name");
  });
});
