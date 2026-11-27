// A client's sender domains (registry migration 0796; ADR 0616, "Email sending per client"): one
// client a domain, no domain under or over another client's, only verified ones read, and only
// into that client's environment as COS_SENDER_DOMAINS.
import { env } from "cloudflare:workers";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { envNameUse } from "../src/client-environment.ts";
import { buildClientEnvironment } from "../src/client-environment-build.ts";
import { type ClientRecord, readRegistry } from "../src/registry.ts";
import {
  addSenderDomain,
  listSenderDomains,
  removeSenderDomain,
  senderDomainProblem,
  unverifySenderDomain,
  verifySenderDomain,
} from "../src/registry-senders.ts";
import { emptyRegistry, insertClient, migrateRegistry } from "./registry-fixtures.ts";

const registry = (env as unknown as { REGISTRY: D1Database }).REGISTRY;

beforeAll(async () => {
  await migrateRegistry();
});

beforeEach(async () => {
  await emptyRegistry();
  await registry.batch([
    insertClient(registry, { id: "gym-a" }),
    insertClient(registry, { id: "gym-b" }),
  ]);
});

const insertDomain = (domain: string, client: string, verified = 0) =>
  registry
    .prepare(
      "INSERT INTO registry_sender_domains (domain, client, verified, verified_at) VALUES (?, ?, ?, ?)",
    )
    .bind(domain, client, verified, verified ? "2026-11-27T00:00:00Z" : null)
    .run();

describe("the registry's sender domains", () => {
  it("hold a domain for one client only, and no domain under or over another client's", async () => {
    await insertDomain("gym-a.example", "gym-a");
    // The same domain for another client: the primary key.
    await expect(insertDomain("gym-a.example", "gym-b")).rejects.toThrow();
    // Under it, or over it, for another client: the triggers.
    await expect(insertDomain("mail.gym-a.example", "gym-b")).rejects.toThrow(/under or over/);
    await insertDomain("news.gym-b.example", "gym-b");
    await expect(insertDomain("gym-b.example", "gym-a")).rejects.toThrow(/under or over/);
    // Moving a row's client into another's tree is refused as well.
    await insertDomain("other.example", "gym-b");
    await expect(
      registry
        .prepare(
          "UPDATE registry_sender_domains SET domain = 'x.gym-a.example' WHERE domain = 'other.example'",
        )
        .run(),
    ).rejects.toThrow(/under or over/);
    // The same client may hold a domain and one under it.
    await insertDomain("mail.gym-a.example", "gym-a");
  });

  it("refuse a domain that is not canonical, and a verified row with no time", async () => {
    for (const bad of ["Gym-A.example", "example", "gym-a.example.", "-a.example", "a..example"]) {
      await expect(insertDomain(bad, "gym-a"), bad).rejects.toThrow();
      expect(senderDomainProblem(bad), bad).not.toBeNull();
    }
    await expect(
      registry
        .prepare(
          "INSERT INTO registry_sender_domains (domain, client, verified) VALUES ('gym-a.example', 'gym-a', 1)",
        )
        .run(),
    ).rejects.toThrow();
  });

  it("leave a removed client's domains with it", async () => {
    await insertDomain("gym-a.example", "gym-a", 1);
    await registry.prepare("DELETE FROM registry_clients WHERE id = 'gym-a'").run();
    expect(await listSenderDomains(registry)).toEqual([]);
  });

  it("move the version stamp on every write", async () => {
    const stamps = [(await readRegistry(registry)).stamp];
    await addSenderDomain(registry, "gym-a", "gym-a.example");
    stamps.push((await readRegistry(registry)).stamp);
    await verifySenderDomain(registry, "gym-a", "gym-a.example");
    stamps.push((await readRegistry(registry)).stamp);
    await removeSenderDomain(registry, "gym-a", "gym-a.example");
    stamps.push((await readRegistry(registry)).stamp);
    expect(new Set(stamps).size).toBe(stamps.length);
  });
});

