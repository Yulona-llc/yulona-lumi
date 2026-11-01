import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ImagePlus, MessageCircle, Trash2 } from "lucide-react";
import type { WidgetAppearance, WidgetConfig, WidgetDto } from "@yulona/shared";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { toast } from "@/components/ui/sonner";
import { cn } from "@/lib/utils";
import { Spinner } from "../../components/ui";
import { ag, errMsg } from "../common/api";
import { ANGLES, GRADIENT_PRESETS, SOLID_SWATCHES, appearanceOf, fillOf, isHex, withAppearance } from "./brand";
import { AVATAR_TYPES, cropRect, cropToBlob } from "./crop";

/** Swatches plus a native colour picker. Nobody has to know what a hex code is. */
function ColorPicker({ label, value, onChange, disabled }: { label: string; value: string; onChange: (c: string) => void; disabled?: boolean }) {
  const known = SOLID_SWATCHES.some((s) => s.color.toLowerCase() === value.toLowerCase());
  return (
    <fieldset disabled={disabled} className="min-w-0">
      <legend className="mb-1.5 text-sm font-medium">{label}</legend>
      <div className="flex flex-wrap items-center gap-2">
        {SOLID_SWATCHES.map((s) => (
          <button key={s.color} type="button" aria-label={s.name} aria-pressed={value.toLowerCase() === s.color} title={s.name} onClick={() => onChange(s.color)}
            className={cn("size-9 rounded-full border-2 border-card shadow-sm ring-1 ring-border transition-transform hover:scale-105 disabled:opacity-60", value.toLowerCase() === s.color && "ring-2 ring-foreground")} style={{ background: s.color }} />
        ))}
        <label title="Pick another colour" className={cn("relative grid size-9 cursor-pointer place-items-center overflow-hidden rounded-full border-2 border-card shadow-sm ring-1 ring-border focus-within:ring-2 focus-within:ring-foreground", !known && "ring-2 ring-foreground")}
          style={{ background: known ? "conic-gradient(#ef4444,#f59e0b,#22c55e,#06b6d4,#6366f1,#ec4899,#ef4444)" : value }}>
          <span className="sr-only">Pick another colour</span>
          <input type="color" value={isHex(value) ? value : "#f97316"} onChange={(e) => onChange(e.target.value)} disabled={disabled} className="absolute inset-0 size-full cursor-pointer opacity-0" />
        </label>
      </div>
    </fieldset>
  );
}

function Segmented({ label, value, options, onChange, disabled }: { label: string; value: string; options: { value: string; label: string }[]; onChange: (v: string) => void; disabled?: boolean }) {
  return (
    <div role="radiogroup" aria-label={label} className="inline-flex rounded-xl border bg-muted p-1">
      {options.map((o) => (
        <button key={o.value} type="button" role="radio" aria-checked={value === o.value} disabled={disabled} onClick={() => onChange(o.value)}
          className={cn("min-h-9 rounded-lg px-4 text-sm font-medium transition-colors disabled:opacity-60", value === o.value ? "bg-card shadow-sm" : "text-muted-foreground hover:text-foreground")}>{o.label}</button>
      ))}
    </div>
  );
}

/** What the launcher, header and a visitor's message will look like, updated as colours change. */
export function BrandPreview({ a, title, avatarSrc }: { a: WidgetAppearance; title?: string; avatarSrc?: string | null }) {
  const f = fillOf(a);
  return (
    <div className="rounded-xl border bg-muted/50 p-3" aria-label="Preview of your colours" role="img">
      <div className="mx-auto flex max-w-xs flex-col gap-3">
        <div className="overflow-hidden rounded-2xl border bg-card shadow-sm">
          <div className="flex items-center gap-2.5 px-3.5 py-3" style={f}>
            {avatarSrc ? <img src={avatarSrc} alt="" className="size-8 rounded-full object-cover" /> : <span className="grid size-8 place-items-center rounded-full bg-white/25"><MessageCircle className="size-4" /></span>}
            <p className="text-sm font-semibold">{title || "Chat with us"}</p>
          </div>
          <div className="flex flex-col gap-2 p-3 text-sm">
            <p className="w-fit max-w-[85%] rounded-2xl rounded-bl-sm bg-muted px-3 py-1.5">Hi! How can we help?</p>
            <p className="ml-auto w-fit max-w-[85%] rounded-2xl rounded-br-sm px-3 py-1.5" style={f}>I'd like to book a visit</p>
          </div>
        </div>
        <div className="flex justify-end"><span className="grid size-12 place-items-center rounded-full shadow-md" style={f}><MessageCircle className="size-5" /></span></div>
      </div>
    </div>
  );
}

