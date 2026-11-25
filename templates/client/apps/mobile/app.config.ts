// The app's config for one build, from product.ts (stage 63, ADR 0900): its name, store ids, URL
// scheme, icon, splash, colours and the host it talks to. Nothing here is written by hand: change
// product.ts (`mobile.app`, and `environments.<name>.mobile` for a staging app beside the live one).
//
//   COS_ENV            the environment this build talks to (staging, live); required when
//                      product.ts declares environments
//   COS_APP_BUILD      the build number, the same on both platforms in one CI run
//                      (`cos app build-info`); 1 when unset
//   COS_HOST_URL       local development only: a host other than the environment's own
//                      (http://localhost:8787). A store build never sets it; `cos app check`
//                      refuses an environment with no hostname in product.ts.
import { appBuild } from "@composable-os/product";
import type { ConfigContext, ExpoConfig } from "expo/config";
import { product } from "../../product.ts";

/** A path from the root of the repo, as this folder sees it. */
function fromApp(path: string): string {
  const dir = product.mobile?.dir ?? "apps/mobile";
  if (path.startsWith(`${dir}/`)) return `./${path.slice(dir.length + 1)}`;
  return `${"../".repeat(dir.split("/").length)}${path}`;
}

export default ({ config }: ConfigContext): ExpoConfig => {
  const build = appBuild(product, process.env.COS_ENV || undefined);
  const number = Number(process.env.COS_APP_BUILD || "1");
  if (!Number.isInteger(number) || number < 1) {
    throw new Error(`COS_APP_BUILD is a whole number from 1, not ${process.env.COS_APP_BUILD}`);
  }
  const store = build.store;
  return {
    ...config,
    name: build.name,
    slug: build.slug,
    scheme: build.scheme,
    version: build.version,
    orientation: "portrait",
    ...(store
      ? {
          icon: fromApp(store.icon),
          primaryColor: store.colours.primary,
          backgroundColor: store.colours.background,
          splash: {
            image: fromApp(store.splash.image),
            backgroundColor: store.splash.background,
            resizeMode: "contain",
          },
          ios: {
            bundleIdentifier: store.ids.ios,
            buildNumber: String(number),
            supportsTablet: false,
            // The app uses only the platform's own encryption (HTTPS): no export paperwork.
            config: { usesNonExemptEncryption: false },
          },
          android: {
            package: store.ids.android,
            versionCode: number,
            adaptiveIcon: {
              foregroundImage: fromApp(store.icon),
              backgroundColor: store.colours.background,
            },
          },
        }
      : {}),
    extra: {
      ...config.extra,
      environment: build.environment,
      build: number,
      hostUrl: process.env.COS_HOST_URL || build.hostUrl || "",
      websiteUrl: build.websiteUrl ?? "",
    },
  };
};
