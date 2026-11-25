// The `discount` behaviour (stage 34 step 4, ADR 0693): the contract accepts the Offers pack's
// shape (a discount with a kind, a value, live states a person enters, and codes kept as records)
// and refuses each wrong declaration: fields of the wrong type, kinds and audiences the host does
// not know, no way to apply, and a live state an AI, a customer or a create could reach.
import { describe, expect, it } from "vitest";
import { validateManifest } from "../src/index.ts";

const select = (...values: string[]) => ({
  type: "select",
  label: "Select",
  options: values.map((value) => ({ value, label: value })),
});

const tool = {
  description: "Fixture: a person moves a discount live (anyone else's call waits).",
  risk: "write",
  permission: "offers:manage",
  personApproves: true,
  inputSchema: { type: "object" },
  outputSchema: { type: "object" },
};

interface Over {
  discount?: Record<string, unknown>;
  fields?: Record<string, unknown>;
  moves?: object[];
  createIn?: object;
  states?: object | null;
  object?: Record<string, unknown>;
}

function offers(over: Over = {}) {
  return {
    id: "offers",
    version: "1.0.0",
    contractVersion: 1,
    roles: {
      manager: {
        label: "Offers manager",
        description: "Fixture: runs the offers.",
        permissions: ["offers:manage"],
        read: ["offers.discount", "offers.code"],
      },
    },
    tools: { activate: tool },
    objects: {
      discount: {
        label: "Discount",
        plural: "Discounts",
        titleField: "name",
        fields: {
          name: { type: "text", label: "Name", required: true },
          kind: select("percent", "amount", "price"),
          percent: { type: "number", label: "Percent" },
          amount: { type: "currency", label: "Amount", currency: "AUD" },
          automatic: { type: "boolean", label: "Automatic" },
          code: { type: "text", label: "Code" },
          who: select("anyone", "signed_in", "members", "new_customers"),
          plans: { type: "relation", label: "Plans", to: "offers.code", many: true },
          on: { type: "multiSelect", label: "On", options: [{ value: "x.y", label: "Y" }] },
          from: { type: "date", label: "From" },
          until: { type: "datetime", label: "Until" },
          totalUses: { type: "number", label: "Uses" },
          perPerson: { type: "number", label: "Per person" },
          minSpend: { type: "currency", label: "Minimum spend", currency: "AUD" },
          state: select("draft", "active", "paused", "ended"),
          ...(over.fields ?? {}),
        },
        ...(over.states === null
          ? {}
          : {
              states: over.states ?? {
                field: "state",
                initial: "draft",
                ...(over.createIn ? { create: { in: over.createIn } } : {}),
                moves: over.moves ?? [
                  { from: ["draft", "paused"], to: "active", by: ["host"], tools: ["activate"] },
                  { from: "active", to: "paused", by: ["staff"] },
                  { from: ["draft", "active", "paused"], to: "ended", by: ["staff"], final: true },
                ],
              },
            }),
        discount: {
          kind: "kind",
          percent: "percent",
          amount: "amount",
          live: ["active"],
          automatic: "automatic",
          code: "code",
          codes: { object: "code", discount: "discount", word: "word", uses: "uses" },
          who: "who",
          plans: "plans",
          objects: "on",
          from: "from",
          until: "until",
          totalUses: "totalUses",
          perPerson: "perPerson",
          minSpend: "minSpend",
          ...(over.discount ?? {}),
        },
        ...(over.object ?? {}),
      },
      code: {
        label: "Promo code",
        plural: "Promo codes",
        titleField: "word",
        fields: {
          word: { type: "text", label: "Code", required: true },
          discount: { type: "relation", label: "Discount", to: "offers.discount" },
          uses: { type: "number", label: "Uses" },
        },
      },
    },
  };
}

const problems = (over: Over = {}) =>
  validateManifest(offers(over)).issues.map((i) => `${i.path}: ${i.message}`);

describe("the discount behaviour", () => {
  it("accepts a discount applied by a code, codes kept as records, or by itself", () => {
    expect(problems()).toEqual([]);
  });

  it("refuses fields of the wrong type", () => {
    const out = problems({
      discount: { kind: "name", percent: "name", amount: "name", totalUses: "name", from: "name" },
    }).join("\n");
    expect(out).toContain('"name" must be a select field of discount');
    expect(out).toContain('"name" must be a number or percent field');
    expect(out).toContain('"name" must be a currency or number field');
    expect(out).toContain('"name" must be a number field');
    expect(out).toContain('"name" must be a date or datetime field');
  });

  it("refuses kinds and audiences the host does not know, and a kind with no value", () => {
    const out = problems({
      fields: { kind: select("percent", "bogof"), who: select("anyone", "friends") },
    }).join("\n");
    expect(out).toContain('"bogof" is not a kind of discount');
    expect(out).toContain('"friends" is not who a discount is for');
    expect(problems({ discount: { percent: undefined } }).join("\n")).toContain(
      "A percentage discount needs percent",
    );
  });

  it("refuses a discount with no way to apply", () => {
    expect(
      problems({ discount: { automatic: undefined, code: undefined, codes: undefined } }).join(
        "\n",
      ),
    ).toContain("Say how the discount applies");
  });

  it("refuses codes that are not another object's records naming this one", () => {
    expect(
      problems({ discount: { codes: { object: "discount", discount: "x", word: "y" } } }).join(
        "\n",
      ),
    ).toContain("must be another object of this extension");
    expect(
      problems({ discount: { codes: { object: "code", discount: "word", word: "uses" } } }).join(
        "\n",
      ),
    ).toMatch(/must be a relation field \(one record\)[\s\S]*must be a text field/);
  });

  it("refuses live states that are not states, or that anyone but a person's tool enters", () => {
    expect(problems({ discount: { live: ["live"] } }).join("\n")).toContain(
      '"live" is not a state of discount',
    );
    expect(problems({ discount: { live: ["draft"] } }).join("\n")).toContain(
      "is where a new discount starts",
    );
    expect(
      problems({
        moves: [{ from: "draft", to: "active", by: ["staff"] }],
      }).join("\n"),
    ).toContain('Entering "active" makes a discount apply');
    expect(problems({ createIn: { active: ["staff"] } }).join("\n")).toContain(
      'Creating a discount in "active" makes it apply',
    );
    expect(problems({ states: null }).join("\n")).toContain("discount must declare states");
  });

  it("refuses a discount that is also sold or counted", () => {
    expect(problems({ object: { sellable: { price: "amount" } } }).join("\n")).toContain(
      "A discount is not bought or counted: it has no sellable",
    );
  });
});
