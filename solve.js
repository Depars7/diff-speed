// Fast drop-in for makefun-diff 1.0.0 (vendor/makefun-diff/index.js).
// run(input) returns makefun-diff's answer for every input { old, new }: the same
// patch string, byte for byte. It keeps the reference's exact rule (common prefix,
// then common suffix, then Myers's greedy search with the deletion-wins-ties
// tie-break, no edge pruning, snakes as far as they go) and only removes the
// reference's cost: the reference allocates a path OBJECT (with a linked list of
// components) for every step of the search and walks linked lists to produce runs.
// This version interns each distinct line string to a small integer id (line
// equality becomes an int comparison), strips the common prefix/suffix on ids,
// runs the greedy search over Int32Array V rows (storing one V snapshot per d
// for backtracking), backtracks through those snapshots to
// rebuild the identical run list, and renders the patch in the reference's
// exact format.
//
// No clock reads, no caching between cases: every run() call builds fresh state.

const FORMAT = 'makefun-diff/1';
const CONTEXT = 3;
const KEEP = '=';
const DELETE = '-';
const INSERT = '+';

/**
 * A text's lines, each with its "\n" (the last one without, when the text does
 * not end in one), and their interned ids. `map` is shared across both texts so
 * the same line string gets the same id in old and new. The line strings are
 * exactly the reference tokenize's: split after every "\n" (the only separator;
 * a "\r" is part of its line), a last line with no "\n" is a line too, the empty
 * text has no lines, "\n" has one empty line.
 */
function tokenize(text, map) {
  const parts = text.split('\n');
  const last = parts.length - 1;
  const n = last + (parts[last] !== '' ? 1 : 0);
  const lines = new Array(n);
  const ids = new Int32Array(n);
  // One shared intern: the same line string gets the same id in both texts.
  const intern = (line) => {
    let id = map.get(line);
    if (id === undefined) {
      id = map.size;
      map.set(line, id);
    }
    return id;
  };
  let idx = 0;
  for (let i = 0; i < last; i++) {
    const line = `${parts[i]}\n`;
    lines[idx] = line;
    ids[idx] = intern(line);
    idx++;
  }
  if (parts[last] !== '') {
    const line = parts[last];
    lines[idx] = line;
    ids[idx] = intern(line);
  }
  return { lines, ids };
}

/**
 * The runs of the edit script of A into B: [{ kind, count }], in order.
 * A and B are Int32Array (or views) of interned line ids, the middle slices
 * after the common prefix/suffix are stripped. This is the reference's editRuns
 * (index.js), re-expressed over V rows instead of path objects.
 *
 * Coordinates: x = old lines consumed, y = new lines consumed, k = x - y.
 * Vs[d] is an Int32Array of length 2d+1, index j = k + d: the furthest x
 * reached on diagonal k after d edits and the snake that follows. -1 means
 * that diagonal holds no path at that d (the reference's bestPath entry left
 * undefined). A deletion from diagonal k-1 reaches x = V[k-1] + 1; an insertion
 * from diagonal k+1 reaches x = V[k+1] unchanged. The reference's rule, in
 * these terms: a deletion is a candidate only when the old line it consumes
 * exists (V[k-1] < N), an insertion only when the new line it consumes exists
 * (V[k+1] - (k+1) < M); the candidate further into the old text wins, and the
 * deletion when both reach the same point (xDel >= xIns). No edge diagonal is
 * pruned. From the chosen point the snake follows every run of equal lines as
 * far as it goes. The first path to reach both ends is the script. The
 * backtrack re-derives each step from the stored V snapshots with the same
 * rule, so it rebuilds the identical run list.
 */
