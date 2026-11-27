// Your agreements (stage 44): what the customer, and each child linked to them, has agreed to,
// with the signed PDF (the ScreenHost fetches the host's file: through src/host.ts in the server
// build), and what is still due. What it lists is the host's answer. For a styled page, copy the
// web-my-agreements block.
import {
  type AcceptanceSummary,
  agreedByWords,
  agreementTime,
  type DuePerson,
} from "@composable-os/client";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { signedOut } from "../agreements.ts";
import { useScreenHost } from "../screen-host/index.ts";

export const Route = createFileRoute("/agreements")({ component: Agreements });

function Agreements() {
  const host = useScreenHost();
  const navigate = useNavigate();
  const [data, setData] = useState<{ people: DuePerson[]; items: AcceptanceSummary[] } | null>(
    null,
  );
  const [failed, setFailed] = useState(false);
  const [unsaved, setUnsaved] = useState(false);
  useEffect(() => {
    const api = host.api;
    Promise.all([api.call("me.agreements.due", {}), api.call("me.agreements.list", {})])
      .then(([due, mine]) =>
        setData({
          people: due.people,
          items: mine.items,
        }),
      )
      .catch((error: unknown) => {
        if (signedOut(error)) void navigate({ to: "/sign-in" });
        else setFailed(true);
      });
  }, [host, navigate]);
  if (failed) return <main role="alert">We could not load your agreements.</main>;
  if (!data) return <main aria-busy="true">Loading…</main>;
  const me = data.people.find((p) => p.self)?.personId ?? null;
  return (
    <main>
      <h1>Your agreements</h1>
      {unsaved ? <p role="alert">We could not download that PDF. Try again in a moment.</p> : null}
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
                  <button
                    type="button"
                    onClick={() => {
                      setUnsaved(false);
                      host.downloadAgreementPdf(a.id).catch(() => setUnsaved(true));
                    }}
                  >
                    Download PDF
                  </button>
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
