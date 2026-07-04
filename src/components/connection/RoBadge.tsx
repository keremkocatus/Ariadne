// Read-only profile badge. The same visual language is used in StatusBar,
// ConnectionMenu, and TabBar — the visible form of the accidental-write safety net
// (default_transaction_read_only=on).
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
