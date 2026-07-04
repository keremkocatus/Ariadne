import { format } from "sql-formatter";

/// SQL'i okunaklı biçimde yeniden yazar (design 20 §P1-Y2 M3). PostgreSQL diyalekti,
/// anahtar kelimeler BÜYÜK, 2 boşluk girinti. Saf fonksiyon (test edilebilir).
///
/// sql-formatter bazı Postgres'e özgü sözdiziminde (dollar-quoted gövde, egzotik
/// operatörler) hata atabilir → çağıran taraf try/catch ile metni korumalı.
export function formatSql(sql: string): string {
  return format(sql, {
    language: "postgresql",
    keywordCase: "upper",
    tabWidth: 2,
  });
}
