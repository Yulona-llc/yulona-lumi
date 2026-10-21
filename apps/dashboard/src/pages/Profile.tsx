import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "react-router";
import { Building2, LogOut, Mail, ShieldCheck } from "lucide-react";
import { api } from "../api/client";
import { useAuth } from "../auth/AuthProvider";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { motion } from "@/components/motion";
import { ErrorState, PageHeader } from "../features/common/ui";

const initials = (n: string) => n.split(/\s+/).filter(Boolean).slice(0, 2).map((p) => p[0]!.toUpperCase()).join("") || "?";

export default function Profile() {
  const q = useQuery({ queryKey: ["me"], queryFn: api.me });
  const { logout } = useAuth();
  const navigate = useNavigate();
  return (
    <section className="max-w-2xl">
      <PageHeader title="Profile" subtitle="Who you are signed in as, and which workspace you are working in." />
      <div aria-live="polite">
        {q.isPending && <div role="status"><span className="sr-only">Loading profile…</span><Skeleton className="h-64 w-full rounded-xl" /></div>}
        {q.isError && <ErrorState error={q.error} retry={() => void q.refetch()} />}
        {q.data && (
          <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }}>
            <Card className="gap-6">
              <div className="flex items-center gap-4">
                <Avatar className="size-16"><AvatarFallback className="bg-primary text-xl text-primary-foreground">{initials(q.data.user.name)}</AvatarFallback></Avatar>
                <div className="min-w-0">
                  <p className="truncate font-display text-xl font-semibold">{q.data.user.name}</p>
                  <Badge variant="secondary" className="mt-1 capitalize">{q.data.user.role}</Badge>
                </div>
              </div>
              <dl className="grid gap-4 border-t pt-5 sm:grid-cols-2">
                <div className="flex items-start gap-3"><Mail className="mt-0.5 size-4 text-muted-foreground" /><div className="min-w-0"><dt className="text-sm text-muted-foreground">Email</dt><dd className="break-all font-medium">{q.data.user.email}</dd></div></div>
                <div className="flex items-start gap-3"><Building2 className="mt-0.5 size-4 text-muted-foreground" /><div className="min-w-0"><dt className="text-sm text-muted-foreground">Workspace</dt><dd className="font-medium">{q.data.tenant.name}</dd></div></div>
                <div className="flex items-start gap-3"><ShieldCheck className="mt-0.5 size-4 text-muted-foreground" /><div className="min-w-0"><dt className="text-sm text-muted-foreground">Role</dt><dd className="font-medium capitalize">{q.data.user.role}</dd></div></div>
              </dl>
              <Button variant="outline" className="w-full sm:w-auto sm:self-start" onClick={() => void logout().then(() => navigate("/login", { replace: true }))}><LogOut />Sign out</Button>
            </Card>
          </motion.div>
        )}
      </div>
    </section>
  );
}
