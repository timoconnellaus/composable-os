// The system browser at /native/staff-sign-in (ADR 0457), as a test plays it: open the link, read
// the confirm page, press Continue (a same-origin form POST), follow the answer back to the app.

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

/** The confirming POST a browser makes from the page, with the page's own origin. */
export function confirmRequest(
  pageUrl: string,
  form: URLSearchParams,
  headers: Record<string, string> = {},
): Request {
  const url = new URL(pageUrl);
  return new Request(`${url.origin}${url.pathname}`, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      origin: url.origin,
      ...headers,
    },
    body: form.toString(),
  });
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
  const answer = await serve(confirmRequest(url, confirmForm(await page.text()), { cookie }));
  return answer.status === 303 ? answer.headers.get("location") : null;
}
