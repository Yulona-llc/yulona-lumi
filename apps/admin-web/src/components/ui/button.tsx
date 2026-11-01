import * as React from "react";
import { Slot } from "radix-ui";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

const buttonVariants = cva(
  "inline-flex shrink-0 items-center justify-center gap-2 whitespace-nowrap rounded-md text-[0.9375rem] font-semibold outline-none transition-[transform,background-color,box-shadow,color,border-color] duration-150 active:translate-y-px disabled:pointer-events-none disabled:opacity-55 focus-visible:ring-[3px] focus-visible:ring-ring/35 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
  {
    variants: {
      variant: {
        default: "bg-primary text-primary-foreground shadow-[inset_0_1px_0_rgb(255_255_255/0.35),0_1px_2px_rgb(15_26_47/0.2)] hover:bg-primary/90",
        secondary: "bg-secondary text-secondary-foreground hover:bg-secondary/70",
        outline: "border border-input bg-card text-foreground shadow-xs hover:bg-muted",
        ghost: "text-foreground hover:bg-muted",
        destructive: "bg-destructive text-destructive-foreground hover:bg-destructive/90",
        link: "h-auto min-h-0 p-0 text-accent-foreground underline-offset-4 hover:underline",
        dark: "bg-sidebar text-sidebar-foreground hover:bg-sidebar-accent",
      },
      size: {
        default: "min-h-11 px-4 sm:min-h-9.5",
        sm: "min-h-10 px-3 text-sm sm:min-h-8",
        lg: "min-h-12 px-6 text-base",
        icon: "size-11 sm:size-9.5",
        "icon-sm": "size-9 sm:size-8",
      },
    },
    defaultVariants: { variant: "default", size: "default" },
  },
);

function Button({ className, variant, size, asChild = false, ...props }: React.ComponentProps<"button"> & VariantProps<typeof buttonVariants> & { asChild?: boolean }) {
  const Comp = asChild ? Slot.Root : "button";
  return <Comp data-slot="button" className={cn(buttonVariants({ variant, size, className }))} {...props} />;
}

export { Button, buttonVariants };
