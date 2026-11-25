// Contact preferences (stage 30, ADR 0675), for the web: each kind of message the signed-in
// customer may get, on each channel it goes by, and the same for each child they act for. A tap
// turns one channel on or off (news and offers: yes or no, with the words shown). What may change
// is the host's answer (me.contact.choices, me.contact.setChoices): a booking's or a payment's
// email is always sent and shows as such; a child is never asked about news and offers.
import {
  type AccountHooks,
  accountErrorWords,
  type ContactLine,
  type ContactLineChannel,
  contactAllows,
  contactChannelWords,
  contactToggle,
  newsAndOffersWords,
} from "@composable-os/client";
import { useState } from "react";
import { Button } from "../ui-button/button.tsx";

type Hooks = Pick<AccountHooks, "useContactChoices" | "useSetContactChoices">;

export function ContactPreferences({ account }: { account: Hooks }) {
  const choices = account.useContactChoices();
  const set = account.useSetContactChoices();
  const [error, setError] = useState<string | null>(null);
  if (choices.isPending) return <p aria-busy="true">Loading your contact preferences…</p>;
  if (choices.error || !choices.data) {
    return <p role="alert">We could not load your contact preferences.</p>;
  }

  async function toggle(personId: string, line: ContactLine, channel: ContactLineChannel) {
    const change = contactToggle(personId, line, channel);
    if (!change) return;
    setError(null);
    try {
      await set.mutateAsync(change);
      choices.refetch?.();
    } catch (e) {
      setError(accountErrorWords(e));
    }
  }

  return (
    <div className="grid gap-6">
      {choices.data.people.map((person) => (
        <section
          key={person.personId}
          className="grid gap-3"
          aria-label={person.self ? "Your messages" : `Messages for ${person.name}`}
          data-person={person.self ? "self" : "child"}
        >
          {person.self ? null : <h3 className="font-semibold">{person.name}</h3>}
          <ul className="grid gap-3">
            {person.lines.map((line) => (
              <li
                key={line.scope}
                className="grid gap-2 rounded-md border p-3"
                data-scope={line.scope}
              >
                <div className="grid gap-1">
                  <strong>{line.label}</strong>
                  <span className="text-muted-foreground text-sm">{line.description}</span>
                </div>
                <div className="flex flex-wrap gap-2">
                  {line.channels.map((channel) => (
                    <Button
                      key={channel.channel}
                      type="button"
                      variant={contactAllows(channel.value) ? "default" : "outline"}
                      aria-pressed={contactAllows(channel.value)}
                      disabled={channel.fixed || set.isPending}
                      title={
                        line.scope === "news_and_offers" && !contactAllows(channel.value)
                          ? newsAndOffersWords(channel.channel)
                          : undefined
                      }
                      onClick={() => void toggle(person.personId, line, channel)}
                      data-channel={channel.channel}
                    >
                      {contactChannelWords(channel)}
                    </Button>
                  ))}
                </div>
                {line.essential ? (
                  <span className="text-muted-foreground text-sm">
                    Always emailed: it is about something booked or paid for.
                  </span>
                ) : null}
              </li>
            ))}
          </ul>
        </section>
      ))}
      {error ? <p role="alert">{error}</p> : null}
    </div>
  );
}
