// A plain line diff for showing a change before it is made (cos init, cos diff): unchanged lines
// near a change as "  ", removed as "- ", added as "+ ". Longest common subsequence; inputs are
// config files and blocks, small enough for it.

export function lineDiff(before: string, after: string, context = 2): string[] {
  const a = before.split("\n");
  const b = after.split("\n");
  const n = a.length;
  const m = b.length;
  // lcs(i, j): the longest common run of a[i..] and b[j..], in one flat table.
  const width = m + 1;
  const table = new Int32Array((n + 1) * width);
  const lcs = (i: number, j: number) => table[i * width + j] ?? 0;
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      table[i * width + j] =
        a[i] === b[j] ? lcs(i + 1, j + 1) + 1 : Math.max(lcs(i + 1, j), lcs(i, j + 1));
    }
  }
  const ops: { kind: " " | "-" | "+"; line: string }[] = [];
  let i = 0;
  let j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && a[i] === b[j]) {
      ops.push({ kind: " ", line: a[i] as string });
      i++;
      j++;
    } else if (j < m && (i === n || lcs(i, j + 1) >= lcs(i + 1, j))) {
      ops.push({ kind: "+", line: b[j] as string });
      j++;
    } else {
      ops.push({ kind: "-", line: a[i] as string });
      i++;
    }
  }
  const near = ops.map((_op, k) =>
    ops.slice(Math.max(0, k - context), k + context + 1).some((o) => o.kind !== " "),
  );
  const out: string[] = [];
  let skipped = false;
  ops.forEach((op, k) => {
    if (near[k]) {
      if (skipped) out.push("@@");
      skipped = false;
      out.push(`${op.kind} ${op.line}`);
    } else skipped = true;
  });
  return out;
}
