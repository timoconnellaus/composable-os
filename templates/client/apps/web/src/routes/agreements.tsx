// Your agreements (stage 44): what the customer, and each child linked to them, has agreed to,
// with the signed PDF (src/host.ts forwards its download to the host), and what is still due.
// What it lists is the host's answer. For a styled page, copy the web-my-agreements block.
import {
  type AcceptanceSummary,
  agreedByWords,
  agreementPdfPath,
  agreementTime,
  type DuePerson,
} from "@composable-os/client";
import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { browserApi, signedOut } from "../agreements.ts";

export const Route = createFileRoute("/agreements")({ component: Agreements });

function Agreements() {
  const [data, setData] = useState<{ people: DuePerson[]; items: AcceptanceSummary[] } | null>(
    null,
  );
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    const api = browserApi();
    Promise.all([api.call("me.agreements.due", {}), api.call("me.agreements.list", {})])
      .then(([due, mine]) =>
        setData({
          people: due.people,
          items: mine.items,
        }),
      )
      .catch((error: unknown) => {
        if (signedOut(error)) window.location.assign("/sign-in");
        else setFailed(true);
      });
  }, []);
  if (failed) return <main role="alert">We could not load your agreements.</main>;
  if (!data) return <main aria-busy="true">Loading…</main>;
  const me = data.people.find((p) => p.self)?.personId ?? null;
  return (
    <main>
      <h1>Your agreements</h1>
      {data.people.map((person) => (
        <section key={person.personId}>
          <h2>{person.self ? "Yours" : person.name}</h2>
          {person.due.length ? (
            <p>
              {`To agree to: ${person.due.map((d) => d.title).join(", ")}. `}
              {person.canAgree ? <Link to="/before-you-go-on">Read and agree</Link> : null}
            </p>
          ) : null}
          <ul>
            {data.items
              .filter((a) => a.personId === person.personId)
              .map((a) => (
                <li key={a.id}>
                  {`${a.title}, version ${a.versionNumber}: ${agreedByWords(a, me)}, ${agreementTime(a.acceptedAt)}${a.counts ? "" : " (replaced)"}. `}
                  <a href={agreementPdfPath(a.id)} download>
                    Download PDF
                  </a>
                </li>
              ))}
          </ul>
        </section>
      ))}
      <p>
        <Link to="/account">Your account</Link>
      </p>
    </main>
  );
}
