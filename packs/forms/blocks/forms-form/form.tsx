// A form to fill in, for the business's own website (stage 29 step 4): any published form, with
// every question kind the question schema has, then its thank-you. `FormBlock` opens a form by its
// address (or a personal link's token); `LinkedFormBlock` opens a signed-in member's own personal
// link from Needs your attention (`me.attention`, kind form_to_fill, by the link's id).
//
// It holds no rules. Whether the form takes answers from this visitor, who may answer, once only,
// the spam checks and the caps are the host's; required questions, lengths and links are checked
// before sending with the host's own check (the headless entry), and the host's answer is the one
// shown: a refusal stays on the screen with the answers as typed. The spam checks travel with the
// send: the honeypot is a field a person never sees, the time the form was shown is the host's
// token from opening it, and a visitor's Turnstile token comes from the widget the app passes as
// `Turnstile` (the block loads no script of its own). A personal link skips Turnstile at the host,
// so no widget is drawn for one. What a person types stays in this component's state and nowhere
// else. A page showing `FormBlock` for a personal link's token keeps the link page's three rules
// itself (ADR 0728): `Referrer-Policy: no-referrer`, no third-party script (one could read the
// address before the token is out), and the token taken out at once with `takeLinkToken`.
import {
  type DraftValue,
  type Filler,
  type FormsHooks,
  HONEYPOT_FIELD,
  isAsked,
  type OpenedForm,
  type QuestionItem,
  ratingLabel,
  ratingValues,
  refusalOf,
} from "@composable-os/pack-forms/client";
import {
  type ComponentType,
  type FormEvent,
  type ReactNode,
  useEffect,
  useRef,
  useState,
} from "react";
import { Button } from "../ui-button/button.tsx";
import { Input } from "../ui-input/input.tsx";
import { Label } from "../ui-label/label.tsx";

/**
 * The app's Turnstile widget (for example `@marsidev/react-turnstile` with the site key of the
 * app's hostname): it calls `onToken` with a token once Cloudflare has decided, and null when the
 * token expires.
 */
export type TurnstileWidget = ComponentType<{ onToken: (token: string | null) => void }>;

const fieldClass =
  "w-full rounded-md border border-input bg-transparent px-3 py-2 text-base shadow-xs outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 aria-invalid:border-destructive md:text-sm dark:bg-input/30";

/** Rich text's inline runs, drawn as text: bold, italic, code and links. */
function Inlines({ content }: { content: unknown[] }) {
  return (
    <>
      {content.map((run, i) => {
        const r = run as {
          type?: string;
          text?: string;
          bold?: boolean;
          italic?: boolean;
          code?: boolean;
          href?: string;
        };
        // biome-ignore lint/suspicious/noArrayIndexKey: runs have no ids; the list never reorders.
        if (r.type === "break") return <br key={i} />;
        if (r.type !== "text" || !r.text) return null;
        let node: ReactNode = r.text;
        if (r.code) node = <code>{node}</code>;
        if (r.italic) node = <em>{node}</em>;
        if (r.bold) node = <strong>{node}</strong>;
        if (r.href && /^(?:https?:|mailto:)/i.test(r.href)) {
          node = (
            <a href={r.href} rel="noopener noreferrer nofollow" className="underline">
              {node}
            </a>
          );
        }
        // biome-ignore lint/suspicious/noArrayIndexKey: as above.
        return <span key={i}>{node}</span>;
      })}
    </>
  );
}

const fieldId = (key: string) => `form-${key}`;
const helpId = (key: string) => `form-${key}-help`;
const errorId = (key: string) => `form-${key}-error`;

/** The help and the error under a question, tied to its field by `aria-describedby`. */
function describedBy(item: { key: string; help?: string }, error: string | undefined) {
  const ids = [item.help ? helpId(item.key) : null, error ? errorId(item.key) : null].filter(
    Boolean,
  );
  return ids.length ? ids.join(" ") : undefined;
}

