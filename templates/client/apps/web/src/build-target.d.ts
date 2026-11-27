// What each build fixes at build time (`define` in vite.config.ts and vite.browser.config.ts).

/** True in the browser-only build (pnpm build:browser), false in the server build. */
declare const __COS_BROWSER_BUILD__: boolean;
/** The browser build's host address (COS_HOST_URL at build time); "" for the page's own origin. */
declare const __COS_HOST_URL__: string;
