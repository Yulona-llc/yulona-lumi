import { cn } from "@/lib/utils";

/** The Yulona drop (from yulona.co): used alone in tight spaces. */
export function LogoMark({ className }: { className?: string }) {
  return <img src="/brand/yulona-drop.svg" alt="" aria-hidden="true" className={cn("size-8", className)} />;
}

/** Full wordmark from yulona.co. `light` = for dark backgrounds (white lettering). */
export function Logo({ light = false, className }: { light?: boolean; className?: string }) {
  return (
    <img
      src={light ? "/brand/yulona-logo-on-dark.png" : "/brand/yulona-logo-on-light.png"}
      alt="Yulona"
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
      <img src="/brand/yulona-logo-on-dark.png" alt="Yulona" width={170} height={68} className={cn("hidden h-9 w-auto select-none dark:block", className)} draggable={false} />
    </>
  );
}
