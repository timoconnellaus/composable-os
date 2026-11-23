// Stage 44 step 5: what the signature pads record (StrokeRecorder in @composable-os/client, which
// the web and native pads both use) is exactly what the host takes (signatureSchema in
// agreements/capture.ts): a real signature passes, a drawing that runs into the limits is cut to
// fit them rather than refused, and the client's limits are the host's.
import {
  SIGNATURE_BOX as CLIENT_BOX,
  SIGNATURE_LIMITS as CLIENT_LIMITS,
  StrokeRecorder,
} from "@composable-os/client";
import { describe, expect, it } from "vitest";
import { SIGNATURE_BOX, SIGNATURE_LIMITS, signatureSchema } from "../src/agreements/capture.ts";

describe("the signature pads record what the host takes", () => {
  it("has the host's box and limits", () => {
    expect(CLIENT_BOX).toEqual(SIGNATURE_BOX);
    expect(CLIENT_LIMITS).toEqual(SIGNATURE_LIMITS);
  });

  it("a signature of a few strokes passes the host's check", () => {
    const pad = new StrokeRecorder();
    for (let s = 0; s < 3; s++) {
      pad.begin([100 + s * 200, 300]);
      for (let i = 1; i <= 40; i++) pad.extend([100 + s * 200 + i * 4, 300 - (i % 10) * 15]);
      pad.end();
    }
    expect(signatureSchema.safeParse(pad.signature()).success).toBe(true);
  });

  it("a long scribble and many strokes are cut to the limits, and still pass", () => {
    const scribble = new StrokeRecorder();
    scribble.begin([0, 0]);
    for (let i = 1; i < 50_000; i++) scribble.extend([(i * 37) % 1001, (i * 53) % 401]);
    expect(scribble.full).toBe(true);
    expect(signatureSchema.safeParse(scribble.signature()).success).toBe(true);

    const strokes = new StrokeRecorder();
    for (let s = 0; s < 100; s++) {
      strokes.begin([(s * 9) % 1000, 10]);
      strokes.extend([(s * 9) % 1000, 390]);
      strokes.end();
    }
    expect(strokes.signature()?.strokes).toHaveLength(SIGNATURE_LIMITS.strokes);
    expect(signatureSchema.safeParse(strokes.signature()).success).toBe(true);
  });

  it("a tap is refused by the host as too little ink, as the pad says", () => {
    const tap = new StrokeRecorder();
    tap.begin([500, 200]);
    tap.end();
    expect(signatureSchema.safeParse(tap.signature()).success).toBe(false);
  });
});
