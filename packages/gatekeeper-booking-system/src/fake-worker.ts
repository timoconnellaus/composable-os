// cos-gatekeeper-booking-system-fake: the fake booking system as a gatekeeper, for development and
// tests only (stage 65, ADR 0920). It is never part of a release: its config is
// wrangler.fake.jsonc, which no deployment reads, and only the CRM's dev server and cos-runner's
// tests bind it (`GATEKEEPER_BOOKING_SYSTEM_FAKE`). Each resource is one fake site,
// `booking-system-fake://site/<name>`, kept in its own Durable Object;
// `FakeBookingSystemControl` lets a test change it as the business would in its booking system,
// or as a failing network, a revoked key or a spent budget would.
//
// No capnweb-validate decorators (the dev server runs this Worker as an auxiliary worker): every
// session input is checked by validate.ts. As a Worker's main module it exports only entrypoints
// and classes.

import { DurableObject, RpcStub, RpcTarget, WorkerEntrypoint } from "cloudflare:workers";
import type {
  AccountDescription,
  Gatekeeper,
  GatekeeperConnectCallback,
  GatekeeperUser,
  GatekeeperUserVerifier,
  ResourceConfiguratorFrame,
  SupportedResource,
  VendorDescription,
} from "@composable-os/gatekeeper-interface/gatekeeper";
import { workerVersionTag } from "@composable-os/gatekeeper-interface/gatekeeper";
import {
  type FakeAccess,
  FakeBookingSystem,
  type FakeBookingSystemState,
  type FakeFailMethod,
  type FakeKind,
  type FakeOptions,
  fakeBookingSystemState,
} from "./fake.js";
import { refusalCode } from "./refusal.js";
import { BookingSystemGatekeeper, TYPES_CODE } from "./session.js";
import type { BookingSystem } from "./system.js";
import type {
  BookingSystemBooking,
  BookingSystemClass,
  BookingSystemClassesQuery,
  BookingSystemClassType,
  BookingSystemHint,
  BookingSystemMembership,
  BookingSystemMembershipType,
  BookingSystemPage,
  BookingSystemPeopleQuery,
  BookingSystemPerson,
  BookingSystemRefusalCode,
  BookingSystemSession,
  BookingSystemSite,
  BookingSystemStaff,
  BookingSystemVisitsQuery,
} from "./types.js";

type Env = Cloudflare.Env;
type SiteProps = { site: string };

const SITE_URL_PATTERN = "booking-system-fake://site/:name";
const SITE_URL = /^booking-system-fake:\/\/site\/([a-z0-9][a-z0-9-]{0,39})$/;
const TITLE = "Fake booking system (development)";

function siteUrl(name: string): string {
  return `booking-system-fake://site/${assertSiteName(name)}`;
}

function assertSiteName(name: unknown): string {
  if (typeof name !== "string" || !/^[a-z0-9][a-z0-9-]{0,39}$/.test(name)) {
    throw new TypeError("A fake site's name is 1 to 40 of a-z, 0-9 and -.");
  }
  return name;
}

function siteFromUrl(url: unknown): string {
  const match = typeof url === "string" ? SITE_URL.exec(url) : null;
  if (!match?.[1]) {
    throw new TypeError("Not a fake booking site: expected booking-system-fake://site/<name>.");
  }
  return match[1];
}

const ICON = {
  url:
    "data:image/svg+xml," +
    encodeURIComponent(
      "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='currentColor' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'>" +
        "<rect x='3' y='4' width='18' height='18' rx='2'/><path d='M16 2v4M8 2v4M3 10h18'/></svg>",
    ),
};

const SITE_RESOURCE: SupportedResource = {
  urlPattern: SITE_URL_PATTERN,
  title: "Fake booking site",
  description:
    "A site with invented people, memberships, classes, bookings and staff, for development and " +
    "tests. Read only; nothing leaves this machine.",
  icon: ICON,
  grantable: true,
};

const CONFIGURATOR_HTML = `<!doctype html>
<html lang="en">
  <head><meta charset="utf-8" /><title>Fake booking site</title></head>
  <body style="font-family: system-ui, sans-serif; margin: 0; padding: 1rem;">
    <p>Name the fake booking site to connect. Each name is its own site.</p>
  </body>
</html>`;

// =======================================================================================
// The site, one Durable Object per name.

/** The system and control methods the site answers, by name. */
const SITE_METHODS = [
  "describeSite",
  "listPeople",
  "listMembershipTypes",
  "listMemberships",
  "listClassTypes",
  "listClasses",
  "listBookings",
  "listStaff",
  "listVisits",
  "takeHints",
  "failNext",
  "setAccess",
  "setBudget",
  "spendBudget",
  "setHints",
  "setPageSize",
  "advance",
  "callCount",
  "change",
  "add",
  "shareAddress",
] as const;
type SiteMethod = (typeof SITE_METHODS)[number];

