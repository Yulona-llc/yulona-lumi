import * as React from "react";
import { Tabs as TabsPrimitive } from "radix-ui";
import { cn } from "@/lib/utils";

const Tabs = TabsPrimitive.Root;
function TabsList({ className, ...props }: React.ComponentProps<typeof TabsPrimitive.List>) {
  return <TabsPrimitive.List className={cn("scrollbar-none inline-flex max-w-full items-center gap-1 overflow-x-auto rounded-xl bg-muted p-1", className)} {...props} />;
}
function TabsTrigger({ className, ...props }: React.ComponentProps<typeof TabsPrimitive.Trigger>) {
  return (
    <TabsPrimitive.Trigger
      className={cn("inline-flex min-h-10 shrink-0 items-center justify-center gap-1.5 whitespace-nowrap rounded-lg px-3.5 text-sm font-medium text-muted-foreground outline-none transition-all hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/30 disabled:opacity-50 data-[state=active]:bg-card data-[state=active]:text-foreground data-[state=active]:shadow-sm sm:min-h-8", className)}
      {...props}
    />
  );
}
function TabsContent({ className, ...props }: React.ComponentProps<typeof TabsPrimitive.Content>) {
  return <TabsPrimitive.Content className={cn("mt-4 outline-none data-[state=active]:animate-in data-[state=active]:fade-in-0 data-[state=active]:duration-200", className)} {...props} />;
}
export { Tabs, TabsList, TabsTrigger, TabsContent };
