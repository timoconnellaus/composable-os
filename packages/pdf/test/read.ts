// Reading back what a file draws, for the tests: each text object's position and its words, and
// the file outside its hex strings (what a PDF reader parses as structure).

export interface Drawn {
  x: number;
  y: number;
  text: string;
}

const latin1 = (bytes: Uint8Array) => new TextDecoder("latin1").decode(bytes);

function unhex(hex: string): string {
  let text = "";
  for (let i = 0; i < hex.length; i += 2) {
    text += String.fromCharCode(Number.parseInt(hex.slice(i, i + 2), 16));
  }
  return text;
}

/** Every text object (`BT … ET`): where it starts and what it says. */
export function drawn(bytes: Uint8Array): Drawn[] {
  const out: Drawn[] = [];
  for (const match of latin1(bytes).matchAll(/BT\s([\s\S]*?)\sET/g)) {
    const body = match[1] ?? "";
    const at = /(-?[\d.]+) (-?[\d.]+) Td/.exec(body);
    const text = [...body.matchAll(/<([0-9A-F]*)> Tj/g)].map((m) => unhex(m[1] ?? "")).join("");
    out.push({ x: Number(at?.[1] ?? 0), y: Number(at?.[2] ?? 0), text });
  }
  return out;
}

/** All the words drawn, in order. */
export const drawnText = (bytes: Uint8Array) =>
  drawn(bytes)
    .map((d) => d.text)
    .join(" ");

/** The file outside its hex strings. */
export const structure = (bytes: Uint8Array) => latin1(bytes).replace(/<[0-9A-F]*>/g, "<>");

/** How many pages the file has. */
export const pageCount = (bytes: Uint8Array) =>
  structure(bytes).match(/\/Type \/Page /g)?.length ?? 0;
