// The CRM: the first product on the platform (ADR 0400). Names only.
import { defineProduct } from "@composable-os/product";

export const product = defineProduct({
  id: "crm",
  label: "CRM",
  names: {
    app: "crm-app",
    runner: "crm-runner",
    gatekeeperPrefix: "crm-gatekeeper-",
    database: "crm",
    resourcePrefix: "crm-",
  },
  packs: ["deals", "leads", "lifecycle"],
  updateRepository: "timoconnellaus/composable-os",
  // Where the hosted CRM is served from is still open (ADR 0400): the value is unchanged.
  billingUrl: "https://app.relationshiposcrm.com/billing",
  strings: {
    name: "CRM",
  },
});
