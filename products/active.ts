// The product this build is for. Code that needs the product's name, its update repository or its
// billing URL at run time imports `product` from here.
//
// A build for another product replaces this module with that product's definition: set
// COS_PRODUCT to its id or to the path of its product.ts (packages/product/src/node.ts). Nothing
// else changes.
export { product } from "./crm/product.ts";