describe("the operator's writes", () => {
  it("add unverified, verify, unverify and remove, each only the client's own", async () => {
    await addSenderDomain(registry, "gym-a", "gym-a.example");
    await addSenderDomain(registry, "gym-a", "gym-a.example");
    expect(await listSenderDomains(registry, "gym-a")).toEqual([
      { domain: "gym-a.example", client: "gym-a", verified: false, verifiedAt: null },
    ]);
    await expect(verifySenderDomain(registry, "gym-b", "gym-a.example")).rejects.toThrow(
      /not a sender domain of gym-b/,
    );
    await verifySenderDomain(registry, "gym-a", "gym-a.example", "2026-11-27T01:02:03Z");
    expect((await listSenderDomains(registry, "gym-a"))[0]).toMatchObject({
      verified: true,
      verifiedAt: "2026-11-27T01:02:03Z",
    });
    await unverifySenderDomain(registry, "gym-a", "gym-a.example");
    expect((await listSenderDomains(registry, "gym-a"))[0]?.verified).toBe(false);
    // Removing it for another client does nothing.
    await removeSenderDomain(registry, "gym-b", "gym-a.example");
    expect(await listSenderDomains(registry)).toHaveLength(1);
    await removeSenderDomain(registry, "gym-a", "gym-a.example");
    expect(await listSenderDomains(registry)).toEqual([]);
  });

  it("refuse another client's domain, or one of its tree, before writing", async () => {
    await addSenderDomain(registry, "gym-a", "gym-a.example");
    await expect(addSenderDomain(registry, "gym-b", "gym-a.example")).rejects.toThrow(
      /another client's sender domain \(gym-a\)/,
    );
    await expect(addSenderDomain(registry, "gym-b", "mail.gym-a.example")).rejects.toThrow(
      /under or over gym-a.example/,
    );
    await expect(addSenderDomain(registry, "gym-b", "Gym-B.example")).rejects.toThrow(
      /Not a sender domain/,
    );
    await expect(addSenderDomain(registry, "Nobody", "gym-b.example")).rejects.toThrow(
      /Not a client id/,
    );
    // A client the registry does not hold: its foreign key.
    await expect(addSenderDomain(registry, "gym-nobody", "gym-b.example")).rejects.toThrow(
      /FOREIGN KEY/,
    );
    expect(await listSenderDomains(registry, "gym-b")).toEqual([]);
  });
});

describe("the read of the registry", () => {
  it("gives each client its verified domains only, sorted", async () => {
    await insertDomain("gym-a.example", "gym-a", 1);
    await insertDomain("b.gym-a.example", "gym-a", 1);
    await insertDomain("pending.gym-a.example", "gym-a", 0);
    await insertDomain("gym-b.example", "gym-b", 1);
    const snapshot = await readRegistry(registry);
    expect(snapshot.senderDomains.get("gym-a" as never)).toEqual([
      "b.gym-a.example",
      "gym-a.example",
    ]);
    expect(snapshot.senderDomains.get("gym-b" as never)).toEqual(["gym-b.example"]);
    expect(snapshot.problems).toEqual([]);
  });

  it("leaves out, for both clients, a domain of a tree two clients hold (a registry without the triggers)", async () => {
    await insertDomain("gym-a.example", "gym-a", 1);
    await insertDomain("gym-b.example", "gym-b", 1);
    await registry.prepare("DROP TRIGGER registry_sender_domains_one_tree_insert").run();
    try {
      await insertDomain("mail.gym-a.example", "gym-b", 1);
      const snapshot = await readRegistry(registry);
      expect(snapshot.senderDomains.get("gym-a" as never)).toBeUndefined();
      expect(snapshot.senderDomains.get("gym-b" as never)).toEqual(["gym-b.example"]);
      expect(snapshot.problems.join("\n")).toMatch(/mail.gym-a.example of gym-b left out/);
      expect(snapshot.problems.join("\n")).toMatch(/gym-a.example of gym-a left out/);
    } finally {
      await registry.prepare("DELETE FROM registry_sender_domains").run();
      // The migration's trigger, put back as it made it.
      await registry
        .prepare(
          `CREATE TRIGGER registry_sender_domains_one_tree_insert
BEFORE INSERT ON registry_sender_domains
WHEN EXISTS (
  SELECT 1 FROM registry_sender_domains
  WHERE client <> NEW.client
    AND (NEW.domain LIKE '%.' || domain OR domain LIKE '%.' || NEW.domain)
)
BEGIN
  SELECT RAISE(ABORT, 'a sender domain under or over another client''s is refused');
END`,
        )
        .run();
    }
  });
});

