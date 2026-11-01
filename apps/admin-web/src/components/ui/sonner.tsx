import { Toaster as Sonner, type ToasterProps } from "sonner";
import { useTheme } from "@/components/theme";

/** Toasts: bottom-center on phones (thumb reach), bottom-right on desktop. */
function Toaster(props: ToasterProps) {
  const { resolved } = useTheme();
  return (
    <Sonner
      theme={resolved}
      position="bottom-right"
      mobileOffset={{ bottom: 88 }}
      toastOptions={{ classNames: { toast: "!rounded-xl !border !border-border !bg-popover !text-popover-foreground !shadow-lg !font-sans", description: "!text-muted-foreground" } }}
      {...props}
    />
  );
}
export { Toaster };
export { toast } from "sonner";
