import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

const alertVariants = cva("relative grid w-full grid-cols-[0_1fr] items-start gap-y-0.5 rounded-xl border px-4 py-3 text-sm has-[>svg]:grid-cols-[1.25rem_1fr] has-[>svg]:gap-x-3 [&>svg]:size-5 [&>svg]:translate-y-0.5", {
  variants: {
    variant: {
      default: "bg-card text-card-foreground",
      info: "border-info/30 bg-info/8 text-foreground [&>svg]:text-info",
      success: "border-success/30 bg-success/8 text-foreground [&>svg]:text-success",
      warning: "border-warning/40 bg-warning/10 text-foreground [&>svg]:text-warning",
      destructive: "border-destructive/35 bg-destructive/8 text-foreground [&>svg]:text-destructive",
    },
  },
  defaultVariants: { variant: "default" },
});
function Alert({ className, variant, ...props }: React.ComponentProps<"div"> & VariantProps<typeof alertVariants>) {
  return <div role="alert" className={cn(alertVariants({ variant }), className)} {...props} />;
}
function AlertTitle({ className, ...props }: React.ComponentProps<"div">) {
  return <div className={cn("col-start-2 font-semibold leading-tight", className)} {...props} />;
}
function AlertDescription({ className, ...props }: React.ComponentProps<"div">) {
  return <div className={cn("col-start-2 text-muted-foreground", className)} {...props} />;
}
export { Alert, AlertTitle, AlertDescription };
