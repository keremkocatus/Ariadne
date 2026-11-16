import * as React from "react";
import { cn } from "@/lib/utils";

type Variant = "default" | "outline" | "ghost" | "danger";

export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
}

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant = "outline", type = "button", ...props }, ref) => (
    <button
      ref={ref}
      type={type}
      className={cn(
        "inline-flex items-center justify-center gap-1.5 rounded-md border px-2.5 py-1 text-xs font-medium transition-colors",
        "focus-visible:outline focus-visible:outline-1 focus-visible:outline-offset-1 focus-visible:outline-fg-muted",
        "disabled:pointer-events-none disabled:opacity-40",
        variant === "default" && "border-fg bg-fg text-bg hover:opacity-90",
        variant === "outline" && "border-border bg-bg-elev hover:bg-bg-hover",
        variant === "ghost" && "border-transparent hover:bg-bg-hover",
        variant === "danger" && "border-danger/50 bg-transparent text-danger hover:bg-danger/10",
        className,
      )}
      {...props}
    />
  ),
);
Button.displayName = "Button";
