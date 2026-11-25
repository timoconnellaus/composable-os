// The web signature pad (stage 44 step 5): a box drawn in with a mouse, a finger or a pen, through
// pointer events. It records strokes in the host's format (`StrokeRecorder`: integer points in a
// 1000 by 400 box, within the host's limits) and draws them as SVG, as every screen and the PDF
// draw a signature. Nothing is kept as an image, and nothing leaves the page but the Agree call.
import { boxPoint, SIGNATURE_BOX, type StrokeRecorder, strokePath } from "@composable-os/client";
import { type PointerEvent, useRef, useState } from "react";
import { Button } from "../ui-button/button.tsx";

export function SignaturePad({
  id,
  recorder,
  problem,
  onChange,
}: {
  /** The drawing area's id: a problem's link focuses it. */
  id: string;
  /** Holds the strokes (the Agree block's, cleared after it agrees). */
  recorder: StrokeRecorder;
  /** What is wrong with it, from the Agree block's check. */
  problem: string | null;
  onChange: () => void;
}) {
  const area = useRef<SVGSVGElement>(null);
  // Bumped to draw again after the recorder changes.
  const [, setDrawn] = useState(0);
  const redraw = () => setDrawn((n) => n + 1);

  const pointOf = (event: { clientX: number; clientY: number }) => {
    const rect = area.current?.getBoundingClientRect();
    if (!rect) return null;
    return boxPoint(event.clientX - rect.left, event.clientY - rect.top, rect.width, rect.height);
  };

  function down(event: PointerEvent<SVGSVGElement>) {
    if (event.button !== 0 && event.pointerType === "mouse") return;
    // One finger or pen draws: a second finger (or a palm) never draws a line to the first.
    if (!event.isPrimary) return;
    const point = pointOf(event);
    if (!point) return;
    event.preventDefault();
    if (recorder.begin(point, event.pointerId)) {
      event.currentTarget.setPointerCapture(event.pointerId);
    }
    redraw();
  }

  function move(event: PointerEvent<SVGSVGElement>) {
    if (!event.currentTarget.hasPointerCapture(event.pointerId)) return;
    // Every position the device reported since the last event, for a smooth line.
    const native = event.nativeEvent as globalThis.PointerEvent;
    const events = native.getCoalescedEvents?.() ?? [native];
    let added = false;
    for (const e of events.length ? events : [native]) {
      const point = pointOf(e);
      if (point && recorder.extend(point, event.pointerId)) added = true;
    }
    if (added) redraw();
  }

  function up(event: PointerEvent<SVGSVGElement>) {
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    recorder.end(event.pointerId);
    redraw();
    onChange();
  }

  const drawn = recorder.strokes.length > 0;
  const hint = `${id}-hint`;
  return (
    <div className="grid gap-1">
      <span id={`${id}-label`} className="text-sm font-medium">
        Your signature
      </span>
      <p id={hint} className="text-muted-foreground text-sm">
        Draw your signature in the box with your finger, a pen or the mouse. If you cannot draw one,
        ask the business to record a paper form for you instead.
      </p>
      <svg
        ref={area}
        id={id}
        role="img"
        // The box takes focus so a problem's message can lead to it.
        tabIndex={-1}
        aria-labelledby={`${id}-label`}
        aria-describedby={`${hint} ${id}-state${problem ? ` ${id}-error` : ""}`}
        viewBox={`0 0 ${SIGNATURE_BOX.width} ${SIGNATURE_BOX.height}`}
        preserveAspectRatio="none"
        className={`aspect-[5/2] w-full max-w-xl cursor-crosshair rounded-md border bg-background ${
          problem ? "border-destructive" : ""
        }`}
        // Drawing never scrolls or zooms the page under a finger or a pen.
        style={{ touchAction: "none", userSelect: "none" }}
        onPointerDown={down}
        onPointerMove={move}
        onPointerUp={up}
        onPointerCancel={up}
        onLostPointerCapture={(event) => recorder.end(event.pointerId)}
      >
        <title>{drawn ? "Your signature, drawn" : "An empty box to draw your signature in"}</title>
        <line
          x1={40}
          x2={SIGNATURE_BOX.width - 40}
          y1={SIGNATURE_BOX.height - 70}
          y2={SIGNATURE_BOX.height - 70}
          className="stroke-muted-foreground/40"
          strokeWidth={2}
        />
        {recorder.strokes.map((stroke, i) => (
          <path
            // biome-ignore lint/suspicious/noArrayIndexKey: strokes are positional and only grow.
            key={i}
            d={strokePath(stroke)}
            fill="none"
            stroke="currentColor"
            strokeWidth={3}
            strokeLinecap="round"
            strokeLinejoin="round"
            vectorEffect="non-scaling-stroke"
          />
        ))}
      </svg>
      <div className="flex flex-wrap items-center gap-2">
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={!drawn}
          onClick={() => {
            recorder.clear();
            redraw();
            onChange();
          }}
        >
          Clear signature
        </Button>
        <span id={`${id}-state`} className="text-muted-foreground text-sm" aria-live="polite">
          {recorder.full
            ? "The box is full: clear it to start again."
            : drawn
              ? "Signature drawn."
              : "Nothing drawn yet."}
        </span>
      </div>
      {problem ? (
        <p id={`${id}-error`} className="text-destructive text-sm">
          {problem}
        </p>
      ) : null}
    </div>
  );
}
