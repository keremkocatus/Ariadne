import { useUiStore } from "@/stores/uiStore";
import { findLogo } from "./logos";

/// One brand mark by id, drawn in the current text color.
export function LogoMark({ id, size = 18, className }: { id: string; size?: number; className?: string }) {
  return (
    <svg
      viewBox="0 0 64 64"
      width={size}
      height={size}
      className={className}
      aria-hidden
      // The marks are static markup defined in logos.ts, never user input.
      dangerouslySetInnerHTML={{ __html: findLogo(id).body }}
    />
  );
}

/// The mark the user picked in Settings.
export function Logo({ size, className }: { size?: number; className?: string }) {
  const id = useUiStore((s) => s.settings.logo);
  return <LogoMark id={id} size={size} className={className} />;
}
