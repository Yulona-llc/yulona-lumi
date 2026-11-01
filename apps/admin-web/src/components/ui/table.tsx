import * as React from "react";
import { cn } from "@/lib/utils";

function Table({ className, ...props }: React.ComponentProps<"table">) {
  return <div className="relative w-full overflow-x-auto"><table className={cn("w-full caption-bottom text-left text-sm", className)} {...props} /></div>;
}
function TableHeader({ className, ...props }: React.ComponentProps<"thead">) {
  return <thead className={cn("border-b bg-muted/50 text-xs text-muted-foreground [&_th]:h-10 [&_th]:px-3 [&_th]:text-left [&_th]:font-medium", className)} {...props} />;
}
function TableBody({ className, ...props }: React.ComponentProps<"tbody">) {
  return <tbody className={cn("[&_tr:last-child]:border-0", className)} {...props} />;
}
function TableRow({ className, ...props }: React.ComponentProps<"tr">) {
  return <tr className={cn("border-b transition-colors hover:bg-muted/40 data-[state=selected]:bg-muted", className)} {...props} />;
}
function TableHead({ className, ...props }: React.ComponentProps<"th">) {
  return <th className={cn("whitespace-nowrap px-3 text-left align-middle font-medium", className)} {...props} />;
}
function TableCell({ className, ...props }: React.ComponentProps<"td">) {
  return <td className={cn("p-3 align-middle", className)} {...props} />;
}
export { Table, TableHeader, TableBody, TableRow, TableHead, TableCell };
