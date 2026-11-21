// A signed-in page: the customer's name, from me.get on the host.
import { createFileRoute, Link, redirect } from "@tanstack/react-router";
import { getMe } from "../me.ts";

export const Route = createFileRoute("/account")({
  loader: async () => {
    const me = await getMe();
    if (!me) throw redirect({ to: "/sign-in" });
    return me;
  },
  component: Account,
});

function Account() {
  const me = Route.useLoaderData();
  return (
    <main>
      <h1>Signed in as {me.displayName}</h1>
      {me.primaryEmail ? <p>{me.primaryEmail}</p> : null}
      <button
        type="button"
        onClick={async () => {
          await fetch("/auth/sign-out", { method: "POST", body: "{}" });
          window.location.assign("/");
        }}
      >
        Sign out
      </button>
      <p>
        <Link to="/">Home</Link>
      </p>
    </main>
  );
}
