import { useEffect, useMemo, useRef, useState, useCallback } from "preact/hooks";
import type { Chat, ChatState } from "./chat";
import { Blocks, FieldInput, type Interact } from "./render/Blocks";
import { normalize, safeUrl } from "./render/normalize";
import { renderTurnstile } from "./turnstile";
import type { ChatMessage, PreChatField, WidgetRuntimeConfig } from "./types";

function useChat(chat: Chat): ChatState {
  const [s, setS] = useState(chat.state);
  useEffect(() => chat.subscribe(() => setS(chat.state)), [chat]);
  return s;
}

/** Pick black/white text for a tenant-provided brand colour (WCAG contrast). */
export function readableOn(hex: string): string {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return "#fff";
  const n = parseInt(m[1]!, 16);
  const lin = (c: number) => ((c /= 255) <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  const L = 0.2126 * lin((n >> 16) & 255) + 0.7152 * lin((n >> 8) & 255) + 0.0722 * lin(n & 255);
  return L > 0.4 ? "#14161f" : "#fff";
}
const mixHex = (a: string, b: string) => {
  const x = parseInt(a.slice(1), 16), y = parseInt(b.slice(1), 16);
  const ch = (sh: number) => Math.round((((x >> sh) & 255) + ((y >> sh) & 255)) / 2);
  return `#${((ch(16) << 16) | (ch(8) << 8) | ch(0)).toString(16).padStart(6, "0")}`;
};
/** CSS variables for the brand fill. `--c` is the solid accent (mid colour for gradients), `--cbg` the fill, `--c-fg` the text on it. Old configs fall back to a solid `primaryColor`. */
export function brandStyle(cfg: Pick<WidgetRuntimeConfig, "primaryColor" | "appearance"> | undefined): Record<string, string> {
  const ap = cfg?.appearance;
  const c1 = safeColor(ap?.color ?? cfg?.primaryColor, "#4f46e5");
  const c2 = ap?.mode === "gradient" && ap.color2 && /^#[0-9a-f]{6}$/i.test(ap.color2) ? ap.color2 : undefined;
  if (!c2) return { "--c": c1, "--cbg": c1, "--c-fg": readableOn(c1) };
  const mid = mixHex(c1, c2);
  const angle = Math.min(360, Math.max(0, Math.round(Number.isFinite(ap?.angle) ? (ap!.angle as number) : 135)));
  return { "--c": mid, "--cbg": `linear-gradient(${angle}deg, ${c1}, ${c2})`, "--c-fg": readableOn(mid) };
}
export const safeColor = (c: string | undefined, d: string) => (c && /^#[0-9a-f]{6}$/i.test(c) ? c : d);

const Icon = ({ d }: { d: string }) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <path d={d} />
  </svg>
);

const FOCUSABLE = 'button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),a[href],[tabindex]:not([tabindex="-1"])';

export function App({ chat, startOpen, root }: { chat: Chat; startOpen?: boolean; root: ShadowRoot }) {
  const s = useChat(chat);
  const [open, setOpen] = useState(!!startOpen);
  const panel = useRef<HTMLDivElement>(null);
  const launcher = useRef<HTMLButtonElement>(null);
  const cfg = s.config;

  useEffect(() => {
    if (open) void chat.init();
  }, [open]);

  // Focus management: move into panel on open, return to launcher on close.
  const wasOpen = useRef(false);
  useEffect(() => {
    if (open) {
      requestAnimationFrame(() => (panel.current?.querySelector<HTMLElement>("textarea,input,select,button") ?? panel.current)?.focus());
    } else if (wasOpen.current) launcher.current?.focus();
    wasOpen.current = open;
  }, [open, s.phase]);

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === "Escape") return setOpen(false);
    if (e.key !== "Tab" || !panel.current) return;
    const items = [...panel.current.querySelectorAll<HTMLElement>(FOCUSABLE)];
    if (!items.length) return;
    const first = items[0]!, last = items[items.length - 1]!;
    const active = root.activeElement;
    if (e.shiftKey && (active === first || !panel.current.contains(active))) (e.preventDefault(), last.focus());
    else if (!e.shiftKey && active === last) (e.preventDefault(), first.focus());
  };

  const style = brandStyle(cfg);
  const logo = safeUrl(cfg?.logoUrl);

  return (
    <div class={`y-root ${cfg?.position ?? "right"} ${cfg?.theme ?? "light"}`} style={style}>
      {open && (
        <div class="y-panel" role="dialog" aria-modal="true" aria-label={cfg?.title ?? "Chat"} ref={panel} onKeyDown={onKeyDown} tabIndex={-1}>
          <header class="y-head">
            {logo && <img src={logo} alt="" referrerpolicy="origin" />}
            <h2>{cfg?.title ?? "Chat"}{cfg?.subtitle && <small class="y-sub">{cfg.subtitle}</small>}</h2>
            {s.phase === "ready" && s.conn !== "live" && <span class="y-st">{s.conn === "offline" ? "Offline" : "Reconnecting…"}</span>}
            <button class="y-x" type="button" aria-label="Close chat" onClick={() => setOpen(false)}>
              <Icon d="M6 6l12 12M18 6L6 18" />
            </button>
          </header>
          {s.phase === "loading" && <div class="y-center" role="status">Loading…</div>}
          {s.phase === "error" && (
            <div class="y-center" role="alert">
              <span>We couldn't load the chat.</span>
              <button class="y-primary" type="button" onClick={() => void chat.retry()}>Try again</button>
            </div>
          )}
          {s.phase === "prechat" && cfg?.preChat && <PreChat intro={cfg.preChat.intro} fields={cfg.preChat.fields} onSubmit={(v) => void chat.submitPreChat(v)} />}
          {s.phase === "verify" && cfg?.protection?.turnstile && <Verify o={cfg.protection.turnstile} onToken={(t) => void chat.submitVerification(t)} />}
          {s.phase === "closed" && <div class="y-center" role="alert"><span>This conversation has ended.</span></div>}
          {cfg?.protection?.honeypot !== false && (s.phase === "prechat" || s.phase === "verify" || s.phase === "ready") && (
            <div class="y-hp" aria-hidden="true">
              <input type="text" name="website" tabIndex={-1} autoComplete="off" onInput={(e) => chat.setHoneypot(e.currentTarget.value)} />
            </div>
          )}
          {s.phase === "ready" && cfg?.unavailable && <div class="y-off" role="status">This assistant is offline right now. Leave a message and a team member will reply.</div>}
          {s.phase === "ready" && <Conversation chat={chat} s={s} />}
        </div>
      )}
      <button
        class="y-launch"
        type="button"
        ref={launcher}
        aria-label={cfg?.launcherLabel ?? (open ? "Close chat" : "Open chat")}
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        style={open ? { display: "none" } : undefined}
      >
        <Icon d="M21 12a8 8 0 0 1-11.6 7.1L4 20l1-4.6A8 8 0 1 1 21 12z" />
      </button>
    </div>
  );
}

