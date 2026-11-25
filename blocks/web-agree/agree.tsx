// Agree to one document (stage 44 step 5), for the web: the version the host gave, its words, a
// health form's questions, the tick label and its box, the typed name and, for a document agreed
// to by drawing, the signature pad. "Agree" hands what the person gave to `onAgree`: a member's
// screen calls the host (me.agreements.accept), a visitor's keeps it for the buying call.
//
// It decides nothing: which version, whether it is due, who may agree and whether what was given
// is acceptable are the host's. What a person types, draws and answers stays in this component's
// memory (never the URL, storage or a log) and is cleared once `onAgree` succeeds.
import {
  type AgreeForm,
  type AgreeInput,
  type AgreementBlock,
  type AgreementListItem,
  type AgreementRun,
  type AgreementVersion,
  type AgreeProblem,
  agreeErrorWords,
  agreeInput,
  agreeProblems,
  type DueReason,
  documentBlocks,
  dueReasonWords,
  emptyAgreeForm,
  NOTE_MAX,
  runText,
  StrokeRecorder,
  TYPED_NAME_MAX,
} from "@composable-os/client";
import { type FormEvent, type ReactNode, useEffect, useId, useRef, useState } from "react";
import { Button } from "../ui-button/button.tsx";
import { Input } from "../ui-input/input.tsx";
import { Label } from "../ui-label/label.tsx";
import { SignaturePad } from "./signature-pad.tsx";

/**
 * Render it with `key={version.id}`: a new version (the host's answer changed while the person
 * read) is a new form, with nothing carried over.
 */
export interface AgreeProps {
  /** The version to read and agree to, exactly as the host gave it: its id is what is sent. */
  version: AgreementVersion;
  /** A child's name when a parent or guardian agrees for them. */
  forName?: string | null;
  /** Why it is asked (a new version, asked again), from the host. */
  reason?: DueReason | null;
  /** The button's words. Default "Agree". */
  submitLabel?: string;
  /** Records the agreement (a member) or keeps it for the purchase (a visitor). Throw to refuse. */
  onAgree: (input: AgreeInput) => Promise<void> | void;
  /** A second button, such as "Not now" or "Back". */
  secondary?: { label: string; onClick: () => void };
}

/**
 * Forgets what a person entered when they leave the page, and when the browser brings the page
 * back from its back-forward cache: a name typed, a signature or health answers are never shown
 * again to whoever presses Back on the device.
 */
export function useForgetOnLeave(forget: () => void): void {
  const latest = useRef(forget);
  latest.current = forget;
  useEffect(() => {
    const hide = () => latest.current();
    const show = (event: PageTransitionEvent) => {
      if (event.persisted) latest.current();
    };
    window.addEventListener("pagehide", hide);
    window.addEventListener("pageshow", show);
    return () => {
      window.removeEventListener("pagehide", hide);
      window.removeEventListener("pageshow", show);
    };
  }, []);
}

/**
 * Instead of the form, for a person who may not agree for themselves: a parent or guardian agrees
 * (from their own account), or the business records a paper form. `children` are the buttons.
 */
export function GuardianAgrees({
  title,
  announce = false,
  children,
}: {
  title: string;
  /** Says the reason as an alert (when it is the only step on screen). */
  announce?: boolean;
  children: ReactNode;
}) {
  return (
    <div className="grid gap-2" data-agreement-guardian>
      <h2 className="text-lg font-semibold">{title}</h2>
      <p role={announce ? "alert" : undefined}>{dueReasonWords("guardian")}</p>
      <p className="text-sm">
        A parent or guardian linked to you agrees to it from their own account, or the business
        records a paper form they signed.
      </p>
      {children}
    </div>
  );
}

