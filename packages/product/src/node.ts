// Choosing the product a build is for (Node only: build scripts and bundler configuration).
//
// COS_PRODUCT names it: a product id (`crm`, read from products/<id>/product.ts) or a path to a
// product.ts. Unset means the default product, the one products/active.ts points at.
import { existsSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { defineProduct, type ProductDefinition } from "./index.ts";

/** The variable a build reads the product from. */
export const PRODUCT_ENV = "COS_PRODUCT";

/** The module bundlers replace with the chosen product's definition. */
export const ACTIVE_PRODUCT_MODULE = "@composable-os/products/active";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

/** The product.ts for an id or a path. Throws when there is none. */
export function productFile(idOrPath: string, root = REPO_ROOT): string {
  const isPath = idOrPath.includes("/") || idOrPath.endsWith(".ts");
  const file = isPath
    ? isAbsolute(idOrPath)
      ? idOrPath
      : resolve(process.cwd(), idOrPath)
    : join(root, "products", idOrPath, "product.ts");
  if (!existsSync(file)) {
    throw new Error(
      isPath
        ? `no product definition at ${file}`
        : `unknown product ${JSON.stringify(idOrPath)}: there is no products/${idOrPath}/product.ts`,
    );
  }
  return file;
}

/** Loads and checks the definition for an id or a path (Node 24 imports erasable TypeScript). */
export async function loadProduct(idOrPath: string, root = REPO_ROOT): Promise<ProductDefinition> {
  const file = productFile(idOrPath, root);
  const module = (await import(pathToFileURL(file).href)) as { product?: ProductDefinition };
  if (!module.product) throw new Error(`${file} does not export \`product\``);
  return defineProduct(module.product);
}

/**
 * The chosen product's file when COS_PRODUCT is set, else null (the default product). The file is
 * absolute, so it can be passed to a child process that runs in another directory.
 */
export function chosenProductFile(env: NodeJS.ProcessEnv = process.env): string | null {
  const value = env[PRODUCT_ENV]?.trim();
  return value ? productFile(value) : null;
}

/** Bundler aliases that swap the active product for the chosen one. Empty for the default. */
export function productAlias(env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const file = chosenProductFile(env);
  return file ? { [ACTIVE_PRODUCT_MODULE]: file } : {};
}