function myersRuns(A, B) {
  const N = A.length;
  const M = B.length;
  if (N === 0 && M === 0) return [];

  // V snapshots, Vs[d] an Int32Array of length 2d+1, index j = k + d.
  const Vs = [];

  // d = 0: the snake from (0, 0), the reference's extractCommon on the initial path.
  const v0 = new Int32Array(1);
  let initialSnake = 0;
  while (initialSnake < N && initialSnake < M && A[initialSnake] === B[initialSnake]) initialSnake++;
  v0[0] = initialSnake;
  Vs.push(v0);
  if (initialSnake >= N && initialSnake >= M) return initialSnake > 0 ? [{ kind: KEEP, count: initialSnake }] : [];

  const maxD = N + M;
  let D = -1;
  let kFinal = 0;
  for (let d = 1; d <= maxD; d++) {
    const vPrev = Vs[d - 1];
    const v = new Int32Array(2 * d + 1);
    const twoD = 2 * d;
    const twoDm2 = twoD - 2;
    let found = false;
    for (let j = 0, k = -d; j <= twoD; j += 2, k += 2) {
      // V_{d-1}[k-1] sits at index j-2 of vPrev; V_{d-1}[k+1] at index j.
      // NOTE: this candidate derivation is deliberately duplicated in the
      // backtrack below (same rule, same tie-break); a shared helper was
      // measured ~5-8% slower here because this loop is hot. Keep both in sync.
      const deleteVal = j >= 2 ? vPrev[j - 2] : -1;
      const insertVal = j <= twoDm2 ? vPrev[j] : -1;
      const canDelete = deleteVal !== -1 && deleteVal < N;
      const canInsert = insertVal !== -1 && insertVal - (k + 1) < M;
      if (!canDelete && !canInsert) {
        v[j] = -1;
        continue;
      }
      const xDel = canDelete ? deleteVal + 1 : -1;
      const xIns = canInsert ? insertVal : -1;
      // Deletion wins ties (xDel >= xIns), exactly the reference's tie-break.
      let nx = xDel >= xIns ? xDel : xIns;
      let ny = nx - k;
      while (nx < N && ny < M && A[nx] === B[ny]) {
        nx++;
        ny++;
      }
      v[j] = nx;
      if (nx >= N && ny >= M) {
        D = d;
        kFinal = k;
        found = true;
        break;
      }
    }
    Vs.push(v);
    if (found) break;
  }
  if (D === -1) throw new Error('makefun-diff: the search ended without reaching both ends');

  // Backtrack from (D, kFinal): re-derive each step from the V snapshots.
  // rev collects runs in reverse chronological order (snake first, then its edit).
  const rev = [];
  let d = D;
  let k = kFinal;
  let cx = Vs[D][kFinal + D];
  for (; d >= 1; d--) {
    const vPrev = Vs[d - 1];
    const j = k + d;
    const twoDm2 = 2 * d - 2;
    // Same candidate derivation as the forward loop above; keep in sync.
    // A backtracked step always has a predecessor (the forward search only
    // records reachable diagonals), so deleteVal/insertVal are never both -1
    // here and there is no no-candidate case to guard.
    const deleteVal = j >= 2 ? vPrev[j - 2] : -1;
    const insertVal = j <= twoDm2 ? vPrev[j] : -1;
    const canDelete = deleteVal !== -1 && deleteVal < N;
    const canInsert = insertVal !== -1 && insertVal - (k + 1) < M;
    const xDel = canDelete ? deleteVal + 1 : -1;
    const xIns = canInsert ? insertVal : -1;
    let xEdit;
    let kind;
    let kPrev;
    let xPrev;
    if (xDel >= xIns) {
      xEdit = xDel;
      kind = DELETE;
      kPrev = k - 1;
      xPrev = deleteVal;
    } else {
      xEdit = xIns;
      kind = INSERT;
      kPrev = k + 1;
      xPrev = insertVal;
    }
    const snake = cx - xEdit;
    if (snake > 0) rev.push({ kind: KEEP, count: snake });
    rev.push({ kind, count: 1 });
    cx = xPrev;
    k = kPrev;
  }
  // The d = 0 snake.
  if (initialSnake > 0) rev.push({ kind: KEEP, count: initialSnake });
  rev.reverse();
  // Merge consecutive runs of one kind (the reference's addToPath does this
  // for edits; KEEP runs never sit adjacent, an edit always lies between).
  const runs = [];
  for (const r of rev) {
    const last = runs[runs.length - 1];
    if (last !== undefined && last.kind === r.kind) last.count += r.count;
    else runs.push({ kind: r.kind, count: r.count });
  }
  return runs;
}