function Verify({ o, onToken }: { o: NonNullable<NonNullable<WidgetRuntimeConfig["protection"]>["turnstile"]>; onToken(t: string): void }) {
  const box = useRef<HTMLDivElement>(null);
  const [failed, setFailed] = useState(0);
  const [error, setError] = useState(false);
  useEffect(() => {
    if (!box.current) return;
    setError(false);
    return renderTurnstile(box.current, o, { onToken, onError: () => setError(true), onExpire: () => {} });
  }, [failed]);
  return (
    <div class="y-center">
      <span>Please confirm you are human to start the chat.</span>
      <div ref={box} />
      {error && (
        <>
          <span role="alert">The check could not load.</span>
          <button class="y-primary" type="button" onClick={() => setFailed(failed + 1)}>Try again</button>
        </>
      )}
    </div>
  );
}

function PreChat({ intro, fields, onSubmit }: { intro?: string; fields: PreChatField[]; onSubmit(v: Record<string, string>): void }) {
  const [errors, setErrors] = useState<Record<string, string>>({});
  function submit(e: Event) {
    e.preventDefault();
    const fd = new FormData(e.currentTarget as HTMLFormElement);
    const v: Record<string, string> = {};
    const errs: Record<string, string> = {};
    for (const f of fields) {
      v[f.name] = String(fd.get(f.name) ?? "").trim();
      if (f.required && !v[f.name]) errs[f.name] = "This field is required";
      else if (v[f.name] && f.kind === "email" && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(v[f.name]!)) errs[f.name] = "Enter a valid email address";
    }
    setErrors(errs);
    if (Object.keys(errs).length) return void (e.currentTarget as HTMLElement).querySelector<HTMLElement>("[aria-invalid=true]")?.focus();
    onSubmit(v);
  }
  return (
    <form class="y-prechat" onSubmit={submit} noValidate>
      <p>{intro ?? "Tell us a little about you so we can help."}</p>
      {fields.map((f) => (
        <FieldInput f={f} id={`pc-${f.name}`} error={errors[f.name]} key={f.name} />
      ))}
      <button class="y-primary" type="submit">Start chat</button>
    </form>
  );
}

