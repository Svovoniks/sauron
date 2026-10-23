/** Fuzzy matching for the command palette. */

export interface FuzzyMatch {
  score: number;
  /** Indexes of matched characters in the label (for highlighting). */
  indexes: number[];
}

/**
 * A contiguous match scores highest (earlier and at a word start is better); otherwise a subsequence
 * match where every jump lands on a word start ("nc" -> "New Connection"). Null when nothing matches.
 */
export function fuzzyMatch(label: string, query: string): FuzzyMatch | null {
  const q = query.trim().toLowerCase();
  if (!q) return { score: 0, indexes: [] };
  const l = label.toLowerCase();

  const at = l.indexOf(q);
  if (at >= 0) {
    const wordStart = at === 0 || /[\s_\-./]/.test(l[at - 1]);
    return { score: 100 - Math.min(at, 60) + (wordStart ? 50 : 0), indexes: Array.from({ length: q.length }, (_, i) => at + i) };
  }

  const indexes: number[] = [];
  let j = 0;
  let last = -2;
  for (let i = 0; i < l.length && j < q.length; i++) {
    const wordStart = i === 0 || /[\s_\-./]/.test(l[i - 1]);
    if (l[i] === q[j] && (i === last + 1 || wordStart)) {
      indexes.push(i);
      last = i;
      j++;
    }
  }
  return j === q.length ? { score: 10, indexes } : null;
}
