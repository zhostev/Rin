// Stage 4 AI Studio: generic diff helpers.
//
// Artifact `output_json` has a backend-defined shape, so the UI never hard-codes
// its fields. These helpers flatten any JSON value into dot-path leaves and
// compute line-level diffs of free text (draft vs. current body/transcript).

export interface JsonLeaf {
  path: string;
  value: unknown;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Flatten any JSON value into sorted dot-path leaves, e.g. `a.b[2]`. */
export function flattenJson(value: unknown, prefix = ""): JsonLeaf[] {
  const leaves: JsonLeaf[] = [];
  if (Array.isArray(value)) {
    value.forEach((item, index) => {
      leaves.push(...flattenJson(item, `${prefix}[${index}]`));
    });
    return leaves;
  }
  if (isPlainObject(value)) {
    for (const key of Object.keys(value)) {
      const path = prefix ? `${prefix}.${key}` : key;
      leaves.push(...flattenJson(value[key], path));
    }
    return leaves;
  }
  leaves.push({ path: prefix || "(root)", value });
  return leaves;
}

export type JsonDiffRow = {
  path: string;
  change: "added" | "removed" | "changed" | "same";
  oldValue?: unknown;
  newValue?: unknown;
};

function valuesEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * Diff two JSON values leaf-by-leaf. `oldJson` is the current content
 * (story body / transcript), `newJson` is the artifact draft. Returns rows
 * ordered by path, `same` rows included so callers can filter.
 */
export function diffJsonLeaves(oldJson: unknown, newJson: unknown): JsonDiffRow[] {
  const oldLeaves = new Map(flattenJson(oldJson).map((leaf) => [leaf.path, leaf.value]));
  const newLeaves = new Map(flattenJson(newJson).map((leaf) => [leaf.path, leaf.value]));
  const paths = new Set([...oldLeaves.keys(), ...newLeaves.keys()]);
  const rows: JsonDiffRow[] = [];
  for (const path of [...paths].sort()) {
    const hasOld = oldLeaves.has(path);
    const hasNew = newLeaves.has(path);
    if (hasOld && !hasNew) {
      rows.push({ path, change: "removed", oldValue: oldLeaves.get(path) });
    } else if (!hasOld && hasNew) {
      rows.push({ path, change: "added", newValue: newLeaves.get(path) });
    } else {
      const oldValue = oldLeaves.get(path);
      const newValue = newLeaves.get(path);
      rows.push(
        valuesEqual(oldValue, newValue)
          ? { path, change: "same", oldValue, newValue }
          : { path, change: "changed", oldValue, newValue },
      );
    }
  }
  return rows;
}

export type TextDiffLine = { type: "same" | "add" | "del"; text: string };

/**
 * Line-level diff of two texts. Trims the common prefix/suffix first, then
 * runs a simple LCS dynamic program on the middle (bounded: middle sides
 * beyond `maxMiddleLines` degrade to a whole-block del+add pair).
 */
export function diffTextLines(oldText: string, newText: string, maxMiddleLines = 400): TextDiffLine[] {
  const oldLines = oldText === "" ? [] : oldText.split("\n");
  const newLines = newText === "" ? [] : newText.split("\n");

  let prefix = 0;
  while (
    prefix < oldLines.length &&
    prefix < newLines.length &&
    oldLines[prefix] === newLines[prefix]
  ) {
    prefix += 1;
  }

  let suffix = 0;
  while (
    suffix < oldLines.length - prefix &&
    suffix < newLines.length - prefix &&
    oldLines[oldLines.length - 1 - suffix] === newLines[newLines.length - 1 - suffix]
  ) {
    suffix += 1;
  }

  const oldMid = oldLines.slice(prefix, oldLines.length - suffix);
  const newMid = newLines.slice(prefix, newLines.length - suffix);

  const lines: TextDiffLine[] = [];
  for (let i = 0; i < prefix; i += 1) {
    lines.push({ type: "same", text: oldLines[i] });
  }

  if (oldMid.length > maxMiddleLines || newMid.length > maxMiddleLines) {
    for (const text of oldMid) lines.push({ type: "del", text });
    for (const text of newMid) lines.push({ type: "add", text });
  } else {
    lines.push(...lcsDiff(oldMid, newMid));
  }

  for (let i = 0; i < suffix; i += 1) {
    lines.push({ type: "same", text: oldLines[oldLines.length - suffix + i] });
  }
  return lines;
}

function lcsDiff(oldLines: string[], newLines: string[]): TextDiffLine[] {
  const m = oldLines.length;
  const n = newLines.length;
  const table: number[][] = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = m - 1; i >= 0; i -= 1) {
    for (let j = n - 1; j >= 0; j -= 1) {
      table[i][j] =
        oldLines[i] === newLines[j]
          ? table[i + 1][j + 1] + 1
          : Math.max(table[i + 1][j], table[i][j + 1]);
    }
  }
  const lines: TextDiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < m && j < n) {
    if (oldLines[i] === newLines[j]) {
      lines.push({ type: "same", text: oldLines[i] });
      i += 1;
      j += 1;
    } else if (table[i + 1][j] >= table[i][j + 1]) {
      lines.push({ type: "del", text: oldLines[i] });
      i += 1;
    } else {
      lines.push({ type: "add", text: newLines[j] });
      j += 1;
    }
  }
  while (i < m) {
    lines.push({ type: "del", text: oldLines[i] });
    i += 1;
  }
  while (j < n) {
    lines.push({ type: "add", text: newLines[j] });
    j += 1;
  }
  return lines;
}

/**
 * Heuristically find the "draft" text inside an artifact's `output_json`:
 * the first sufficiently long string field among common names. Never throws.
 */
export function extractDraftText(outputJson: unknown): string | null {
  const candidates: Array<{ path: string; text: string }> = [];
  for (const leaf of flattenJson(outputJson)) {
    if (typeof leaf.value === "string" && leaf.value.trim().length >= 40) {
      candidates.push({ path: leaf.path, text: leaf.value });
    }
  }
  if (candidates.length === 0) return null;
  const preferred = candidates.find((candidate) =>
    /(draft|transcript|text|content|summary|body|chapters|copy)/i.test(candidate.path),
  );
  return (preferred ?? candidates[0]).text;
}
