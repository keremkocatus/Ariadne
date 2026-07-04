// Aktif editörün seçim durumunu çalıştırma yoluna taşıyan ince köprü (design 15
// §P1-U2 "seçili çalıştırma"). SqlEditor mount olunca bir getter kaydeder;
// Toolbar ve App çalıştırırken buradan seçimi okur. Monaco provider'larındaki
// `setActiveConnection` deseninin aynısı — App bir seferde yalnız aktif tab'ın
// editörünü render eder, o yüzden tek getter yeter.

export interface RunSelection {
  /** Seçili metin (SSMS: seçim varsa yalnız o koşar). */
  sql: string;
  /** Seçimin tam metindeki başlangıç byte offset'i (hata marker'ını doğru
   *  konumlamak için — design 15 §P1-U2 riski: yanlış offset'li marker). */
  selectionOffset: number;
}

let getter: (() => RunSelection | null) | null = null;

export function setRunSelectionGetter(fn: (() => RunSelection | null) | null) {
  getter = fn;
}

/** Aktif editörde boş olmayan bir seçim varsa onu, yoksa null döndürür. */
export function getRunSelection(): RunSelection | null {
  return getter ? getter() : null;
}