function Notes({ item, error }: { item: { key: string; help?: string }; error?: string }) {
  return (
    <>
      {item.help ? (
        <p id={helpId(item.key)} className="text-sm text-muted-foreground">
          {item.help}
        </p>
      ) : null}
      {error ? (
        <p id={errorId(item.key)} className="text-sm font-medium text-destructive">
          {error}
        </p>
      ) : null}
    </>
  );
}

function Required({ on }: { on: boolean | undefined }) {
  return on ? <span className="font-normal text-muted-foreground"> (required)</span> : null;
}

/** One question (or a heading or paragraph), drawn by its kind. */
export function Question({
  item,
  value,
  error,
  onChange,
}: {
  item: QuestionItem;
  value: DraftValue | undefined;
  error?: string;
  onChange: (value: DraftValue) => void;
}) {
  if (item.kind === "heading") return <h2 className="text-lg font-semibold">{item.text}</h2>;
  if (item.kind === "paragraph") {
    return (
      <p className="text-sm">
        <Inlines content={item.content} />
      </p>
    );
  }
  const id = fieldId(item.key);
  const invalid = error ? true : undefined;
  const describes = describedBy(item, error);
  if (item.kind === "consent") {
    return (
      <div className="grid gap-1">
        <div className="flex items-start gap-2">
          <input
            type="checkbox"
            id={id}
            className="mt-1 size-4"
            checked={value === true}
            aria-invalid={invalid}
            aria-describedby={describes}
            aria-required={item.required || undefined}
            onChange={(e) => onChange(e.target.checked)}
          />
          <label htmlFor={id} className="whitespace-pre-line text-sm">
            {item.words}
            <Required on={item.required} />
          </label>
        </div>
        <Notes item={item} error={error} />
      </div>
    );
  }
  if (item.kind === "choice" || item.kind === "rating" || item.kind === "yesNo") {
    const options =
      item.kind === "choice"
        ? item.options.map((o) => ({ value: o as string | number | boolean, label: o }))
        : item.kind === "rating"
          ? ratingValues(item).map((n) => ({ value: n, label: ratingLabel(item, n) }))
          : [
              { value: true, label: "Yes" },
              { value: false, label: "No" },
            ];
    const several = item.kind === "choice" && item.multiple;
    const chosen = (v: string | number | boolean) =>
      several ? Array.isArray(value) && value.includes(v as string) : value === v;
    const pick = (v: string | number | boolean, on: boolean) => {
      if (!several) return onChange(v);
      const now = Array.isArray(value) ? value : [];
      onChange(on ? [...now, v as string] : now.filter((x) => x !== v));
    };
    return (
      <fieldset className="grid gap-2" aria-describedby={describes}>
        <legend className="mb-1 text-sm font-medium">
          {item.label}
          <Required on={item.required} />
        </legend>
        <Notes item={item} error={error} />
        <div className={item.kind === "choice" ? "grid gap-1" : "flex flex-wrap gap-2"}>
          {options.map((option, i) => (
            <label
              key={String(option.value)}
              htmlFor={`${id}-${i}`}
              className={
                item.kind === "choice"
                  ? "flex min-h-11 items-center gap-2 text-sm"
                  : "flex min-h-11 items-center gap-2 rounded-md border border-input px-3 text-sm has-[:checked]:border-primary has-[:checked]:bg-accent"
              }
            >
              <input
                type={several ? "checkbox" : "radio"}
                id={`${id}-${i}`}
                name={id}
                className="size-4"
                checked={chosen(option.value)}
                aria-invalid={invalid}
                onChange={(e) => pick(option.value, e.target.checked)}
              />
              {option.label}
            </label>
          ))}
        </div>
      </fieldset>
    );
  }
  const text = typeof value === "string" ? value : "";
  const common = {
    id,
    value: text,
    "aria-invalid": invalid,
    "aria-describedby": describes,
    "aria-required": item.required || undefined,
  };
  const auto =
    item.map?.to === "person"
      ? ({ name: "name", email: "email", phone: "tel" } as const)[item.map.field]
      : undefined;
  return (
    <div className="grid gap-2">
      <Label htmlFor={id}>
        <span>
          {item.label}
          <Required on={item.required} />
        </span>
      </Label>
      <Notes item={item} error={error} />
      {item.kind === "text" && item.long ? (
        <textarea
          {...common}
          rows={6}
          maxLength={item.max ?? 5000}
          className={fieldClass}
          onChange={(e) => onChange(e.target.value)}
        />
      ) : (
        <Input
          {...common}
          type={
            item.kind === "email"
              ? "email"
              : item.kind === "phone"
                ? "tel"
                : item.kind === "number"
                  ? "number"
                  : item.kind === "date"
                    ? "date"
                    : "text"
          }
          inputMode={
            item.kind === "email"
              ? "email"
              : item.kind === "phone"
                ? "tel"
                : item.kind === "number"
                  ? "decimal"
                  : undefined
          }
          autoComplete={
            auto ?? (item.kind === "email" ? "email" : item.kind === "phone" ? "tel" : undefined)
          }
          maxLength={item.kind === "text" ? (item.max ?? 200) : undefined}
          step={item.kind === "number" ? (item.integer ? 1 : "any") : undefined}
          min={item.kind === "number" ? item.min : undefined}
          max={item.kind === "number" ? item.max : undefined}
          onChange={(e) => onChange(e.target.value)}
        />
      )}
    </div>
  );
}

