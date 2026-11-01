import { Link } from "react-router";
import { Button } from "@/components/ui/button";

export default function NotFound() {
  return (
    <div className="grid place-items-center py-20 text-center">
      <div><p className="font-display text-5xl font-semibold text-primary">404</p><h1 className="mt-2 font-display text-xl font-semibold">Page not found</h1><p className="mt-1 text-sm text-muted-foreground">That page does not exist in the admin console.</p>
        <Button asChild className="mt-5"><Link to="/">Back to overview</Link></Button></div>
    </div>
  );
}