export class FakeBookingSite extends DurableObject<Env> {
  #load(): FakeBookingSystemState {
    return this.ctx.storage.kv.get<FakeBookingSystemState>("state") ?? fakeBookingSystemState();
  }

  /** Runs one method on the site, keeping what it changed (a call counted) even when it throws. */
  async run(method: SiteMethod, args: unknown[]): Promise<unknown> {
    if (!SITE_METHODS.includes(method)) throw new TypeError(`Not a site method: ${method}`);
    const site = new FakeBookingSystem(this.#load(), TITLE);
    const target = site as unknown as Record<SiteMethod, (...a: unknown[]) => unknown>;
    try {
      return await target[method](...args);
    } finally {
      this.ctx.storage.kv.put("state", site.state);
    }
  }

  /** Starts the site again, as a fresh fake. */
  async reset(options: FakeOptions = {}): Promise<void> {
    this.ctx.storage.kv.put("state", fakeBookingSystemState(options));
  }

  async state(): Promise<FakeBookingSystemState> {
    return this.#load();
  }
}

/** The system a facet talks to: the site's Durable Object, with its refusals as they were. */
class FakeBookingSiteClient implements BookingSystem {
  readonly title = TITLE;
  readonly #stub: DurableObjectStub<FakeBookingSite>;

  constructor(stub: DurableObjectStub<FakeBookingSite>) {
    this.#stub = stub;
  }

  async #run<T>(method: SiteMethod, ...args: unknown[]): Promise<T> {
    try {
      return (await this.#stub.run(method, args)) as T;
    } catch (error) {
      // RPC may put its own text in front: keep the refusal's tag at the start.
      const message = error instanceof Error ? error.message : String(error);
      if (refusalCode(message) !== null) {
        throw new Error(message.slice(message.indexOf("[booking-system:")));
      }
      throw error;
    }
  }

  describeSite(): Promise<BookingSystemSite> {
    return this.#run("describeSite");
  }
  listPeople(query: BookingSystemPeopleQuery): Promise<BookingSystemPage<BookingSystemPerson>> {
    return this.#run("listPeople", query);
  }
  listMembershipTypes(): Promise<BookingSystemMembershipType[]> {
    return this.#run("listMembershipTypes");
  }
  listMemberships(people: string[]): Promise<BookingSystemMembership[]> {
    return this.#run("listMemberships", people);
  }
  listClassTypes(): Promise<BookingSystemClassType[]> {
    return this.#run("listClassTypes");
  }
  listClasses(query: BookingSystemClassesQuery): Promise<BookingSystemPage<BookingSystemClass>> {
    return this.#run("listClasses", query);
  }
  listBookings(classes: string[]): Promise<BookingSystemBooking[]> {
    return this.#run("listBookings", classes);
  }
  listStaff(): Promise<BookingSystemStaff[]> {
    return this.#run("listStaff");
  }
  listVisits(query: BookingSystemVisitsQuery): Promise<BookingSystemPage<BookingSystemBooking>> {
    return this.#run("listVisits", query);
  }
  takeHints(max: number): Promise<BookingSystemHint[]> {
    return this.#run("takeHints", max);
  }
}

function siteStub(env: Env, name: string): DurableObjectStub<FakeBookingSite> {
  return env.FAKE_BOOKING_SITE.getByName(assertSiteName(name));
}

// =======================================================================================
// The facet of one fake site.

export class FakeBookingSystemGatekeeper extends BookingSystemGatekeeper<SiteProps> {
  protected system(): BookingSystem {
    return new FakeBookingSiteClient(siteStub(this.env, this.ctx.props.site));
  }

  protected resourceUrl(): string {
    return siteUrl(this.ctx.props.site);
  }
}

// =======================================================================================
// What a test does to the site, as the business (or a failing network) would.

export class FakeBookingSystemControl extends WorkerEntrypoint<Env> {
  async reset(site: string, options: FakeOptions = {}): Promise<void> {
    await siteStub(this.env, site).reset(options);
  }

  async failNext(site: string, method: FakeFailMethod, code: BookingSystemRefusalCode) {
    await siteStub(this.env, site).run("failNext", [method, code]);
  }

  async setAccess(site: string, access: FakeAccess): Promise<void> {
    await siteStub(this.env, site).run("setAccess", [access]);
  }

  async setBudget(site: string, budget: number | null): Promise<void> {
    await siteStub(this.env, site).run("setBudget", [budget]);
  }

  async spendBudget(site: string): Promise<void> {
    await siteStub(this.env, site).run("spendBudget", []);
  }

  async setHints(site: string, hints: "webhooks" | "none"): Promise<void> {
    await siteStub(this.env, site).run("setHints", [hints]);
  }

  async setPageSize(site: string, size: number): Promise<void> {
    await siteStub(this.env, site).run("setPageSize", [size]);
  }

