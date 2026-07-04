// Read-only profil rozeti (design 17 §P1-V1 Ö5). Aynı görsel dil StatusBar,
// ConnectionMenu ve TabBar'da kullanılır — prod'a yanlışlıkla yazma sigortasının
// (default_transaction_read_only=on, design 06 §66) görünür hali.
import { cn } from "@/lib/utils";

export function RoBadge({ className }: { className?: string }) {
  return (
    <span
      className={cn(
        "rounded bg-warn/15 px-1 text-[9px] font-bold uppercase tracking-wide text-warn",
        className,
      )}
      title="Read-only profile — default_transaction_read_only=on"
    >
      RO
    </span>
  );
}
