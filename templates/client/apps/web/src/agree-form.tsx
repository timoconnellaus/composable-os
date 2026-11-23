// Agree to one document (stage 44), plain: the words, a health form's questions, the box, the
// typed name and, for a document agreed to by drawing, a signature box (pointer events, the
// host's stroke format through StrokeRecorder). For a styled screen, copy the web-agree block
// (cos add web-agree), which does the same with the base layer's look.
//
// What a person types, draws and answers stays in this component's memory until "Agree", and is
// forgotten after it. It decides nothing: the host checks all of it again.
import {
  type AgreeInput,
  type AgreementVersion,
  agreeErrorWords,
  agreeInput,
  agreeProblems,
  boxPoint,
  documentBlocks,
  emptyAgreeForm,
  type AgreeForm as Form,
  runText,
  StrokeRecorder,
  strokePath,
} from "@composable-os/client";
import { type FormEvent, useRef, useState } from "react";

export function AgreeForm({
  version,
  forName,
  onAgree,
}: {
  version: AgreementVersion;
  forName: string | null;
  onAgree: (input: AgreeInput) => Promise<void>;
}) {
  const [form, setForm] = useState<Form>(() => emptyAgreeForm(version));
  const recorder = useRef(new StrokeRecorder());
  const pad = useRef<SVGSVGElement>(null);
  const [, setDrawn] = useState(0);
  const [problems, setProblems] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const at = (event: { clientX: number; clientY: number }) => {
    const rect = pad.current?.getBoundingClientRect();
    return rect
      ? boxPoint(event.clientX - rect.left, event.clientY - rect.top, rect.width, rect.height)
      : null;
  };

  async function submit(event: FormEvent) {
    event.preventDefault();
    setError(null);
    const signature = recorder.current.signature();
    const found = agreeProblems(version, form, signature);
    setProblems(found.map((p) => p.message));
    if (found.length) return;
    setBusy(true);
    try {
      await onAgree(agreeInput(version, form, signature));
      setForm(emptyAgreeForm(version));
      recorder.current.clear();
    } catch (e) {
      setError(agreeErrorWords(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} noValidate style={{ display: "grid", gap: 12 }}>
      <h2>{version.title}</h2>
      <p>{`Version ${version.number}${forName ? `, for ${forName}` : ""}`}</p>
      <section
        // biome-ignore lint/a11y/noNoninteractiveTabindex: a scrollable region must take focus.
        tabIndex={0}
        aria-label="The document"
        style={{ maxHeight: "50vh", overflowY: "auto", border: "1px solid #ccc", padding: 12 }}
      >
        {documentBlocks(version.body).map((block, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: a version's blocks never change.
          <p key={i}>
            {"content" in block
              ? block.content.map(runText).join("")
              : block.type === "list"
                ? block.items.map((item) => `• ${item.content.map(runText).join("")}`).join("\n")
                : ""}
          </p>
        ))}
      </section>
      {(version.questions ?? []).map((q) => {
        const answer = form.answers[q.key] ?? { yes: null, note: "" };
        const set = (next: Partial<typeof answer>) =>
          setForm({ ...form, answers: { ...form.answers, [q.key]: { ...answer, ...next } } });
        return (
          <fieldset key={q.key}>
            <legend>{q.text}</legend>
            <label>
              <input
                type="radio"
                checked={answer.yes === true}
                onChange={() => set({ yes: true })}
              />
              Yes
            </label>{" "}
            <label>
              <input
                type="radio"
                checked={answer.yes === false}
                onChange={() => set({ yes: false })}
              />
              No
            </label>
            {answer.yes && q.noteOnYes ? (
              <label style={{ display: "grid" }}>
                Tell us more (optional)
                <textarea value={answer.note} onChange={(e) => set({ note: e.target.value })} />
              </label>
            ) : null}
          </fieldset>
        );
      })}
      <label>
        <input
          type="checkbox"
          checked={form.ticked}
          onChange={(e) => setForm({ ...form, ticked: e.target.checked })}
        />{" "}
        {version.tickLabel}
      </label>
      <label style={{ display: "grid" }}>
        Your full name
        <input
          autoComplete="name"
          value={form.typedName}
          onChange={(e) => setForm({ ...form, typedName: e.target.value })}
        />
      </label>
      {version.how === "drawn" ? (
        <div style={{ display: "grid", gap: 4 }}>
          <span>Draw your signature in the box</span>
          <svg
            ref={pad}
            role="img"
            aria-label="Signature box"
            viewBox="0 0 1000 400"
            preserveAspectRatio="none"
            style={{
              width: "100%",
              aspectRatio: "5 / 2",
              border: "1px solid #ccc",
              touchAction: "none",
            }}
            onPointerDown={(e) => {
              const point = at(e);
              if (!point) return;
              e.currentTarget.setPointerCapture(e.pointerId);
              recorder.current.begin(point);
              setDrawn((n) => n + 1);
            }}
            onPointerMove={(e) => {
              const point = at(e);
              if (point && recorder.current.extend(point)) setDrawn((n) => n + 1);
            }}
            onPointerUp={() => recorder.current.end()}
            onPointerCancel={() => recorder.current.end()}
          >
            <title>Signature box</title>
            {recorder.current.strokes.map((stroke, i) => (
              <path
                // biome-ignore lint/suspicious/noArrayIndexKey: strokes are positional.
                key={i}
                d={strokePath(stroke)}
                fill="none"
                stroke="currentColor"
                strokeWidth={3}
                vectorEffect="non-scaling-stroke"
              />
            ))}
          </svg>
          <button
            type="button"
            onClick={() => {
              recorder.current.clear();
              setDrawn((n) => n + 1);
            }}
          >
            Clear signature
          </button>
        </div>
      ) : null}
      {problems.length ? (
        <ul role="alert">
          {problems.map((p) => (
            <li key={p}>{p}</li>
          ))}
        </ul>
      ) : null}
      {error ? <p role="alert">{error}</p> : null}
      <button type="submit" disabled={busy}>
        Agree
      </button>
    </form>
  );
}