describe("a client's environment", () => {
  const record = (id: string): ClientRecord =>
    ({
      id,
      environment: "live",
      status: "active",
      tier: "standard",
      repository: null,
      locationHint: null,
      schemaVersion: null,
      secretGeneration: "a1".repeat(16),
      imported: false,
    }) as ClientRecord;
  const host = () =>
    ({
      DB: (env as unknown as { DB: D1Database }).DB,
      REGISTRY: registry,
      CLIENT_DB_QUERIES: (env as unknown as { CLIENT_DB_QUERIES: unknown }).CLIENT_DB_QUERIES,
      COS_PROPS_KEY: (env as unknown as { TEST_PROPS_KEY: string }).TEST_PROPS_KEY,
      COS_HOST_ENVIRONMENT: "live",
      COS_BINDING_KEY: "registry-senders-test-binding-key-0123456789",
      // The deployment's own list and a value of the name on the host are never a client's.
      ALLOWED_SENDER_DOMAINS: "everyone.example",
      COS_SENDER_DOMAINS: "host.example",
    }) as never;

  it("holds the client's verified domains as COS_SENDER_DOMAINS, and none when it has none", () => {
    expect(envNameUse("COS_SENDER_DOMAINS")).toMatchObject({ use: "per-client", what: "senders" });
    const a = buildClientEnvironment(host(), {
      client: record("gym-a"),
      settings: {},
      senderDomains: ["b.gym-a.example", "gym-a.example"],
    }) as unknown as Record<string, unknown>;
    expect(a.COS_SENDER_DOMAINS).toBe("b.gym-a.example,gym-a.example");
    expect("ALLOWED_SENDER_DOMAINS" in a).toBe(false);
    const none = buildClientEnvironment(host(), {
      client: record("gym-b"),
      settings: {},
      senderDomains: [],
    }) as unknown as Record<string, unknown>;
    expect("COS_SENDER_DOMAINS" in none).toBe(false);
  });

  it("offers the email-send gatekeeper to every client, which takes the domains from the host", () => {
    expect(envNameUse("GATEKEEPER_EMAIL_SEND")).toMatchObject({ use: "shared" });
    for (const name of ["GATEKEEPER_PAYMENTS", "GATEKEEPER_TEXT", "GATEKEEPER_WEBHOOK"]) {
      expect(envNameUse(name), name).toMatchObject({ use: "kept-apart" });
    }
    // Email receiving stays left out (one mailbox per local part for the deployment).
    expect(envNameUse("GATEKEEPER_EMAIL")).toMatchObject({ use: "kept-apart" });
  });
});

describe("a sender domain handed to another client (issue #529, F1; registry migration 0797)", () => {
  it("starts unverified: an update, an upsert and an insert-or-replace cannot carry the verification over", async () => {
    await insertDomain("gym-a.example", "gym-a", 1);
    await expect(
      registry
        .prepare(
          "UPDATE registry_sender_domains SET client = 'gym-b' WHERE domain = 'gym-a.example'",
        )
        .run(),
    ).rejects.toThrow(/starts unverified/);
    await expect(
      registry
        .prepare(
          "INSERT INTO registry_sender_domains (domain, client, verified) VALUES ('gym-a.example', 'gym-b', 1) ON CONFLICT (domain) DO UPDATE SET client = excluded.client, verified = excluded.verified",
        )
        .run(),
    ).rejects.toThrow(/starts unverified/);
    await expect(
      registry
        .prepare(
          "INSERT OR REPLACE INTO registry_sender_domains (domain, client, verified) VALUES ('gym-a.example', 'gym-b', 1)",
        )
        .run(),
    ).rejects.toThrow(/starts unverified/);
    expect(await listSenderDomains(registry)).toMatchObject([
      { domain: "gym-a.example", client: "gym-a", verified: true },
    ]);
    // Handed over unverified, it is allowed: the new client's operator verifies it again.
    await registry
      .prepare(
        "UPDATE registry_sender_domains SET client = 'gym-b', verified = 0, verified_at = NULL WHERE domain = 'gym-a.example'",
      )
      .run();
    expect((await listSenderDomains(registry, "gym-b"))[0]?.verified).toBe(false);
  });
});

describe("what no client may send as (issue #529, F2)", () => {
  it("refuses a shared suffix, a shared mail domain or one under it, and the fleet's own domain", async () => {
    for (const domain of ["co.uk", "com.au", "github.io", "gmail.com", "mail.outlook.com"]) {
      await expect(addSenderDomain(registry, "gym-a", domain), domain).rejects.toThrow(
        /Not a sender domain/,
      );
    }
    const fleet = { fleetDomain: "fleet.example" };
    for (const domain of ["fleet.example", "mail.fleet.example"]) {
      await expect(addSenderDomain(registry, "gym-a", domain, fleet), domain).rejects.toThrow(
        /fleet's own domain/,
      );
    }
    expect(await listSenderDomains(registry)).toEqual([]);
    await addSenderDomain(registry, "gym-a", "gym-a.co.uk", fleet);
    expect((await listSenderDomains(registry, "gym-a")).map((d) => d.domain)).toEqual([
      "gym-a.co.uk",
    ]);
  });
});
