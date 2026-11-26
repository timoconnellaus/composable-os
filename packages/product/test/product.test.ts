import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  appBuild,
  type ClientProductDefinition,
  clientLocation,
  clientNameMaps,
  clientNames,
  clientWeb,
  contrastRatio,
  defineClientProduct,
  defineProduct,
  deployedName,
  deployedNameList,
  environmentNames,
  LOCAL_PREFIX,
  LOCATION_HINTS,
  mobileRole,
  type ProductDefinition,
} from "../src/index.ts";
import { loadProduct, productAlias, productFile } from "../src/node.ts";

const demo: ProductDefinition = {
  id: "demo",
  label: "Demo",
  names: {
    app: "demo-app",
    runner: "demo-runner",
    gatekeeperPrefix: "demo-gatekeeper-",
    database: "demo",
    resourcePrefix: "demo-",
  },
  packs: [],
  updateRepository: "example/demo",
  billingUrl: "https://demo.example/billing",
  strings: { name: "Demo" },
};

describe("deployed names", () => {
  it("come from the product, for every kind of name a package writes", () => {
    const local = (rest?: string) => (rest ? `${LOCAL_PREFIX}-${rest}` : LOCAL_PREFIX);
    expect(deployedName(demo, local("app"))).toBe("demo-app");
    expect(deployedName(demo, local("runner"))).toBe("demo-runner");
    expect(deployedName(demo, local("gatekeeper-email-send"))).toBe("demo-gatekeeper-email-send");
    expect(deployedName(demo, local())).toBe("demo");
    expect(deployedName(demo, local("blobs"))).toBe("demo-blobs");
    expect(deployedName(demo, local("automation-events-dlq"))).toBe("demo-automation-events-dlq");
    expect(deployedNameList(demo, `${local("app")}, ${local("runner")}`)).toBe(
      "demo-app,demo-runner",
    );
  });

  it("leave a name that is not the platform's alone", () => {
    expect(deployedName(demo, "someone-elses-queue")).toBe("someone-elses-queue");
    expect(deployedName(demo, `${LOCAL_PREFIX}x`)).toBe(`${LOCAL_PREFIX}x`);
  });
});

describe("a client product's name maps", () => {
  const manifest = {
    workers: [{ name: "demo-app" }, { name: "demo-runner" }, { name: "demo-gatekeeper-payments" }],
    resources: [
      { type: "d1", name: "demo" },
      { type: "queue", name: "demo-automation-events" },
      { type: "workflow", name: "demo-automation" },
      // As a release's manifest names a Durable Object class: `<worker>:<Class>`.
      { type: "durable_object", name: "demo-runner:Workspace" },
      { type: "durable_object", name: "demo-gatekeeper-payments:PaymentsEvents" },
    ],
  };
  const gym = defineClientProduct({
    id: "gym",
    label: "Gym",
    platform: { version: "1.0.0", release: "demo", repository: "example/demo" },
    packs: [],
    environments: { staging: { live: false, hostname: "admin-staging.gym.example" } },
  });

  it("rename every Worker and named resource, and list no Durable Object class", () => {
    const maps = clientNameMaps(demo, clientNames(gym, "staging"), manifest);
    expect(maps.workers).toEqual({
      "demo-app": "gym-staging-app",
      "demo-runner": "gym-staging-runner",
      "demo-gatekeeper-payments": "gym-staging-gatekeeper-payments",
    });
    expect(maps.resources).toEqual({
      demo: "gym-staging",
      "demo-automation-events": "gym-staging-automation-events",
      "demo-automation": "gym-staging-automation",
    });
  });

  it("give only names the installer accepts (--names, create-composable-os main.ts)", () => {
    // The first real client install stopped here (0.1.0-beta.14): a `<worker>:<Class>` entry in
    // the resources map is not a name, and the installer refused the whole argument.
    const maps = clientNameMaps(demo, clientNames(gym, "staging"), manifest);
    for (const name of [...Object.values(maps.workers), ...Object.values(maps.resources)]) {
      expect(name).toMatch(/^[a-z0-9-]+$/);
    }
  });

  it("hold for the manifest a real release is built with (the golden manifest)", () => {
    const golden = JSON.parse(
      readFileSync(
        join(import.meta.dirname, "../../../scripts/release/test/testdata/golden-manifest.json"),
        "utf8",
      ),
    ) as { workers: { name: string }[]; resources: { name: string; type: string }[] };
    const app = golden.workers.find((w) => w.name.endsWith("-app"))?.name ?? "";
    const prefix = app.slice(0, -"app".length);
    const release: ProductDefinition = {
      ...demo,
      names: {
        app,
        runner: `${prefix}runner`,
        gatekeeperPrefix: `${prefix}gatekeeper-`,
        database: prefix.slice(0, -1),
        resourcePrefix: prefix,
      },
    };
    expect(golden.resources.some((r) => r.type === "durable_object")).toBe(true);
    const maps = clientNameMaps(release, clientNames(gym, "staging"), golden);
    const names = [...Object.values(maps.workers), ...Object.values(maps.resources)];
    expect(names.length).toBeGreaterThan(5);
    for (const name of names) expect(name).toMatch(/^[a-z0-9-]+$/);
    for (const name of names) expect(name.startsWith("gym-staging")).toBe(true);
  });
});