export function AppearanceFields({ cfg, setCfg, ro, avatarSrc }: { cfg: WidgetConfig; setCfg: (f: (c: WidgetConfig) => WidgetConfig) => void; ro: boolean; avatarSrc?: string | null }) {
  const a = appearanceOf(cfg);
  const upd = (p: Partial<WidgetAppearance>) => setCfg((c) => withAppearance(c, { ...appearanceOf(c), ...p }));
  const gradient = a.mode === "gradient";
  return (
    <div className="space-y-4">
      <BrandPreview a={a} title={cfg.title} avatarSrc={avatarSrc} />
      <Segmented label="Colour style" value={a.mode} disabled={ro} onChange={(m) => upd(m === "gradient" ? { mode: "gradient", color2: a.color2 ?? GRADIENT_PRESETS[0]!.color2 } : { mode: "solid" })}
        options={[{ value: "solid", label: "One colour" }, { value: "gradient", label: "Two colours" }]} />
      {gradient && (
        <div className="space-y-2">
          <p className="text-sm font-medium">Ready-made blends</p>
          <div className="flex flex-wrap gap-2">
            {GRADIENT_PRESETS.map((g) => (
              <button key={g.name} type="button" disabled={ro} onClick={() => upd({ mode: "gradient", color: g.color, color2: g.color2 })} className="flex min-h-9 items-center gap-2 rounded-full border bg-card py-1 pl-1 pr-3 text-sm hover:bg-muted disabled:opacity-60">
                <span className="size-7 rounded-full" style={{ background: `linear-gradient(135deg, ${g.color}, ${g.color2})` }} />{g.name}
              </button>
            ))}
          </div>
        </div>
      )}
      <div className={cn("grid gap-5", gradient && "md:grid-cols-2")}>
        <ColorPicker label={gradient ? "Start colour" : "Brand colour"} value={a.color} disabled={ro} onChange={(c) => upd({ color: c })} />
        {gradient && <ColorPicker label="End colour" value={a.color2 ?? GRADIENT_PRESETS[0]!.color2} disabled={ro} onChange={(c) => upd({ color2: c })} />}
      </div>
      {gradient && (
        <div className="space-y-1.5">
          <p className="text-sm font-medium">Direction</p>
          <div className="flex flex-wrap gap-2" role="radiogroup" aria-label="Direction">
            {ANGLES.map((g) => (
              <button key={g.angle} type="button" role="radio" aria-checked={a.angle === g.angle} disabled={ro} onClick={() => upd({ angle: g.angle })}
                className={cn("flex min-h-9 items-center gap-2 rounded-lg border px-3 text-sm disabled:opacity-60", a.angle === g.angle ? "border-foreground bg-card font-medium" : "hover:bg-muted")}>
                <span className="size-5 rounded" style={{ background: `linear-gradient(${g.angle}deg, ${a.color}, ${a.color2 ?? a.color})` }} />{g.label}
              </button>
            ))}
          </div>
        </div>
      )}
      <p className="text-sm text-muted-foreground">Text on top of your colour switches between dark and light on its own so it stays readable.</p>
    </div>
  );
}

/** Choose an image, position a square crop, and upload it straight away. The URL option lives under Advanced in the form. */
export function AvatarField({ w, ro, onChanged }: { w: WidgetDto; ro: boolean; onChanged: (w: WidgetDto) => void }) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [src, setSrc] = useState<string | null>(null);
  const q = useQuery({ queryKey: ["widget-avatar", w.id, w.avatarVersion], queryFn: () => ag.avatarUrl(w.id), enabled: w.hasAvatar, staleTime: Infinity, gcTime: 0 });
  const pick = (f: File | undefined) => {
    if (!f) return;
    if (!AVATAR_TYPES.includes(f.type)) return void toast.error("Use a PNG, JPEG or WebP picture");
    if (f.size > 12 * 1024 * 1024) return void toast.error("That picture is too large. Choose one under 12 MB.");
    setSrc(URL.createObjectURL(f));
  };
  const remove = useMutation({
    mutationFn: () => ag.removeAvatar(w.id),
    onSuccess: (r) => { onChanged(r); toast.success("Picture removed"); },
    onError: (e) => toast.error(errMsg(e)),
  });
  const shown = w.hasAvatar ? q.data : undefined;
  return (
    <div className="space-y-2">
      <p className="text-sm font-medium" id="avatar-l">Chat picture</p>
      <div className="flex flex-wrap items-center gap-4" aria-labelledby="avatar-l">
        <span className="grid size-16 shrink-0 place-items-center overflow-hidden rounded-full border bg-muted text-muted-foreground">
          {shown ? <img src={shown} alt="Current chat picture" className="size-full object-cover" /> : <ImagePlus className="size-6" />}
        </span>
        <div className="space-y-1.5">
          <div className="flex flex-wrap gap-2">
            <Button type="button" variant="outline" disabled={ro} onClick={() => fileRef.current?.click()}><ImagePlus />{w.hasAvatar ? "Change picture" : "Upload a picture"}</Button>
            {w.hasAvatar && <Button type="button" variant="ghost" disabled={ro || remove.isPending} onClick={() => remove.mutate()}>{remove.isPending ? <Spinner /> : <Trash2 />}Remove</Button>}
          </div>
          <p className="text-sm text-muted-foreground">Shown in the chat header. PNG, JPEG or WebP. You can crop it next.</p>
        </div>
        <input ref={fileRef} type="file" accept={AVATAR_TYPES.join(",")} className="sr-only" aria-label="Choose a picture" tabIndex={-1} onChange={(e) => { pick(e.target.files?.[0]); e.target.value = ""; }} />
      </div>
      {src && <CropDialog src={src} widgetId={w.id} onClose={() => { URL.revokeObjectURL(src); setSrc(null); }} onDone={(r) => { onChanged(r); toast.success("Picture saved"); }} />}
    </div>
  );
}

