// The staff sign-in page's posts to Better Auth's routes (/api/auth/*), and what each answer means.

/** Whether a sign-in step worked, was refused, or never reached the app (offline). */
export type AuthAnswer = "ok" | "refused" | "offline";

export async function authPost(path: string, body: unknown): Promise<AuthAnswer> {
  try {
    const response = await fetch(`/api/auth${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      credentials: "same-origin",
      body: JSON.stringify(body),
    });
    return response.ok ? "ok" : "refused";
  } catch {
    return "offline";
  }
}

/** What the page says when the app could not be reached, whichever step it was. */
export const OFFLINE_WORDS =
  "We could not reach the app just now. Check your connection and try again.";
