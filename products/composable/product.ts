// The hosted product: what a host of many clients (a fleet, stage 66) is installed as. Neutral:
// it is not the CRM, and a client on it sees its own label where one is set, else this one. Names
// only, like every product definition (ADR 0400).
//
// Its id is not `cos`: packages name their Workers `cos-*`, and a deployment named the same could
// not be told apart from the repository's own names. `composable-*` is unlike every name the
// fleet's account already holds (`cos-docs`, `cos-site`, `crm-client-db-proof…`) and the staging
// check's throwaway `cosstg-<run id>-*`.
import { defineProduct } from "@composable-os/product";

/**
 * Packs the hosted product leaves out, with the reason. Every other pack in the repository is
 * offered: a client on the fleet takes these or a subset through its `COS_PACKS`. A new pack is
 * either listed in `packs` below or here (scripts/release/test/hosted-product.test.ts).
 */
export const HOSTED_PACKS_LEFT_OUT: Readonly<Record<string, string>> = Object.freeze({});

export const product = defineProduct({
  id: "composable",
  label: "Composable OS",
  names: {
    app: "composable-app",
    runner: "composable-runner",
    gatekeeperPrefix: "composable-gatekeeper-",
    database: "composable",
    resourcePrefix: "composable-",
  },
  // Every pack built. Which a client has is its own `COS_PACKS` setting; one with none set gets
  // these, the non-optional ones installed (Deals, Leads, Ticketing) and the rest offered.
  packs: [
    "bookings",
    "content",
    "courses",
    "dailychecks",
    "deals",
    "equipment",
    "forms",
    "knowledge",
    "leads",
    "lifecycle",
    "memberships",
    "offers",
    "programs",
    "rostering",
    "shop",
    "ticketing",
  ],
  updateRepository: "timoconnellaus/composable-os",
  // The platform's own site: no billing page for hosted plans exists yet (stage 66 step 10, usage).
  billingUrl: "https://composableos.dev/",
  strings: {
    name: "Composable OS",
  },
});