describe("defineProduct", () => {
  it("returns a good definition unchanged", () => {
    expect(defineProduct(demo)).toBe(demo);
  });

  it("refuses names an account would refuse, and a prefix that would run names together", () => {
    expect(() => defineProduct({ ...demo, id: "Demo" })).toThrow(/id/);
    expect(() => defineProduct({ ...demo, names: { ...demo.names, app: "Demo App" } })).toThrow(
      /names\.app/,
    );
    expect(() =>
      defineProduct({ ...demo, names: { ...demo.names, resourcePrefix: "demo" } }),
    ).toThrow(/resourcePrefix/);
    expect(() =>
      defineProduct({ ...demo, names: { ...demo.names, runner: demo.names.app } }),
    ).toThrow(/the same/);
    expect(() => defineProduct({ ...demo, updateRepository: "demo" })).toThrow(/owner\/repo/);
    expect(() => defineProduct({ ...demo, billingUrl: "http://demo.example" })).toThrow(/https/);
  });
});

describe("choosing a product for a build", () => {
  it("reads a product by id from products/", async () => {
    const product = await loadProduct("crm");
    expect(product.names.app).toMatch(/-app$/);
    expect(productFile("crm")).toMatch(/products\/crm\/product\.ts$/);
  });

  it("says which products directory it looked in when the id is unknown", () => {
    expect(() => productFile("nope")).toThrow(/products\/nope\/product\.ts/);
  });

  it("aliases the active product module only when COS_PRODUCT is set", () => {
    expect(productAlias({})).toEqual({});
    const file = productFile("crm");
    expect(Object.values(productAlias({ COS_PRODUCT: "crm" }))).toEqual([file]);
    expect(Object.values(productAlias({ COS_PRODUCT: file }))).toEqual([file]);
  });
});