  async advance(site: string, seconds: number): Promise<string> {
    return (await siteStub(this.env, site).run("advance", [seconds])) as string;
  }

  async callCount(site: string): Promise<{ used: number; byMethod: Record<string, number> }> {
    return (await siteStub(this.env, site).run("callCount", [])) as {
      used: number;
      byMethod: Record<string, number>;
    };
  }

  async change(site: string, kind: FakeKind, ref: string, patch: Record<string, unknown>) {
    return siteStub(this.env, site).run("change", [kind, ref, patch]);
  }

  async add(site: string, kind: FakeKind, item: Record<string, unknown>) {
    return siteStub(this.env, site).run("add", [kind, item]);
  }

  async shareAddress(site: string, from: string, to: string): Promise<void> {
    await siteStub(this.env, site).run("shareAddress", [from, to]);
  }

  async state(site: string): Promise<FakeBookingSystemState> {
    return siteStub(this.env, site).state();
  }
}

// =======================================================================================
// The configurator capability, account, verifier and vendor.

export class FakeBookingSiteConfiguratorUi extends RpcTarget {
  /** The resource URL of the site named `name`. */
  async resourceUrl(name: unknown): Promise<string> {
    return siteUrl(assertSiteName(name));
  }
}

export class FakeBookingSystemAccount extends WorkerEntrypoint<Env> implements GatekeeperUser {
  async describe(): Promise<AccountDescription> {
    return { displayName: TITLE, avatar: ICON };
  }

  async getSupportedResources(): Promise<SupportedResource[]> {
    return [SITE_RESOURCE];
  }

  async getGatekeeperClassFor(url: string): Promise<{
    class: DurableObjectClass<Gatekeeper<BookingSystemSession>>;
    resource: SupportedResource;
  }> {
    const props: SiteProps = { site: siteFromUrl(url) };
    return {
      class: this.ctx.exports.FakeBookingSystemGatekeeper({
        props,
      }) as unknown as DurableObjectClass<Gatekeeper<BookingSystemSession>>,
      resource: SITE_RESOURCE,
    };
  }

  async startResourceConfigurator(resourceUrlPattern: string): Promise<ResourceConfiguratorFrame> {
    if (resourceUrlPattern !== SITE_URL_PATTERN) {
      throw new Error(`Unsupported resource type: ${String(resourceUrlPattern).slice(0, 200)}`);
    }
    return { iframeHtml: CONFIGURATOR_HTML, ui: new RpcStub(new FakeBookingSiteConfiguratorUi()) };
  }

  /** Nothing to revoke: the fake holds no credentials. */
  async revoke(): Promise<void> {}

  reconnect(): Promise<{ url: string }> {
    throw new Error("The fake booking system has no connect flow.");
  }

  commitReconnect(_stageId: string): Promise<void> {
    throw new Error("The fake booking system has no connect flow.");
  }

  async getAuthenticatedEmail(): Promise<string | null> {
    return null;
  }

  async getVerifier(): Promise<Fetcher<GatekeeperUserVerifier>> {
    return this.ctx.exports.FakeBookingSystemVerifier(
      {},
    ) as unknown as Fetcher<GatekeeperUserVerifier>;
  }

  async ensureResources(_resourceUrlPatterns: string[]): Promise<{ url?: string }> {
    return {};
  }
}

/** The trivial verifier that goes with admitting every observer. */
export class FakeBookingSystemVerifier
  extends WorkerEntrypoint<Env>
  implements GatekeeperUserVerifier
{
  verify(): void {}
}

/** The vendor, and the Worker's default entrypoint. It serves no routes. */
export class GatekeeperVendor extends WorkerEntrypoint<Env> {
  override async fetch(): Promise<Response> {
    return new Response("Not found", { status: 404 });
  }

  async describe(): Promise<VendorDescription> {
    return {
      displayName: TITLE,
      url: "http://localhost/gatekeeper/booking-system-fake",
      logo: ICON,
      tagline: "A fake booking system for development",
      description:
        "A site with invented people, memberships, classes, bookings and staff, served through " +
        "the read-only booking-system contract, for development and tests only.",
      autoProvisionsAccount: true,
      providesAuth: false,
    };
  }

  async versionTag(): Promise<string | undefined> {
    return workerVersionTag(this.env);
  }

  async createAccount(): Promise<Fetcher<GatekeeperUser>> {
    return this.ctx.exports.FakeBookingSystemAccount({}) as unknown as Fetcher<GatekeeperUser>;
  }

  connectAccount(_callback: Fetcher<GatekeeperConnectCallback>): Promise<{ url: string }> {
    throw new Error("The fake booking system is auto-provisioned and has no connect flow.");
  }

  async getSupportedResources(_options?: { userId?: string }): Promise<SupportedResource[]> {
    return [SITE_RESOURCE];
  }

  async getTypeScriptTypes(): Promise<string> {
    return TYPES_CODE;
  }
}

export default GatekeeperVendor;