function MessageView({ m, ix, chat }: { m: ChatMessage; ix: Interact; chat: Chat }) {
  const blocks = useMemo(() => normalize(m.ui, m.text, m.id), [m.ui, m.text, m.id]);
  const mine = m.role === "user";
  const interactive = blocks.filter((b) => b.type !== "message");
  const texts = blocks.filter((b) => b.type === "message");
  return (
    <div class={`y-msg ${mine ? "user" : ""}`}>
      {!mine && m.role === "human" && <span class="y-who">Team member</span>}
      {texts.length > 0 && (
        <div class="y-bubble">
          <Blocks blocks={texts} ix={ix} />
        </div>
      )}
      {interactive.length > 0 && <Blocks blocks={interactive} ix={ix} />}
      {m.state === "sending" && <span class="y-meta">Sending…</span>}
      {m.state === "failed" && (
        <span class="y-meta" role="alert">
          Not delivered. <button type="button" onClick={() => chat.retryFailed()}>Retry</button>
        </span>
      )}
    </div>
  );
}

function Conversation({ chat, s }: { chat: Chat; s: ChatState }) {
  const log = useRef<HTMLDivElement>(null);
  const [text, setText] = useState("");
  const ta = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    const el = log.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [s.messages.length, s.typing]);

  const ix: Interact = useMemo(
    () => ({
      answered: s.answered,
      emit: (key, kind, payload, componentId) => {
        const mid = s.messages.find((m) => key.startsWith(m.id + ":"))?.id ?? "";
        return chat.sendUiEvent(key, { messageId: mid, componentId: componentId.slice(componentId.indexOf(":") + 1), kind, payload });
      },
    }),
    [s.answered, s.messages, chat],
  );

  const submit = useCallback(() => {
    if (!text.trim()) return;
    chat.send(text);
    setText("");
    if (ta.current) ta.current.style.height = "auto";
  }, [text, chat]);

  return (
    <>
      {s.conn === "offline" && <div class="y-banner" role="status">You're offline. Messages will send when you reconnect.</div>}
      {/* aria-live log: new messages are announced politely */}
      <div class="y-log" ref={log} role="log" aria-live="polite" aria-relevant="additions" aria-label="Conversation" tabIndex={0}>
        {s.messages.map((m) => (
          <MessageView m={m} ix={ix} chat={chat} key={m.id} />
        ))}
        {s.typing && (
          <div class="y-typing" aria-label="Assistant is typing" role="status">
            <i /><i /><i />
          </div>
        )}
      </div>
      <form
        class="y-compose"
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <textarea
          ref={ta}
          rows={1}
          maxLength={4000}
          value={text}
          aria-label="Message"
          placeholder={chat.state.config?.placeholder ?? "Type a message…"}
          onInput={(e) => {
            chat.notifyTyping();
            const t = e.currentTarget;
            setText(t.value);
            t.style.height = "auto";
            t.style.height = Math.min(t.scrollHeight, 110) + "px";
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
              e.preventDefault();
              submit();
            }
          }}
        />
        <button class="y-send" type="submit" aria-label="Send message" disabled={!text.trim()}>
          <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <path d="M22 2L11 13M22 2l-7 20-4-9-9-4z" />
          </svg>
        </button>
      </form>
    </>
  );
}
