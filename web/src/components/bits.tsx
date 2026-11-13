// Small shared pieces: avatars, the status stamp, the Details drawer, the pot scoreboard.
import { useEffect, useRef, useState, type ReactNode } from "react";
import { dollars } from "@commish/shared";

export function Avatar({ src, name, size = 40, dim = false }: { src: string | null | undefined; name: string; size?: number; dim?: boolean }) {
  const [broken, setBroken] = useState(false);
  const initials = name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]!.toUpperCase())
    .join("");
  const style = { width: size, height: size, opacity: dim ? 0.4 : 1 };
  if (!src || broken) {
    return (
      <span
        aria-hidden
        style={{ ...style, fontSize: size * 0.38 }}
        className="inline-grid shrink-0 place-items-center rounded-full bg-board font-display text-lamp"
      >
        {initials || "?"}
      </span>
    );
  }
  return <img src={src} alt="" width={size} height={size} style={style} onError={() => setBroken(true)} className="shrink-0 rounded-full bg-line object-cover" loading="lazy" />;
}

export type StampKind = "paid" | "hold" | "stop" | "muted";

/** Rubber-stamp status chip. It flips when its label changes (e.g. On hold → Paid). */
export function Stamp({ kind, children }: { kind: StampKind; children: ReactNode }) {
  const label = typeof children === "string" ? children : "";
  const prev = useRef(label);
  const [flip, setFlip] = useState(false);
  useEffect(() => {
    if (prev.current && prev.current !== label) {
      setFlip(true);
      const t = setTimeout(() => setFlip(false), 800);
      prev.current = label;
      return () => clearTimeout(t);
    }
    prev.current = label;
  }, [label]);
  const cls = { paid: "stamp-paid", hold: "stamp-hold", stop: "stamp-stop", muted: "stamp-muted" }[kind];
  return <span className={`stamp ${cls} ${flip ? "stamp-flip" : ""}`}>{children}</span>;
}

export function Details({ summary = "Details", children }: { summary?: string; children: ReactNode }) {
  return (
    <details className="group">
      <summary className="flex min-h-11 cursor-pointer list-none items-center gap-2 font-bold text-muted select-none [&::-webkit-details-marker]:hidden">
        <svg aria-hidden width="14" height="14" viewBox="0 0 14 14" className="transition-transform group-open:rotate-90">
          <path d="M4 2l6 5-6 5" fill="none" stroke="currentColor" strokeWidth="2" />
        </svg>
        {summary}
      </summary>
      <div className="mt-2 space-y-2 text-sm">{children}</div>
    </details>
  );
}

/** A labelled fact row inside Details: plain label, monospace value, optional link. */
export function Fact({ label, value, href }: { label: string; value: string; href?: string }) {
  return (
    <div className="grid grid-cols-[7.5rem_1fr] gap-x-3 gap-y-0.5">
      <span className="text-muted">{label}</span>
      {href ? (
        <a href={href} target="_blank" rel="noreferrer" className="mono break-all text-ink underline decoration-line underline-offset-4 hover:decoration-ink">
          {value}
        </a>
      ) : (
        <span className="mono break-all">{value}</span>
      )}
    </div>
  );
}

function prefersReducedMotion() {
  return typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
}

/** Counts from the previous value to `value` (token units) in about a second. */
function useCountUp(value: bigint): bigint {
  const [shown, setShown] = useState(value);
  const from = useRef(value);
  useEffect(() => {
    const start = from.current;
    if (start === value || prefersReducedMotion()) {
      from.current = value;
      setShown(value);
      return;
    }
    const t0 = performance.now();
    let raf = 0;
    const step = (t: number) => {
      const k = Math.min(1, (t - t0) / 900);
      const eased = 1 - Math.pow(1 - k, 3);
      setShown(start + ((value - start) * BigInt(Math.round(eased * 1000))) / 1000n);
      if (k < 1) raf = requestAnimationFrame(step);
      else from.current = value;
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [value]);
  return shown;
}

/** The pot, as a scoreboard: each digit in its own lamp slot. */
export function Scoreboard({ units, size = "clamp(3.25rem, 17vw, 5.5rem)", label }: { units: bigint; size?: string; label: string }) {
  const shown = useCountUp(units);
  const text = dollars(shown);
  return (
    <div className="lamp-digits" style={{ fontSize: size }} role="img" aria-label={`${label}: ${dollars(units)}`}>
      {[...text].map((ch, i) => (
        <span key={i} className={/\d/.test(ch) ? "slot" : "slot sep"} aria-hidden>
          {ch}
        </span>
      ))}
    </div>
  );
}

export function ErrorNote({ error }: { error: unknown }) {
  if (!error) return null;
  const msg = error instanceof Error ? error.message : String(error);
  return (
    <p role="alert" className="rounded-xl border-2 border-stop/40 bg-stop-tint px-3 py-2 text-sm font-bold text-stop">
      {msg}
    </p>
  );
}

export function Spinner({ label }: { label?: string }) {
  return (
    <span className="inline-flex items-center gap-2 text-muted">
      <span className="spinner" aria-hidden />
      {label && <span>{label}</span>}
    </span>
  );
}