/** What the person reads a question by, in the list of what to fix. */
function nameOf(item: QuestionItem): string {
  if (!isAsked(item)) return "";
  return (item.kind === "consent" ? item.words : item.label).slice(0, 120);
}

/** A form being filled: its questions, what to fix, the spam checks and the send. */
export function FormFields({
  form,
  filler,
  Turnstile,
  sendLabel = "Send",
}: {
  form: OpenedForm;
  filler: Filler;
  Turnstile?: TurnstileWidget | undefined;
  sendLabel?: string;
}) {
  const [token, setToken] = useState<string | null>(null);
  const honeypot = useRef<HTMLInputElement>(null);
  const summary = useRef<HTMLDivElement>(null);
  const [tried, setTried] = useState(0);
  const faults = filler.items.filter((item) => filler.errors[item.key]);
  const needsCheck = form.turnstile;
  useEffect(() => {
    // After a send that did not go, the list of what to fix takes the focus.
    if (tried && (faults.length || filler.problem)) summary.current?.focus();
  }, [tried, faults.length, filler.problem]);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    await filler.send({
      ...(needsCheck ? { turnstileToken: token } : {}),
      honeypot: honeypot.current?.value ?? "",
    });
    setTried((n) => n + 1);
  }

  return (
    <form onSubmit={onSubmit} noValidate className="grid gap-6">
      {faults.length || filler.problem ? (
        <div
          ref={summary}
          tabIndex={-1}
          role="alert"
          className="rounded-md border-2 border-destructive p-4 text-sm outline-none"
        >
          <p className="font-semibold">
            {faults.length ? "Some answers need another look" : "Your answers were not sent"}
          </p>
          {filler.problem && filler.problem.kind !== "answers" ? (
            <p>{filler.problem.message}</p>
          ) : null}
          {faults.length ? (
            <ul className="mt-2 list-disc pl-5">
              {faults.map((item) => (
                <li key={item.key}>
                  <a
                    className="underline"
                    href={`#${fieldId(item.key)}${["choice", "rating", "yesNo"].includes(item.kind) ? "-0" : ""}`}
                  >
                    {nameOf(item)}: {filler.errors[item.key]}
                  </a>
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}
      {/* A field a person never sees: a bot fills it, and the host keeps nothing it sends. */}
      <div aria-hidden="true" className="absolute -left-[10000px] h-px w-px overflow-hidden">
        <label htmlFor={`form-${HONEYPOT_FIELD}`}>Leave this empty</label>
        <input
          ref={honeypot}
          type="text"
          id={`form-${HONEYPOT_FIELD}`}
          name={HONEYPOT_FIELD}
          tabIndex={-1}
          autoComplete="off"
          defaultValue=""
        />
      </div>
      {filler.items.map((item) => (
        <Question
          key={item.key}
          item={item}
          value={filler.draft[item.key]}
          {...(filler.errors[item.key] ? { error: filler.errors[item.key] } : {})}
          onChange={(v) => filler.set(item.key, v)}
        />
      ))}
      {needsCheck ? (
        Turnstile ? (
          <Turnstile onToken={setToken} />
        ) : (
          <p className="text-sm text-muted-foreground" role="note">
            This form cannot be sent from this page just now. Please try again later.
          </p>
        )
      ) : null}
      <div>
        <Button type="submit" disabled={filler.status === "sending" || (needsCheck && !Turnstile)}>
          {filler.status === "sending" ? "Sending…" : sendLabel}
        </Button>
      </div>
    </form>
  );
}

function Shell({ title, children }: { title?: string | null; children: ReactNode }) {
  return (
    <section className="mx-auto grid w-full max-w-xl gap-6">
      {title ? <h1 className="text-2xl font-semibold">{title}</h1> : null}
      {children}
    </section>
  );
}

function Opened({
  form,
  filler,
  Turnstile,
  onSent,
}: {
  form: OpenedForm;
  filler: Filler;
  Turnstile?: TurnstileWidget | undefined;
  onSent?: (() => void) | undefined;
}) {
  useEffect(() => {
    if (filler.status === "sent") onSent?.();
  }, [filler.status, onSent]);
  return (
    <Shell title={form.title}>
      {filler.status === "sent" ? (
        <p role="status" className="whitespace-pre-line">
          {filler.thanks}
        </p>
      ) : (
        <FormFields form={form} filler={filler} Turnstile={Turnstile} />
      )}
    </Shell>
  );
}

/** Loading, or why the form cannot be opened, in the host's words. */
function NotOpen({ error, link }: { error: unknown; link: boolean }) {
  if (!error) {
    return (
      <p className="text-sm text-muted-foreground" role="status">
        Loading…
      </p>
    );
  }
  const refusal = refusalOf(error);
  const words =
    refusal.kind === "offline" || refusal.kind === "other" || refusal.kind === "later"
      ? "This form could not be opened just now. Try again shortly."
      : link
        ? "This link cannot be used: it may have been used already or have expired."
        : "This form is not taking answers just now.";
  return (
    <p className="text-sm" role="alert">
      {words}
    </p>
  );
}

/**
 * A form by its address (`slug`), or by a personal link's token (`link`, read once from the page's
 * address with `takeLinkToken` and kept in memory). `via` says where it is: the business's website
 * (`site`, the default) or its app. `Turnstile`: the app's widget, for a visitor on a public form.
 */
export function FormBlock({
  forms,
  slug,
  link,
  via = "site",
  Turnstile,
  onSent,
}: {
  forms: Pick<FormsHooks, "useForm" | "useAnswer">;
  slug?: string;
  link?: string;
  via?: "site" | "app";
  Turnstile?: TurnstileWidget;
  onSent?: () => void;
}) {
  const opened = forms.useForm(link ? { link } : slug ? { slug } : null);
  const filler = forms.useAnswer(opened.data, { via, ...(link ? { link } : {}) });
  if (!opened.data) return <NotOpen error={opened.error} link={Boolean(link)} />;
  return (
    <Opened
      form={opened.data}
      filler={filler}
      Turnstile={link ? undefined : Turnstile}
      onSent={onSent}
    />
  );
}

/**
 * A signed-in member's own personal link (or a child's they are a guardian of), opened from Needs
 * your attention by the link's id. Answered once; the item goes from Needs your attention once sent.
 */
export function LinkedFormBlock({
  forms,
  linkId,
  onSent,
}: {
  forms: Pick<FormsHooks, "useLinkedForm" | "useAnswerLinked">;
  linkId: string;
  onSent?: () => void;
}) {
  const opened = forms.useLinkedForm(linkId);
  const filler = forms.useAnswerLinked(opened.data, linkId);
  if (!opened.data) return <NotOpen error={opened.error} link />;
  return <Opened form={opened.data} filler={filler} onSent={onSent} />;
}
