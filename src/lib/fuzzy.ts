// Basit skorlu subsequence fuzzy matcher (design 04 §5 ile aynı ruh; frontend
// tarafında explorer araması için). Harici crate yok.

export interface FuzzyResult {
  matched: boolean;
  score: number;
}

/**
 * `query` karakterleri `text` içinde sırayla geçiyor mu? Geçiyorsa skor:
 * exact-prefix > kelime-başı > bitişik > serpiştirilmiş. Büyük skor = daha iyi.
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
      if (ti === prevMatch + 1) s += 15; // bitişik
      if (wordStart) s += 20; // kelime başı (harf öncesi _/./- veya baş)
      score += s;
      prevMatch = ti;
      qi++;
    }
    wordStart = c === "_" || c === "." || c === "-";
  }
  if (qi < q.length) return { matched: false, score: 0 };
  // Kısa isim eşleşmeleri hafif öne.
  return { matched: true, score: score - t.length };
}