describe("a client product's environments (ADR 0450)", () => {
  const gym: ClientProductDefinition = {
    id: "gym",
    label: "Gym",
    platform: { version: "1.0.0", release: "crm", repository: "example/platform" },
    packs: ["ticketing"],
    web: { dir: ".", worker: "gym-site", deploy: "own" },
    environments: {
      staging: { hostname: "admin.staging.gym.example", web: { hostname: "staging.gym.example" } },
      live: { hostname: "admin.gym.example", web: { hostname: "gym.example" } },
    },
  };

  it("names each one from the id and its name; live keeps the undecorated names", () => {
    expect(defineClientProduct(gym)).toBe(gym);
    expect(environmentNames(gym)).toEqual(["live", "staging"]);
    expect(clientNames(gym, "staging")).toEqual({
      app: "gym-staging-app",
      runner: "gym-staging-runner",
      gatekeeperPrefix: "gym-staging-gatekeeper-",
      database: "gym-staging",
      resourcePrefix: "gym-staging-",
    });
    expect(clientNames(gym, "live")).toEqual(clientNames({ ...gym, environments: undefined }));
    expect(clientWeb(gym, "staging")).toEqual({
      worker: "gym-site-staging",
      hostname: "staging.gym.example",
    });
    expect(clientWeb(gym, "live")).toEqual({ worker: "gym-site", hostname: "gym.example" });
  });

  it("takes overrides, and refuses two environments that share a name", () => {
    const named = {
      ...gym,
      environments: {
        ...gym.environments,
        staging: { names: { app: "gym-preview-app" }, web: { worker: "gym-site-preview" } },
      },
    };
    expect(clientNames(named, "staging").app).toBe("gym-preview-app");
    expect(clientWeb(named, "staging")?.worker).toBe("gym-site-preview");
    expect(() =>
      defineClientProduct({
        ...gym,
        environments: { staging: { names: { database: "gym" } }, live: {} },
      }),
    ).toThrow(/both use the name gym/);
    expect(() => defineClientProduct({ ...gym, environments: {} })).toThrow(/is empty/);
    // The fake payment provider only where the product says real money is not used.
    const fake = { payments: { PAYMENTS_FAKE_PROVIDER: true } };
    expect(() =>
      defineClientProduct({
        ...gym,
        environments: { staging: { gatekeepers: fake }, live: {} },
      }),
    ).toThrow(/environment staging is live and turns on the fake payment provider/);
    expect(
      defineClientProduct({
        ...gym,
        environments: { staging: { live: false, gatekeepers: fake }, live: {} },
      }),
    ).toBeTruthy();
    expect(() =>
      defineClientProduct({ ...gym, environments: undefined, gatekeepers: fake }),
    ).toThrow(/the product is live/);
    // The fake text provider likewise (ADR 0672): a live host texts through a real account only.
    const fakeText = { text: { TEXT_PROVIDER: "fake", TEXT_SENDER_NUMBER: "+61400000999" } };
    expect(() =>
      defineClientProduct({
        ...gym,
        environments: { staging: { gatekeepers: fakeText }, live: {} },
      }),
    ).toThrow(/environment staging is live and turns on the fake text provider/);
    expect(
      defineClientProduct({
        ...gym,
        environments: { staging: { live: false, gatekeepers: fakeText }, live: {} },
      }),
    ).toBeTruthy();
    expect(() => defineClientProduct({ ...gym, environments: { live: { live: false } } })).toThrow(
      /cannot be marked live: false/,
    );
    expect(() => defineClientProduct({ ...gym, environments: { Staging: {} } })).toThrow(
      /environment Staging/,
    );
  });

  it("takes a location hint for a first install, per environment or none (ADR 0580)", () => {
    expect(clientLocation(gym, "live")).toBeUndefined();
    const oc = defineClientProduct({
      ...gym,
      location: "oc",
      environments: { staging: { location: "none" }, live: {} },
    });
    expect(clientLocation(oc, "live")).toBe("oc");
    expect(clientLocation(oc, "staging")).toBeUndefined();
    expect(clientLocation({ ...oc, environments: undefined })).toBe("oc");
    expect(Object.keys(LOCATION_HINTS)).toEqual(["wnam", "enam", "weur", "eeur", "apac", "oc"]);
    expect(() =>
      // @ts-expect-error: not a hint Cloudflare takes; a jurisdiction is not offered either
      defineClientProduct({ ...gym, location: "eu" }),
    ).toThrow(/location is a location hint/);
    expect(() =>
      defineClientProduct({
        ...gym,
        // @ts-expect-error: as above, in an environment
        environments: { staging: { location: "au" }, live: {} },
      }),
    ).toThrow(/environments\.staging\.location/);
  });
});

describe("the mobile app's pack roles (ADRs 0451 and 0600)", () => {
  const gym: ClientProductDefinition = {
    id: "gym",
    label: "Gym",
    platform: { version: "1.0.0", release: "crm", repository: "example/platform" },
    packs: ["programs", "bookings", "rostering"],
    mobile: { dir: "apps/mobile" },
  };
  const withRoles = (roles: NonNullable<ClientProductDefinition["mobile"]>["roles"]) => ({
    ...gym,
    mobile: { dir: "apps/mobile", roles },
  });

  it("takes a role by name, or with the grants its staff are given (stage 45 step 7)", () => {
    expect(mobileRole("rostering.team")).toEqual({ role: "rostering.team", grants: [] });
    expect(mobileRole({ role: "bookings.coach", grants: ["rostering:roster"] })).toEqual({
      role: "bookings.coach",
      grants: ["rostering:roster"],
    });
    const ok = withRoles([
      "rostering.team",
      { role: "bookings.coach", grants: ["rostering:roster"] },
    ]);
    expect(defineClientProduct(ok)).toBe(ok);
  });

  it("refuses a grant that is not <pack>:<name>, one of a pack it does not list, and a role twice", () => {
    expect(() =>
      defineClientProduct(withRoles([{ role: "bookings.coach", grants: ["roster"] }])),
    ).toThrow(/is not <pack>:<permission>/);
    expect(() =>
      defineClientProduct(withRoles([{ role: "bookings.coach", grants: ["ticketing:door"] }])),
    ).toThrow(/which packs does not list/);
    expect(() =>
      defineClientProduct(
        withRoles(["bookings.coach", { role: "bookings.coach", grants: ["rostering:roster"] }]),
      ),
    ).toThrow(/listed twice/);
  });
});

