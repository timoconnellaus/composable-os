// A public page: anyone can see it, signed in or not.
import { createFileRoute, Link } from "@tanstack/react-router";

export const Route = createFileRoute("/")({ component: Home });

function Home() {
  return (
    <main>
      <h1>Welcome</h1>
      <p>
        This page is public. <Link to="/sign-in">Sign in</Link> to see your account.
      </p>
    </main>
  );
}