export function Agree({
  version,
  forName,
  reason,
  submitLabel = "Agree",
  onAgree,
  secondary,
}: AgreeProps) {
  const id = useId();
  const [form, setForm] = useState<AgreeForm>(() => emptyAgreeForm(version));
  const recorder = useRef(new StrokeRecorder());
  const [problems, setProblems] = useState<AgreeProblem[]>([]);
  const [tried, setTried] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Forget what was typed, drawn and answered.
  const forget = () => {
    setForm(emptyAgreeForm(version));
    recorder.current.clear();
    setTried(false);
    setProblems([]);
  };
  useForgetOnLeave(forget);
  const fieldId = (field: string) => `${id}-${field.replace(/[^A-Za-z0-9_-]/g, "_")}`;
  const problemOf = (field: string) =>
    tried ? problems.find((p) => p.field === field) : undefined;
  const check = (next: AgreeForm) => {
    if (tried) setProblems(agreeProblems(version, next, recorder.current.signature()));
  };
  const update = (next: AgreeForm) => {
    setForm(next);
    check(next);
  };

  async function submit(event: FormEvent) {
    event.preventDefault();
    setError(null);
    setTried(true);
    const signature = recorder.current.signature();
    const found = agreeProblems(version, form, signature);
    setProblems(found);
    const first = found[0];
    if (first) {
      document.getElementById(fieldId(first.field))?.focus();
      return;
    }
    setBusy(true);
    try {
      await onAgree(agreeInput(version, form, signature));
      forget();
    } catch (e) {
      setError(agreeErrorWords(e));
    } finally {
      setBusy(false);
    }
  }

  const because = reason ? dueReasonWords(reason) : null;
  return (
    <form
      onSubmit={submit}
      noValidate
      className="grid gap-4"
      aria-labelledby={`${id}-title`}
      data-agree={version.documentId}
    >
      <header className="grid gap-1">
        <h2 id={`${id}-title`} className="text-lg font-semibold">
          {version.title}
        </h2>
        <p className="text-muted-foreground text-sm">
          {`Version ${version.number}${forName ? ` · for ${forName}` : ""}`}
        </p>
        {because ? <p className="text-sm">{because}</p> : null}
      </header>
      <AgreementText version={version} />
      {version.questions?.length ? (
        <HealthQuestions
          version={version}
          form={form}
          fieldId={fieldId}
          problemOf={problemOf}
          onChange={update}
        />
      ) : null}
      <div className="grid gap-1">
        <div className="flex items-start gap-2">
          <input
            id={fieldId("ticked")}
            type="checkbox"
            className="mt-1 size-5 shrink-0"
            checked={form.ticked}
            aria-invalid={problemOf("ticked") ? true : undefined}
            aria-describedby={problemOf("ticked") ? `${fieldId("ticked")}-error` : undefined}
            onChange={(e) => update({ ...form, ticked: e.target.checked })}
          />
          <Label htmlFor={fieldId("ticked")} className="leading-snug font-normal">
            {version.tickLabel}
          </Label>
        </div>
        <FieldError id={`${fieldId("ticked")}-error`} problem={problemOf("ticked")} />
      </div>
      <div className="grid gap-1">
        <Label htmlFor={fieldId("typedName")}>
          {forName ? "Your name (as their parent or guardian)" : "Your full name"}
        </Label>
        <Input
          id={fieldId("typedName")}
          autoComplete="name"
          maxLength={TYPED_NAME_MAX}
          value={form.typedName}
          aria-invalid={problemOf("typedName") ? true : undefined}
          aria-describedby={problemOf("typedName") ? `${fieldId("typedName")}-error` : undefined}
          onChange={(e) => update({ ...form, typedName: e.target.value })}
        />
        <FieldError id={`${fieldId("typedName")}-error`} problem={problemOf("typedName")} />
      </div>
      {version.how === "drawn" ? (
        <SignaturePad
          id={fieldId("signature")}
          recorder={recorder.current}
          problem={problemOf("signature")?.message ?? null}
          onChange={() => check(form)}
        />
      ) : null}
      {error ? (
        <p role="alert" className="text-destructive text-sm">
          {error}
        </p>
      ) : null}
      <div className="flex flex-wrap gap-2">
        <Button type="submit" disabled={busy}>
          {busy ? "Saving…" : submitLabel}
        </Button>
        {secondary ? (
          <Button type="button" variant="outline" onClick={secondary.onClick} disabled={busy}>
            {secondary.label}
          </Button>
        ) : null}
      </div>
    </form>
  );
}

function FieldError({ id, problem }: { id: string; problem: AgreeProblem | undefined }) {
  return problem ? (
    <p id={id} className="text-destructive text-sm">
      {problem.message}
    </p>
  ) : null;
}