describe("the mobile app's identity in the stores (stage 63, ADR 0900)", () => {
  const app = {
    name: "Example Gym",
    version: "1.0.0",
    ids: { ios: "com.example.gym", android: "com.example.gym" },
    icon: "apps/mobile/assets/icon.png",
    splash: { image: "apps/mobile/assets/splash.png", background: "#101010" },
    colours: { primary: "#e11d48", background: "#ffffff", text: "#18181b" },
    listing: "apps/mobile/store",
    purchases: "none" as const,
  };
  const gym: ClientProductDefinition = {
    id: "gym",
    label: "Gym",
    platform: { version: "1.0.0", release: "crm", repository: "example/platform" },
    packs: [],
    web: { dir: "apps/web", worker: "gym-web" },
    mobile: { dir: "apps/mobile", app },
    environments: {
      staging: {
        live: false,
        hostname: "admin.staging.gym.example",
        web: { hostname: "staging.gym.example" },
        mobile: {
          scheme: "gym-staging",
          app: {
            name: "Gym (staging)",
            ids: { ios: "com.example.gym.staging", android: "com.example.gym.staging" },
          },
        },
      },
      live: { hostname: "admin.gym.example", web: { hostname: "gym.example" } },
    },
  };
  const change = (edit: (p: ClientProductDefinition) => void): ClientProductDefinition => {
    const copy = structuredClone(gym);
    edit(copy);
    return copy;
  };

  it("gives staging and live their own name, ids, scheme and host from product.ts (criterion 1)", () => {
    expect(defineClientProduct(gym)).toBe(gym);
    const staging = appBuild(gym, "staging");
    const live = appBuild(gym, "live");
    expect(staging).toMatchObject({
      environment: "staging",
      name: "Gym (staging)",
      slug: "gym-staging",
      scheme: "gym-staging",
      version: "1.0.0",
      hostUrl: "https://admin.staging.gym.example",
      websiteUrl: "https://staging.gym.example/account",
      store: { ids: { ios: "com.example.gym.staging" }, icon: app.icon, purchases: "none" },
    });
    expect(live).toMatchObject({
      environment: "live",
      name: "Example Gym",
      slug: "gym",
      scheme: "gym",
      hostUrl: "https://admin.gym.example",
      websiteUrl: "https://gym.example/account",
      store: { ids: app.ids, colours: app.colours },
    });
  });

  it("asks which environment when there are several, and has no host address without a hostname", () => {
    expect(() => appBuild(gym)).toThrow(/name the app's environment \(live, staging\)/);
    expect(() => appBuild(gym, "test")).toThrow(/it has no test/);
    const single = defineClientProduct({ ...gym, environments: undefined });
    expect(appBuild(single)).toMatchObject({ environment: "live", hostUrl: null, slug: "gym" });
    expect(() => appBuild(single, "staging")).toThrow(/declares no environments/);
    // Before mobile.app is given: the product's label and scheme, and no store identity.
    const plain = defineClientProduct({ ...single, mobile: { dir: "apps/mobile" } });
    expect(appBuild(plain)).toMatchObject({ name: "Gym", scheme: "gym", store: null });
  });

  it("refuses ids or schemes two environments share, bad ids, colours, names and purchases (criterion 2)", () => {
    const refused: [(p: ClientProductDefinition) => void, RegExp][] = [
      [
        (p) => delete p.environments?.staging?.mobile?.app?.ids,
        /have the same ios id com.example.gym/,
      ],
      [(p) => delete p.environments?.staging?.mobile?.scheme, /have the same scheme gym/],
      [(p) => ((p.mobile as { app: typeof app }).app.ids.ios = "gym"), /not reverse-domain/],
      [
        (p) => ((p.mobile as { app: typeof app }).app.ids.android = "com.example.my-gym"),
        /Android app's id "com.example.my-gym"/,
      ],
      [(p) => ((p.mobile as { app: typeof app }).app.colours.text = "#eeeeee"), /not readable/],
      [(p) => ((p.mobile as { app: typeof app }).app.colours.primary = "red"), /#rrggbb/],
      [(p) => ((p.mobile as { app: typeof app }).app.name = "A".repeat(31)), /1 to 30/],
      [(p) => ((p.mobile as { app: typeof app }).app.version = "1.0"), /x.y.z/],
      [
        (p) => (((p.mobile as { app: unknown }).app as { purchases: string }).purchases = "store"),
        /purchases must be "none"/,
      ],
      [
        (p) => delete (p.mobile as { app?: unknown }).app,
        /environments.staging.mobile.app changes mobile.app/,
      ],
    ];
    for (const [edit, message] of refused) {
      expect(() => defineClientProduct(change(edit))).toThrow(message);
    }
  });

  it("measures contrast as WCAG does", () => {
    expect(contrastRatio("#000000", "#ffffff")).toBeCloseTo(21, 5);
    expect(contrastRatio("#ffffff", "#ffffff")).toBe(1);
    expect(contrastRatio("#767676", "#ffffff")).toBeGreaterThan(4.5);
  });
});
