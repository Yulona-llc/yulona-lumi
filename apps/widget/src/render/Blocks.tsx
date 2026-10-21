import { useMemo, useState } from "preact/hooks";
import { linkify } from "./linkify";
import type { Action, Block, Field } from "./normalize";

export interface Interact {
  /** Returns true when delivered; component locks on success. */
  emit(key: string, kind: "form" | "calendar" | "button", payload: Record<string, unknown>, componentId: string): Promise<boolean>;
  answered: Record<string, true>;
}

export function Blocks({ blocks, ix }: { blocks: Block[]; ix: Interact }) {
  return (
    <>
      {blocks.map((b) => {
        switch (b.type) {
          case "message":
            return <p class="y-text" key={b.key}>{linkify(b.text)}</p>;
          case "buttons":
            return <ButtonRow key={b.key} id={b.key} buttons={b.buttons} ix={ix} />;
          case "card":
            return (
              <article class="y-card" key={b.key}>
                {b.imageUrl && <img src={b.imageUrl} alt="" loading="lazy" referrerpolicy="no-referrer" />}
                <h4>{b.title}</h4>
                {b.body && <p>{linkify(b.body)}</p>}
                {b.actions.length > 0 && <ButtonRow id={b.key} buttons={b.actions} ix={ix} />}
              </article>
            );
          case "form":
            return <FormBlock key={b.key} b={b} ix={ix} />;
          case "calendar":
            return <CalendarBlock key={b.key} b={b} ix={ix} />;
        }
      })}
    </>
  );
}

function ButtonRow({ id, buttons, ix }: { id: string; buttons: Action[]; ix: Interact }) {
  const done = !!ix.answered[id];
  const [picked, setPicked] = useState<string>();
  return (
    <div class="y-btns" role="group" aria-label="Quick replies">
      {buttons.map((b) => (
        <button
          type="button"
          class="y-chip"
          disabled={done}
          aria-pressed={picked === b.value}
          onClick={async () => {
            setPicked(b.value);
            const ok = await ix.emit(id, "button", { value: b.value, label: b.label }, id);
            if (!ok) setPicked(undefined);
          }}
        >
          {b.label}
        </button>
      ))}
    </div>
  );
}

const INPUT_TYPE: Record<string, string> = { text: "text", email: "email", phone: "tel" };

function FormBlock({ b, ix }: { b: Extract<Block, { type: "form" }>; ix: Interact }) {
  const done = !!ix.answered[b.key];
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);

  async function submit(e: Event) {
    e.preventDefault();
    const fd = new FormData(e.currentTarget as HTMLFormElement);
    const values: Record<string, string> = {};
    const errs: Record<string, string> = {};
    for (const f of b.fields) {
      const v = String(fd.get(f.name) ?? "").trim();
      values[f.name] = v;
      if (f.required && !v) errs[f.name] = "This field is required";
      else if (v && f.kind === "email" && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(v)) errs[f.name] = "Enter a valid email address";
    }
    setErrors(errs);
    if (Object.keys(errs).length) {
      (e.currentTarget as HTMLFormElement).querySelector<HTMLElement>("[aria-invalid=true]")?.focus();
      return;
    }
    setBusy(true);
    setFailed(false);
    const ok = await ix.emit(b.key, "form", values, b.key);
    setBusy(false);
    setFailed(!ok);
  }

  return (
    <form class="y-form" onSubmit={submit} noValidate aria-label="Form">
      {b.fields.map((f) => (
        <FieldInput key={f.name} f={f} id={`${b.key}-${f.name}`} error={errors[f.name]} disabled={done || busy} />
      ))}
      {failed && <p class="y-err" role="alert">Could not send. Please try again.</p>}
      <button class="y-primary" type="submit" disabled={done || busy}>
        {done ? "Sent" : busy ? "Sending…" : b.submitLabel}
      </button>
    </form>
  );
}