/** A health form's questions: yes or no each, and a note on a yes where the question asks. */
function HealthQuestions({
  version,
  form,
  fieldId,
  problemOf,
  onChange,
}: {
  version: AgreementVersion;
  form: AgreeForm;
  fieldId: (field: string) => string;
  problemOf: (field: string) => AgreeProblem | undefined;
  onChange: (next: AgreeForm) => void;
}) {
  return (
    <fieldset className="grid gap-4 rounded-md border p-3">
      <legend className="px-1 font-medium">Your answers</legend>
      <p className="text-muted-foreground text-sm">
        Only you and the staff allowed to read health forms can see these.
      </p>
      {(version.questions ?? []).map((q) => {
        const answer = form.answers[q.key] ?? { yes: null, note: "" };
        const set = (next: Partial<typeof answer>) =>
          onChange({ ...form, answers: { ...form.answers, [q.key]: { ...answer, ...next } } });
        const problem = problemOf(`answer:${q.key}`);
        const noteProblem = problemOf(`note:${q.key}`);
        const group = fieldId(`answer:${q.key}`);
        return (
          <div key={q.key} className="grid gap-2">
            <div
              role="radiogroup"
              aria-labelledby={`${group}-label`}
              aria-describedby={problem ? `${group}-error` : undefined}
              className="grid gap-1"
            >
              <span id={`${group}-label`}>{q.text}</span>
              <div className="flex gap-4">
                {([true, false] as const).map((yes) => (
                  <label key={String(yes)} className="flex items-center gap-2">
                    <input
                      // The first choice takes focus when the question is still unanswered.
                      id={yes ? group : undefined}
                      type="radio"
                      name={group}
                      className="size-5"
                      checked={answer.yes === yes}
                      aria-invalid={problem ? true : undefined}
                      onChange={() => set({ yes })}
                    />
                    {yes ? "Yes" : "No"}
                  </label>
                ))}
              </div>
              <FieldError id={`${group}-error`} problem={problem} />
            </div>
            {answer.yes && q.noteOnYes ? (
              <div className="grid gap-1">
                <Label htmlFor={fieldId(`note:${q.key}`)}>Tell us more (optional)</Label>
                <textarea
                  id={fieldId(`note:${q.key}`)}
                  className="min-h-20 rounded-md border p-2"
                  maxLength={NOTE_MAX}
                  value={answer.note}
                  aria-invalid={noteProblem ? true : undefined}
                  aria-describedby={noteProblem ? `${fieldId(`note:${q.key}`)}-error` : undefined}
                  onChange={(e) => set({ note: e.target.value })}
                />
                <FieldError id={`${fieldId(`note:${q.key}`)}-error`} problem={noteProblem} />
              </div>
            ) : null}
          </div>
        );
      })}
    </fieldset>
  );
}

/**
 * A version's words, block by block as React elements (never markup), in a region that scrolls
 * on its own and can be scrolled with the keyboard. A link shows its address in full: the host
 * allows only a link whose text is its address, and a linked page is not part of the document.
 */
export function AgreementText({ version }: { version: Pick<AgreementVersion, "title" | "body"> }) {
  return (
    <section
      // A scrolling region is focusable so a keyboard can scroll it (WCAG 2.1.1).
      // biome-ignore lint/a11y/noNoninteractiveTabindex: a scrollable region must take focus.
      tabIndex={0}
      aria-label={`${version.title}: the document`}
      className="grid max-h-[60vh] gap-3 overflow-y-auto rounded-md border p-3 text-sm leading-relaxed"
    >
      {documentBlocks(version.body).map((block, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: a version's blocks never change.
        <Block key={i} block={block} />
      ))}
    </section>
  );
}

function Runs({ content }: { content: readonly AgreementRun[] | undefined }): ReactNode {
  return (content ?? []).map((run, i) => {
    if (run.type === "break") {
      // biome-ignore lint/suspicious/noArrayIndexKey: runs are positional.
      return <br key={i} />;
    }
    let node: ReactNode = runText(run);
    if (run.code) node = <code>{node}</code>;
    if (run.italic) node = <em>{node}</em>;
    if (run.bold) node = <strong>{node}</strong>;
    if (run.href) {
      node = (
        <a
          href={run.href}
          className="break-all underline"
          rel="noopener noreferrer"
          target="_blank"
        >
          {run.href}
        </a>
      );
    }
    // biome-ignore lint/suspicious/noArrayIndexKey: runs are positional.
    return <span key={i}>{node}</span>;
  });
}

function List({ style, items }: { style: "bullet" | "ordered"; items: AgreementListItem[] }) {
  const children = items.map((item, i) => (
    // biome-ignore lint/suspicious/noArrayIndexKey: list items are positional.
    <li key={i}>
      <Runs content={item.content} />
      {item.list ? <List style={item.list.style} items={item.list.items} /> : null}
    </li>
  ));
  return style === "ordered" ? (
    <ol className="list-decimal pl-6">{children}</ol>
  ) : (
    <ul className="list-disc pl-6">{children}</ul>
  );
}

function Block({ block }: { block: AgreementBlock }) {
  switch (block.type) {
    case "paragraph":
      return (
        <p>
          <Runs content={block.content} />
        </p>
      );
    case "heading": {
      // The document's title is the form's heading: the body's start one below it.
      const level = Math.min(Math.max(block.level + 2, 3), 6);
      const Tag = `h${level}` as "h3" | "h4" | "h5" | "h6";
      return (
        <Tag className="font-semibold">
          <Runs content={block.content} />
        </Tag>
      );
    }
    case "list":
      return <List style={block.style} items={block.items} />;
    case "quote":
      return (
        <blockquote className="border-l-4 pl-3 italic">
          <Runs content={block.content} />
          {block.attribution ? <footer className="not-italic">{block.attribution}</footer> : null}
        </blockquote>
      );
    case "callout":
      return (
        <aside className="rounded-md border-l-4 bg-muted/40 p-3" data-tone={block.tone}>
          <Runs content={block.content} />
        </aside>
      );
    case "divider":
      return <hr />;
  }
}
