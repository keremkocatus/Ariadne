// A simple scored subsequence fuzzy matcher (for the explorer search on the
// frontend). No external dependency.

export interface FuzzyResult {
  matched: boolean;
  score: number;
}

/**
 * Do the characters of `query` occur in order within `text`? If so, the score ranks:
 * exact-prefix > word-start > adjacent > scattered. Higher score = better.
 */
export function fuzzyMatch(query: string, text: string): FuzzyResult {
  if (query.length === 0) return { matched: true, score: 0 };
  const q = query.toLowerCase();
  const t = text.toLowerCase();

  if (t === q) return { matched: true, score: 1000 };
  if (t.startsWith(q)) return { matched: true, score: 800 - (t.length - q.length) };

  let score = 0;
  let qi = 0;
  let prevMatch = -2;
  let wordStart = true;
  for (let ti = 0; ti < t.length && qi < q.length; ti++) {
    const c = t[ti];
    if (c === q[qi]) {
      let s = 10;
      if (ti === prevMatch + 1) s += 15; // adjacent
      if (wordStart) s += 20; // word start (preceded by _/./- or at the beginning)
      score += s;
      prevMatch = ti;
      qi++;
    }
    wordStart = c === "_" || c === "." || c === "-";
  }
  if (qi < q.length) return { matched: false, score: 0 };
  // Slightly favor matches on shorter names.
  return { matched: true, score: score - t.length };
}
