// Small shared presentation pieces. Before these existed every panel re-declared its
// own chip, icon button and empty state with slightly different spacing.
import * as React from "react";
import { ChevronRight } from "lucide-react";
import { cn } from "@/lib/utils";

/// A square, borderless toolbar button holding one icon.
export const IconButton = React.forwardRef<
  HTMLButtonElement,
  React.ButtonHTMLAttributes<HTMLButtonElement> & { active?: boolean }
>(({ className, active, type = "button", ...props }, ref) => (
  <button
    ref={ref}
    type={type}
    className={cn(
      "inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-fg-muted transition-colors",
      "hover:bg-bg-hover hover:text-fg disabled:pointer-events-none disabled:opacity-40",
      active && "bg-bg-hover text-fg",
      className,
    )}
    {...props}
  />
));
IconButton.displayName = "IconButton";

type ChipTone = "neutral" | "strong" | "warn" | "danger" | "ok";

const CHIP_TONES: Record<ChipTone, string> = {
  neutral: "bg-fg/8 text-fg-muted",
  strong: "bg-fg/12 text-fg",
  warn: "bg-warn/15 text-warn",
  danger: "bg-danger/15 text-danger",
  ok: "bg-ok/15 text-ok",
};

/// A tiny label for a property of the thing next to it (PK, unique, disabled, …).
export function Chip({
  tone = "neutral",
  className,
  ...props
}: React.HTMLAttributes<HTMLSpanElement> & { tone?: ChipTone }) {
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center rounded px-1 py-px text-[9px] font-semibold uppercase leading-[14px] tracking-wide",
        CHIP_TONES[tone],
        className,
      )}
      {...props}
    />
  );
}

export function EmptyState({ children, className }: { children: React.ReactNode; className?: string }) {
  return <div className={cn("p-3 text-xs text-fg-muted", className)}>{children}</div>;
}

/// A collapsible block with a quiet uppercase header and an optional count.
export function Section({
  title,
  count,
  defaultOpen = false,
  children,
  className,
}: {
  title: string;
  count?: number | null;
  defaultOpen?: boolean;
  children: React.ReactNode;
  className?: string;
}) {
  const [open, setOpen] = React.useState(defaultOpen);
  return (
    <section className={className}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="sticky top-0 z-[1] flex w-full items-center gap-1 bg-inherit py-1.5 text-left text-[10px] font-medium uppercase tracking-wider text-fg-muted transition-colors hover:text-fg"
        aria-expanded={open}
      >
        <ChevronRight size={11} className={cn("shrink-0 transition-transform", open && "rotate-90")} />
        {title}
        {count != null && <span className="font-normal tabular-nums text-fg-subtle">{count}</span>}
      </button>
      {open && <div className="pb-2">{children}</div>}
    </section>
  );
}

/// A pill-shaped two-or-more-way switch.
export function Segmented<T extends string>({
  value,
  options,
  onChange,
  className,
}: {
  value: T;
  options: { value: T; label: React.ReactNode; title?: string }[];
  onChange: (value: T) => void;
  className?: string;
}) {
  return (
    <div className={cn("inline-flex rounded-md border border-border bg-bg p-0.5", className)}>
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          title={o.title}
          onClick={() => onChange(o.value)}
          className={cn(
            "rounded px-2 py-0.5 text-[11px] transition-colors",
            o.value === value ? "bg-bg-hover text-fg" : "text-fg-muted hover:text-fg",
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

/// A labelled on/off switch for boolean options in forms.
export function Toggle({
  checked,
  onChange,
  label,
  hint,
  disabled,
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  label: string;
  hint?: string;
  disabled?: boolean;
}) {
  return (
    <label
      className={cn(
        "flex cursor-pointer items-center gap-2 text-xs",
        disabled && "cursor-default opacity-50",
      )}
      title={hint}
    >
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        disabled={disabled}
        onClick={() => onChange(!checked)}
        className={cn(
          "relative h-4 w-7 shrink-0 rounded-full border transition-colors",
          checked ? "border-fg bg-fg" : "border-border-strong bg-bg",
        )}
      >
        <span
          className={cn(
            "absolute top-1/2 h-2.5 w-2.5 -translate-y-1/2 rounded-full transition-all",
            checked ? "left-[14px] bg-bg" : "left-0.5 bg-fg-muted",
          )}
        />
      </button>
      <span>{label}</span>
    </label>
  );
}
