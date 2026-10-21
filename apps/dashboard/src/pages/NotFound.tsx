import { Link } from "react-router";
import { Compass, Inbox } from "lucide-react";
import { LogoMark } from "../components/Logo";
import { Button } from "@/components/ui/button";
import { motion } from "@/components/motion";

export default function NotFound() {
  return (
    <main className="grid min-h-dvh place-items-center bg-background p-6 text-center">
      <div className="max-w-md">
        <div className="relative mx-auto mb-6 grid size-28 place-items-center">
          <span aria-hidden="true" className="absolute inset-0 rounded-full bg-accent" />
          <motion.span initial={{ y: -14, opacity: 0 }} animate={{ y: 0, opacity: 1 }} transition={{ type: "spring", stiffness: 160, damping: 11 }}>
            <LogoMark className="size-16" />
          </motion.span>
        </div>
        <p className="font-display text-sm font-medium text-muted-foreground">Error 404</p>
        <h1 className="mt-1 font-display text-3xl font-semibold tracking-tight">This page has dried up</h1>
        <p className="mt-2 text-muted-foreground">The address you opened does not exist, or it moved. Head back to your overview or open the inbox.</p>
        <div className="mt-7 flex flex-col gap-2 sm:flex-row sm:justify-center">
          <Button asChild size="lg"><Link to="/"><Compass />Back to dashboard</Link></Button>
          <Button asChild size="lg" variant="outline"><Link to="/inbox"><Inbox />Open inbox</Link></Button>
        </div>
      </div>
    </main>
  );
}
