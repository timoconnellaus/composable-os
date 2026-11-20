import { describe, expect, it } from "vitest";
import {
  defineProduct,
  deployedName,
  deployedNameList,
  LOCAL_PREFIX,
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
  extensions: [],
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
