import { useState, type ReactNode } from "react";
import { SlidersHorizontal } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { useIsDesktop } from "./hooks";

/** "Filters" button: a popover on desktop, a bottom sheet on phones. `active` shows how many filters are applied. */
export function FilterPanel({ active, onClear, children, title = "Filters" }: { active: number; onClear: () => void; children: ReactNode; title?: string }) {
  const desktop = useIsDesktop();
  const [open, setOpen] = useState(false);
  const trigger = (
    <Button type="button" variant="outline" aria-haspopup="dialog" onClick={desktop ? undefined : () => setOpen(true)}>
      <SlidersHorizontal />{title}
      {active > 0 && <span className="grid min-w-5 place-items-center rounded-full bg-primary px-1.5 text-xs font-bold text-primary-foreground">{active}</span>}
    </Button>
  );
  const body = (
    <div className="grid gap-4">
      {children}
      <div className="flex justify-between gap-2">
        <Button type="button" variant="ghost" disabled={active === 0} onClick={onClear}>Clear filters</Button>
        <Button type="button" variant="secondary" onClick={() => setOpen(false)}>Done</Button>
      </div>
    </div>
  );
  if (desktop) {
    return (
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>{trigger}</PopoverTrigger>
        <PopoverContent align="end" className="w-80">{body}</PopoverContent>
      </Popover>
    );
  }
  return (
    <>
      {trigger}
      <Sheet open={open} onOpenChange={setOpen}>
        <SheetContent side="bottom">
          <SheetHeader><SheetTitle>{title}</SheetTitle><SheetDescription className="sr-only">Narrow the list</SheetDescription></SheetHeader>
          <div className="overflow-y-auto px-4 pb-2">{body}</div>
        </SheetContent>
      </Sheet>
    </>
  );
}
