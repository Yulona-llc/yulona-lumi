import * as React from "react";
import { cn } from "@/lib/utils";

function Input({ className, type, ...props }: React.ComponentProps<"input">) {
  return (
    <input
      type={type}
      data-slot="input"
      className={cn(
        "flex min-h-11 w-full min-w-0 rounded-md border border-input bg-card px-3 py-2 text-foreground shadow-xs outline-none transition-[border-color,box-shadow] placeholder:text-muted-foreground/70 hover:border-foreground/30 focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/25 disabled:cursor-not-allowed disabled:opacity-55 aria-invalid:border-destructive aria-invalid:ring-destructive/20 file:border-0 file:bg-transparent file:text-sm file:font-medium sm:min-h-9.5",
        className,
      )}
      {...props}
    />
  );
}
export { Input };