export function FieldInput({ f, id, error, disabled }: { f: Pick<Field, "name" | "label" | "kind"> & { required?: boolean; options?: string[] }; id: string; error?: string; disabled?: boolean }) {
  const eid = `${id}-e`;
  const common = {
    id,
    name: f.name,
    required: f.required,
    disabled,
    "aria-invalid": error ? "true" : undefined,
    "aria-describedby": error ? eid : undefined,
  } as const;
  return (
    <div class="y-field">
      <label for={id}>
        {f.label}
        {f.required && <span aria-hidden="true"> *</span>}
      </label>
      {f.kind === "textarea" ? (
        <textarea {...common} rows={3} maxLength={2000} />
      ) : f.kind === "select" ? (
        <select {...common}>
          <option value="">Select…</option>
          {(f.options ?? []).map((o) => (
            <option value={o}>{o}</option>
          ))}
        </select>
      ) : (
        <input {...common} type={INPUT_TYPE[f.kind] ?? "text"} maxLength={200} autocomplete={f.kind === "email" ? "email" : f.kind === "phone" ? "tel" : undefined} />
      )}
      {error && (
        <span class="y-err" id={eid}>
          {error}
        </span>
      )}
    </div>
  );
}

function fmt(tz: string, opts: Intl.DateTimeFormatOptions, d: Date) {
  try {
    return new Intl.DateTimeFormat(undefined, { timeZone: tz, ...opts }).format(d);
  } catch {
    return new Intl.DateTimeFormat(undefined, { timeZone: "UTC", ...opts }).format(d);
  }
}

function CalendarBlock({ b, ix }: { b: Extract<Block, { type: "calendar" }>; ix: Interact }) {
  const done = !!ix.answered[b.key];
  const days = useMemo(() => {
    const m = new Map<string, { label: string; slots: { start: string; end: string }[] }>();
    [...b.slots]
      .sort((a, c) => Date.parse(a.start) - Date.parse(c.start))
      .forEach((s) => {
        const d = new Date(s.start);
        const k = fmt(b.timezone, { year: "numeric", month: "2-digit", day: "2-digit" }, d);
        if (!m.has(k)) m.set(k, { label: fmt(b.timezone, { weekday: "short", month: "short", day: "numeric" }, d), slots: [] });
        m.get(k)!.slots.push(s);
      });
    return [...m.entries()];
  }, [b.slots, b.timezone]);
  const [day, setDay] = useState(0);
  const [picked, setPicked] = useState<string>();
  const [failed, setFailed] = useState(false);
  const cur = days[Math.min(day, days.length - 1)];
  if (!cur) return null;

  return (
    <section class="y-cal" aria-label="Pick a time">
      <div class="y-days" role="tablist" aria-label="Day">
        {days.map(([k, d], i) => (
          <button
            type="button"
            role="tab"
            class="y-chip"
            aria-selected={i === day}
            id={`${b.key}-t${i}`}
            tabIndex={i === day ? 0 : -1}
            onClick={() => setDay(i)}
            onKeyDown={(e) => {
              const n = e.key === "ArrowRight" ? 1 : e.key === "ArrowLeft" ? -1 : 0;
              if (!n) return;
              e.preventDefault();
              const j = (i + n + days.length) % days.length;
              setDay(j);
              (e.currentTarget.parentElement?.children[j] as HTMLElement | undefined)?.focus();
            }}
            key={k}
          >
            {d.label}
          </button>
        ))}
      </div>
      <div class="y-slots" role="tabpanel" aria-labelledby={`${b.key}-t${day}`}>
        {cur[1].slots.map((s) => {
          const label = fmt(b.timezone, { hour: "numeric", minute: "2-digit" }, new Date(s.start));
          return (
            <button
              type="button"
              class="y-chip"
              disabled={done}
              aria-pressed={picked === s.start}
              key={s.start}
              onClick={async () => {
                setPicked(s.start);
                setFailed(false);
                const ok = await ix.emit(b.key, "calendar", { start: s.start, end: s.end, timezone: b.timezone }, b.key);
                if (!ok) {
                  setPicked(undefined);
                  setFailed(true);
                }
              }}
            >
              {label}
            </button>
          );
        })}
      </div>
      <p class="y-hint">Times shown in {b.timezone.replace(/_/g, " ")}</p>
      {failed && <p class="y-err" role="alert">Could not book that slot. Please try again.</p>}
    </section>
  );
}
