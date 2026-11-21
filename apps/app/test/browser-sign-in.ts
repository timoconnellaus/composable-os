// The system browser at /native/staff-sign-in (ADR 0457), as a test plays it: open the link, read
// the confirm page, press Continue (the page's form POST), follow the answer back to the app.
//
// The POST carries the headers a browser would send for that page, not ones a test picks: the
// Origin a browser serialises under the page's own Referrer-Policy (`null` under `no-referrer`, as
// the Fetch standard has it; a beta shipped with exactly that refused), and `Sec-Fetch-Site:
// same-origin`. A change to the page's policy therefore changes what the tests send.

/** The confirm page's form fields, read from its HTML. */
export function confirmForm(html: string): URLSearchParams {
  const form = new URLSearchParams();
  for (const match of html.matchAll(/<input type="hidden" name="([^"]+)" value="([^"]*)">/g)) {
    const value = (match[2] as string)
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&amp;/g, "&");
    form.set(match[1] as string, value);
  }
  return form;
}

/**
 * The Origin a browser sends on a same-origin form POST from a page with this Referrer-Policy
 * (Fetch, "serializing a request origin"): `null` when the policy withholds the referrer.
 */
export function browserOrigin(pageUrl: string, referrerPolicy: string | null): string {
  const policy = (referrerPolicy ?? "strict-origin-when-cross-origin").split(",").pop()?.trim();
  return policy === "no-referrer" ? "null" : new URL(pageUrl).origin;
}

/**
 * The confirming POST as a browser makes it from a page served with `page`'s headers. `headers`
 * replaces what the browser would send, for a test that plays another site or an old browser
 * (`null` removes a header).
 */
export function confirmRequest(
  page: Pick<Response, "headers">,
  pageUrl: string,
  form: URLSearchParams,
  headers: Record<string, string | null> = {},
): Request {
  const url = new URL(pageUrl);
  const sent: Record<string, string | null> = {
    "content-type": "application/x-www-form-urlencoded",
    origin: browserOrigin(pageUrl, page.headers.get("referrer-policy")),
    "sec-fetch-site": "same-origin",
    "sec-fetch-mode": "navigate",
    ...headers,
  };
  const request = new Request(`${url.origin}${url.pathname}`, {
    method: "POST",
    headers: Object.fromEntries(
      Object.entries(sent).filter((e): e is [string, string] => e[1] !== null),
    ),
    body: form.toString(),
  });
  return request;
}

/**
 * Opens `url` signed in with `cookie`, presses Continue on the confirm page, and returns where the
 * host sent the browser (the app's address with the code), or null when it did not.
 */
export async function signInInBrowser(
  serve: (request: Request) => Promise<Response>,
  url: string,
  cookie: string,
): Promise<string | null> {
  const page = await serve(new Request(url, { headers: { cookie } }));
  if (page.status !== 200) return null;
  const form = confirmForm(await page.clone().text());
  const answer = await serve(confirmRequest(page, url, form, { cookie }));
  return answer.status === 303 ? answer.headers.get("location") : null;
}
