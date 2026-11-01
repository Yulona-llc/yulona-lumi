import { cn } from "@/lib/utils";

/** The Lumi mark (placeholder until the final logo is supplied): used alone in tight spaces. */
export function LogoMark({ className }: { className?: string }) {
  return <img src="/brand/lumi-mark.svg" alt="" aria-hidden="true" className={cn("size-8", className)} />;
}

/** Full wordmark. `light` = for dark backgrounds (white lettering). */
export function Logo({ light = false, className }: { light?: boolean; className?: string }) {
  return (
    <img
      src={light ? "/brand/lumi-logo-on-dark.svg" : "/brand/lumi-logo-on-light.svg"}
      alt="Lumi"
      width={170}
      height={68}
      className={cn("h-9 w-auto select-none", className)}
      draggable={false}
    />
  );
}

/** Wordmark that follows the theme (dark lettering in light mode, white in dark mode). */
export function ThemedLogo({ className }: { className?: string }) {
  return (
    <>
      <Logo className={cn("dark:hidden", className)} />
      <img src="/brand/lumi-logo-on-dark.svg" alt="Lumi" width={170} height={68} className={cn("hidden h-9 w-auto select-none dark:block", className)} draggable={false} />
    </>
  );
}