function CropDialog({ src, widgetId, onClose, onDone }: { src: string; widgetId: string; onClose: () => void; onDone: (w: WidgetDto) => void }) {
  const [zoom, setZoom] = useState(1);
  const [off, setOff] = useState({ x: 0, y: 0 });
  const [img, setImg] = useState<HTMLImageElement | null>(null);
  const [failed, setFailed] = useState(false);
  const drag = useRef<{ x: number; y: number; ox: number; oy: number } | null>(null);
  useEffect(() => {
    const i = new Image();
    i.onload = () => setImg(i);
    i.onerror = () => setFailed(true);
    i.src = src;
  }, [src]);
  const upload = useMutation({
    mutationFn: async () => ag.uploadAvatar(widgetId, await cropToBlob(img!, zoom, off.x, off.y)),
    onSuccess: (r) => { onDone(r); onClose(); },
    onError: (e) => toast.error(errMsg(e)),
  });
  // The preview is drawn with the same crop maths as the upload, so what you see is what is saved.
  const canvas = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const ctx = img && canvas.current && !/jsdom/i.test(navigator.userAgent) ? canvas.current.getContext("2d") : null;
    if (!ctx || !img) return;
    const { sx, sy, size } = cropRect(img.width, img.height, zoom, off.x, off.y);
    ctx.clearRect(0, 0, 224, 224);
    ctx.drawImage(img, sx, sy, size, size, 0, 0, 224, 224);
  }, [img, zoom, off]);
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-sm">
        <DialogHeader><DialogTitle>Crop your picture</DialogTitle><DialogDescription>Drag to move it. Use the slider to zoom.</DialogDescription></DialogHeader>
        {failed ? <p role="alert" className="text-sm text-destructive">That file could not be opened as a picture.</p> : (
          <canvas
            ref={canvas} width={224} height={224} aria-label="Crop preview" role="img"
            className="mx-auto size-56 cursor-grab touch-none rounded-full border bg-muted active:cursor-grabbing"
            onPointerDown={(e) => { e.currentTarget.setPointerCapture?.(e.pointerId); drag.current = { x: e.clientX, y: e.clientY, ox: off.x, oy: off.y }; }}
            onPointerMove={(e) => {
              const d = drag.current; if (!d || !img) return;
              // Dragging the picture right moves the visible window left. 224 px is the full travel of the window.
              const per = (Math.min(img.width, img.height) / zoom) / 224; // source pixels per screen pixel
              const full = (w: number, h: number) => ({ x: Math.max(1, (w - Math.min(w, h) / zoom) / 2), y: Math.max(1, (h - Math.min(w, h) / zoom) / 2) });
              const f = full(img.width, img.height);
              setOff({ x: Math.min(1, Math.max(-1, d.ox - ((e.clientX - d.x) * per) / f.x)), y: Math.min(1, Math.max(-1, d.oy - ((e.clientY - d.y) * per) / f.y)) });
            }}
            onPointerUp={() => { drag.current = null; }}
          />
        )}
        <label className="grid gap-1.5 text-sm font-medium">Zoom
          <input type="range" min={1} max={4} step={0.05} value={zoom} onChange={(e) => setZoom(Number(e.target.value))} className="h-9 w-full accent-primary" disabled={failed} />
        </label>
        <DialogFooter>
          <Button type="button" variant="ghost" onClick={onClose}>Cancel</Button>
          <Button type="button" disabled={!img || failed || upload.isPending} onClick={() => upload.mutate()}>{upload.isPending && <Spinner />}Use this picture</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function useAvatarCache() {
  const qc = useQueryClient();
  return (w: WidgetDto) => { qc.setQueryData(["widgets"], (old: WidgetDto[] | undefined) => old?.map((x) => (x.id === w.id ? w : x))); };
}
