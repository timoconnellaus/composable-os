// The product's name as people read it (issue #155): the deployment's label when `cos deploy` set
// one (COS_PRODUCT_LABEL), else the build's own.
//
// No request is made for it. The server knows it (the Worker reads the label once per isolate)
// and writes it into the page's <head>; the browser reads it back from there. So an anonymous
// visitor's page (sign-in, setup, a guest's order) never depends on a call they could be refused,
// and a page without the tag (or a server without the label) shows the build's name.
import { productName } from "@composable-os/product";
import { product } from "@composable-os/products/active";

/** The <meta name> the root document carries the product's name in. */
export const PRODUCT_NAME_META = "cos-product-name";

/** The product's name: from the page in the browser, from the deployment on the server. */
export function currentProductName(): string {
  if (typeof document !== "undefined") {
    const tag = document.querySelector<HTMLMetaElement>(`meta[name="${PRODUCT_NAME_META}"]`);
    if (tag?.content) return tag.content;
  }
  return productName(product);
}

/** For components: the same value, under the name screens use. */
export function useProductName(): string {
  return currentProductName();
}
