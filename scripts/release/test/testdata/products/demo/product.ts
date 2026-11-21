// A fixture product (stage 20, acceptance criterion 4): building with it must yield `demo-app`,
// `demo-runner` and a UI that says "Demo", with no code change.
//
//   node scripts/release/build-release.ts --product scripts/release/test/testdata/products/demo/product.ts
import { defineProduct } from "@composable-os/product";

export const product = defineProduct({
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
  strings: {
    name: "Demo",
  },
});