/** A line as the patch writes it: its op, the line, a newline, and "%" on a line of its own when it had none. */
function renderLine(op, line) {
  return line.endsWith('\n') ? `${op}${line}` : `${op}${line}\n%\n`;
}

/** make.fun's own patch of input.old into input.new (the reference's diffPatch). */
export function run(input) {
  if (input === null || typeof input !== 'object' || typeof input.old !== 'string' || typeof input.new !== 'string') {
    throw new TypeError('makefun-diff: the input is { old, new }, two strings');
  }
  const map = new Map();
  const a = tokenize(input.old, map);
  const b = tokenize(input.new, map);
  const n = a.lines.length;
  const m = b.lines.length;
  const aIds = a.ids;
  const bIds = b.ids;
  // The common prefix, then the common suffix of what is left.
  let prefix = 0;
  while (prefix < n && prefix < m && aIds[prefix] === bIds[prefix]) prefix++;
  let suffix = 0;
  while (suffix < n - prefix && suffix < m - prefix && aIds[n - 1 - suffix] === bIds[m - 1 - suffix]) suffix++;
  const runs = [];
  if (prefix > 0) runs.push({ kind: KEEP, count: prefix });
  runs.push(...myersRuns(aIds.subarray(prefix, n - suffix), bIds.subarray(prefix, m - suffix)));
  if (suffix > 0) runs.push({ kind: KEEP, count: suffix });

  // The change runs: each a stretch of deletions and insertions between two kept lines, at old line o and new line p.
  const changes = [];
  let o = 0;
  let p = 0;
  let deleted = 0;
  let inserted = 0;
  for (const r of runs) {
    if (r.kind === KEEP) {
      o += r.count;
      p += r.count;
      continue;
    }
    let c = changes.at(-1);
    if (c === undefined || c.o + c.dels !== o || c.p + c.ins !== p) {
      c = { o, p, dels: 0, ins: 0 };
      changes.push(c);
    }
    if (r.kind === DELETE) {
      c.dels += r.count;
      o += r.count;
      deleted += r.count;
    } else {
      c.ins += r.count;
      p += r.count;
      inserted += r.count;
    }
  }

  // The hunks: change runs at most 2 * CONTEXT kept lines apart share one.
  const hunks = [];
  for (const c of changes) {
    const h = hunks.at(-1);
    const prev = h?.at(-1);
    if (prev !== undefined && c.o - (prev.o + prev.dels) <= 2 * CONTEXT) h.push(c);
    else hunks.push([c]);
  }
  const out = [`${FORMAT} old=${n} new=${m} hunks=${hunks.length} deleted=${deleted} inserted=${inserted}\n`];
  for (const h of hunks) {
    const first = h[0];
    const last = h.at(-1);
    const oldStart = Math.max(0, first.o - CONTEXT);
    const newStart = first.p - (first.o - oldStart);
    const after = Math.min(CONTEXT, n - (last.o + last.dels));
    const oldEnd = last.o + last.dels + after;
    const newEnd = last.p + last.ins + after;
    out.push(`@ ${oldStart + 1} ${oldEnd - oldStart} ${newStart + 1} ${newEnd - newStart}\n`);
    let at = oldStart;
    for (const c of h) {
      for (; at < c.o; at++) out.push(renderLine(KEEP, a.lines[at]));
      for (let i = 0; i < c.dels; i++) out.push(renderLine(DELETE, a.lines[c.o + i]));
      for (let i = 0; i < c.ins; i++) out.push(renderLine(INSERT, b.lines[c.p + i]));
      at = c.o + c.dels;
    }
    for (; at < oldEnd; at++) out.push(renderLine(KEEP, a.lines[at]));
  }
  return out.join('');
}
