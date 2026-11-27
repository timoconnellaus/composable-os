// What marks server code in built JavaScript (stage 75 step 2): the browser build must hold none
// of it. Each mark is what that code leaves behind after minifying (names of strings and
// properties a minifier keeps).
export const SERVER_MARKS: readonly { what: string; pattern: RegExp }[] = [
  // TanStack Start's server functions: their RPC path and headers, in the page's stub of one.
  { what: "a server function", pattern: /_serverFn|x-tsr-serverFn|createServerFn/ },
  // The web app's service binding to the host, and the Workers runtime it comes from.
  { what: "the HOST binding", pattern: /\bHOST\.fetch\b|\benv\.HOST\b|cloudflare:workers/ },
  // Reading or forwarding a cookie.
  {
    what: "cookie-reading code",
    pattern: /document\.cookie|getSetCookie|[`"']cookie[`"']|keepCustomerSignedIn|customerCookies/i,
  },
  // The server build's own sign-in routes, which set the customer's cookie.
  { what: "the server build's /auth routes", pattern: /[`"']\/auth\/(code|sign-in|sign-out)/ },
];

/** Which marks of server code `text` holds (none for a clean browser build). */
export function serverCodeIn(text: string): string[] {
  return SERVER_MARKS.filter((mark) => mark.pattern.test(text)).map((mark) => mark.what);
}
