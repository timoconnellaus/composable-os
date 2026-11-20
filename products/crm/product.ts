// The CRM: the first product on the platform (ADR 0400). Names only.
//
// Stage 20 moves the names here before it changes any of them, so they are still the ones the
// repository had under its old brand. They change in the commits that follow.
import { defineProduct } from "@relationship-os/product";

export const product = defineProduct({
  id: "relationship-os",
  label: "Relationship OS",
  names: {
    app: "ros-app",
    runner: "ros-runner",
    gatekeeperPrefix: "ros-gatekeeper-",
    database: "ros",
    resourcePrefix: "ros-",
  },
  extensions: ["deals", "leads", "lifecycle"],
  updateRepository: "timoconnellaus/relationship-os",
  billingUrl: "https://app.relationshiposcrm.com/billing",
  strings: {
    name: "Relationship OS",
  },
});
