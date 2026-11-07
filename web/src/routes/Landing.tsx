// Landing (SPEC 5.1).
import { Link } from "react-router";
import { Stamp } from "../components/bits";

export function Landing() {
  return (
    <div>
      <section className="pt-6 pb-10">
        <h1 className="display text-[clamp(3.2rem,15vw,5.6rem)] leading-[0.9]">The commissioner can't touch the money.</h1>
        <p className="mt-4 max-w-[34rem] text-lg">
          Commish holds your league's dues and pays winners automatically from your Sleeper results.
        </p>
        <div className="mt-6 flex flex-wrap gap-3">
          <Link to="/new" className="btn btn-money">Start a league</Link>
          <Link to="/demo" className="btn btn-ghost">See a demo league</Link>
        </div>
      </section>

      <SampleReceipt />

      <section aria-labelledby="steps-h" className="mt-14">
        <h2 id="steps-h" className="display text-3xl">Three steps, then nothing to do</h2>
        <ol className="mt-4 space-y-5">
          <Step n={1} title="Pay in" icon={<IconCoin />}>
            Everyone pays dues into the league's own vault. The pot is live for the whole league to see.
          </Step>
          <Step n={2} title="Play" icon={<IconField />}>
            Play your season on Sleeper as usual. Commish reads the public scores.
          </Step>
          <Step n={3} title="Get paid automatically" icon={<IconCheck />}>
            Weekly high scores and the season split pay out on their own, with a receipt anyone can check.
          </Step>
        </ol>
        <Link to="/how" className="mt-6 inline-flex min-h-11 items-center font-bold underline underline-offset-4">How it works</Link>
      </section>
    </div>
  );
}

function SampleReceipt() {
  return (
    <figure aria-label="A sample receipt" className="stub mx-auto max-w-[26rem] rotate-[-1.2deg] p-4 pb-0 shadow-[0_18px_40px_-24px_rgba(20,33,61,0.45)]">
      <h2 className="display text-2xl">Week 9 high score</h2>
      <p className="text-sm text-muted">Armchair Football League</p>
      <div className="flex items-center gap-3 py-3">
        <span aria-hidden className="inline-grid size-11 place-items-center rounded-full bg-board font-display font-extrabold text-lamp">TB</span>
        <div className="min-w-0 flex-1">
          <p className="font-bold">That Bear Guy</p>
          <p className="tnum text-sm text-muted">216.50 pts</p>
        </div>
        <span className="display tnum text-[1.7rem]">$5.00</span>
      </div>
      <div className="perf -mx-4 flex items-center justify-between px-4 py-3">
        <span className="mono text-muted">enclave-checked</span>
        <Stamp kind="paid">Paid</Stamp>
      </div>
    </figure>
  );
}

function Step({ n, title, icon, children }: { n: number; title: string; icon: React.ReactNode; children: React.ReactNode }) {
  return (
    <li className="flex gap-4">
      <span className="grid size-12 shrink-0 place-items-center rounded-2xl bg-board text-lamp" aria-hidden>{icon}</span>
      <div>
        <h3 className="display text-2xl">
          <span className="sr-only">Step {n}: </span>
          {title}
        </h3>
        <p className="text-muted">{children}</p>
      </div>
    </li>
  );
}

const IconCoin = () => (
  <svg width="26" height="26" viewBox="0 0 26 26" fill="none" stroke="currentColor" strokeWidth="2.2"><circle cx="13" cy="13" r="9.5" /><path d="M13 7.5v11M10 10.2c0-1.2 1.3-1.9 3-1.9s3 .7 3 1.9-1.3 1.6-3 1.9-3 .7-3 1.9 1.3 1.9 3 1.9 3-.7 3-1.9" /></svg>
);
const IconField = () => (
  <svg width="26" height="26" viewBox="0 0 26 26" fill="none" stroke="currentColor" strokeWidth="2.2"><rect x="3" y="5" width="20" height="16" rx="2.5" /><path d="M13 5v16M8 9v8M18 9v8" /></svg>
);
const IconCheck = () => (
  <svg width="26" height="26" viewBox="0 0 26 26" fill="none" stroke="currentColor" strokeWidth="2.4"><path d="M5 13.5l5 5L21 7.5" /></svg>
);
