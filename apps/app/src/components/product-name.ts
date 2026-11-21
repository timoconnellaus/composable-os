// The product's name as people read it (issue #155): the deployment's label when \`cos deploy\` set
// one (COS_PRODUCT_LABEL, read once on the server), else the build's own. The root route loads it
// and every screen reads it from there, so no surface keeps the compiled name.
import { useRouteContext } from "@tanstack/react-router";

export function useProductName(): string {
  return useRouteContext({ from: "__root__" }).productName;
}
