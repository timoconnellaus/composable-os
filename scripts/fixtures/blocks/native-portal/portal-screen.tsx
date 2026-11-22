// A fixture: an app screen, not marked noPurchase, that opens the billing portal: still refused.
export function PortalScreen({ hooks }: { hooks: { useBillingPortal(): unknown } }) {
  return hooks.useBillingPortal();
}
