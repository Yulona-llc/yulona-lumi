import * as React from "react";
import { Select as SelectPrimitive } from "radix-ui";
import { Check, ChevronDown } from "lucide-react";
import { cn } from "@/lib/utils";

const Select = SelectPrimitive.Root;
const SelectGroup = SelectPrimitive.Group;
const SelectValue = SelectPrimitive.Value;

function SelectTrigger({ className, children, ...props }: React.ComponentProps<typeof SelectPrimitive.Trigger>) {
  return (
    <SelectPrimitive.Trigger
      className={cn("flex min-h-11 w-full items-center justify-between gap-2 whitespace-nowrap rounded-md border border-input bg-card px-3 py-2 text-left text-sm shadow-xs outline-none transition-[border-color,box-shadow] hover:border-foreground/30 focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/25 disabled:cursor-not-allowed disabled:opacity-55 aria-invalid:border-destructive data-[placeholder]:text-muted-foreground sm:min-h-9.5 [&>span]:truncate", className)}
      {...props}
    >
      {children}
      <SelectPrimitive.Icon asChild><ChevronDown className="size-4 shrink-0 text-muted-foreground" /></SelectPrimitive.Icon>
    </SelectPrimitive.Trigger>
  );
}
function SelectContent({ className, children, position = "popper", ...props }: React.ComponentProps<typeof SelectPrimitive.Content>) {
  return (
    <SelectPrimitive.Portal>
      <SelectPrimitive.Content
        position={position}
        className={cn("relative z-50 max-h-72 min-w-[8rem] overflow-hidden rounded-xl border bg-popover text-popover-foreground shadow-lg data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95", position === "popper" && "data-[side=bottom]:translate-y-1 data-[side=top]:-translate-y-1", className)}
        {...props}
      >
        <SelectPrimitive.Viewport className={cn("p-1.5", position === "popper" && "w-full min-w-[var(--radix-select-trigger-width)]")}>{children}</SelectPrimitive.Viewport>
      </SelectPrimitive.Content>
    </SelectPrimitive.Portal>
  );
}
function SelectItem({ className, children, ...props }: React.ComponentProps<typeof SelectPrimitive.Item>) {
  return (
    <SelectPrimitive.Item className={cn("relative flex min-h-10 w-full cursor-default select-none items-center rounded-lg py-1.5 pl-2.5 pr-8 text-sm outline-none focus:bg-muted data-[disabled]:pointer-events-none data-[disabled]:opacity-50 sm:min-h-9", className)} {...props}>
      <span className="absolute right-2.5 flex size-4 items-center justify-center"><SelectPrimitive.ItemIndicator><Check className="size-4 text-primary" /></SelectPrimitive.ItemIndicator></span>
      <SelectPrimitive.ItemText>{children}</SelectPrimitive.ItemText>
    </SelectPrimitive.Item>
  );
}
function SelectLabel({ className, ...props }: React.ComponentProps<typeof SelectPrimitive.Label>) {
  return <SelectPrimitive.Label className={cn("px-2.5 py-1.5 text-xs font-medium text-muted-foreground", className)} {...props} />;
}
export { Select, SelectGroup, SelectValue, SelectTrigger, SelectContent, SelectItem, SelectLabel };
