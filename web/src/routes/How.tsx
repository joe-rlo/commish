// How it works (SPEC 5.6).
import { Link } from "react-router";

export function How() {
  return (
    <article className="max-w-[40rem] pt-4">
      <h1 className="display text-[3rem] leading-none">How it works</h1>

      <Flow />

      <Section title="Where the money sits">
        Each league gets its own vault: a Sputnik DAO on NEAR. Dues go straight into it. Commish's contract never keeps the money; it
        forwards each payment to the vault in the same step. Nobody can withdraw from the vault alone, not the commissioner and not Commish.
      </Section>

      <Section title="Who decides the payouts">
        Your league's results on Sleeper, read by a small program that runs inside a secure enclave (OutLayer, on Intel TDX hardware). The
        enclave fetches the public scores, applies your league's rules, and signs a record of the code it ran, what it read and what it
        returned. The contract only accepts results from that exact build.
      </Section>

      <Section title="What the hold window is for">
        Every payout waits out a hold window (24 hours by default) before the vault pays it. During the hold, a majority of the league's teams
        can vote to stop it, for example after a stat correction. Once the hold is over, anyone can release the payout.
      </Section>

      <Section title="What the league can vote on">
        The vault's members are the commissioner and every approved team. Votes need a majority of the league's teams (7 in a 12-team
        league), so the commissioner and a friend can't decide alone. That majority can stop a payout or vote to do anything else with the
        vault, including firing Commish. It's your league's money.
      </Section>

      <Section title="Check it yourself">
        Every receipt has a "Check the math" button that runs the same payout code in your browser against live Sleeper data. Developers can run
        it from the command line too: <code className="mono">pnpm commish verify --settlement 0:w3</code>.
      </Section>

      <Section title="What you still trust">
        Sleeper for the scores, OutLayer and Intel for running the enclave honestly, the open-source Commish contract for following its rules,
        and your league's majority for overrides. Team claims are approved by the commissioner, because Sleeper can't prove who owns a team:
        check that every team on the league page belongs to who you think.
        Sleeper can correct stats after a week settles; the hold window and the 36-hour wait reduce that risk but don't remove it.
      </Section>

      <p className="mt-8 rounded-xl border-2 border-hold bg-hold-tint px-3 py-2 text-sm font-bold text-hold">
        This is a NEAR testnet demo with test money. Paid fantasy is regulated differently by state and country.
      </p>
      <div className="mt-6 flex flex-wrap gap-3">
        <Link to="/demo" className="btn btn-money">See a demo league</Link>
        <Link to="/new" className="btn btn-ghost">Start a league</Link>
      </div>
    </article>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="mt-8">
      <h2 className="display text-3xl">{title}</h2>
      <p className="mt-2 leading-relaxed">{children}</p>
    </section>
  );
}

/** Members → (Intents) → vault; Sleeper → enclave → payout → vault → winner. */
function Flow() {
  const box = "fill-[var(--surface)] stroke-[var(--line)]";
  const text = "fill-[var(--ink)] font-sans text-[13px] font-bold";
  const sub = "fill-[var(--muted)] font-sans text-[11px]";
  return (
    <figure className="mt-6">
      <svg viewBox="0 0 340 430" className="w-full max-w-[26rem]" role="img" aria-labelledby="flow-t flow-d">
        <title id="flow-t">How the money moves</title>
        <desc id="flow-d">
          Members pay dues in USDC, or in any token through NEAR Intents, into the league vault. Sleeper's scores go to the enclave, which
          computes the payout. The payout waits on hold, then the vault pays the winner.
        </desc>
        <defs>
          <marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
            <path d="M0 0L10 5L0 10z" fill="var(--muted)" />
          </marker>
        </defs>
        {/* money in (left column) */}
        <rect x="10" y="10" width="150" height="54" rx="12" className={box} strokeWidth="2" />
        <text x="85" y="34" textAnchor="middle" className={text}>Members</text>
        <text x="85" y="51" textAnchor="middle" className={sub}>pay dues</text>
        <rect x="56" y="104" width="104" height="54" rx="12" className={box} strokeWidth="2" strokeDasharray="5 4" />
        <text x="108" y="128" textAnchor="middle" className={text}>NEAR Intents</text>
        <text x="108" y="145" textAnchor="middle" className={sub}>any token</text>
        {/* scores (right column) */}
        <rect x="180" y="10" width="150" height="54" rx="12" className={box} strokeWidth="2" />
        <text x="255" y="34" textAnchor="middle" className={text}>Sleeper</text>
        <text x="255" y="51" textAnchor="middle" className={sub}>public scores</text>
        <rect x="180" y="104" width="150" height="54" rx="12" className={box} strokeWidth="2" />
        <text x="255" y="128" textAnchor="middle" className={text}>Enclave</text>
        <text x="255" y="145" textAnchor="middle" className={sub}>computes, attests</text>
        <rect x="180" y="198" width="150" height="54" rx="12" className={box} strokeWidth="2" />
        <text x="255" y="222" textAnchor="middle" className={text}>Payout</text>
        <text x="255" y="239" textAnchor="middle" className={sub}>on hold; league can stop it</text>
        {/* vault + winner */}
        <rect x="10" y="290" width="320" height="64" rx="14" fill="var(--board)" />
        <text x="170" y="318" textAnchor="middle" className="fill-[var(--lamp)] font-display text-[22px] font-extrabold">League vault</text>
        <text x="170" y="339" textAnchor="middle" className="fill-[var(--board-dim)] font-sans text-[11px]">nobody can withdraw alone</text>
        <rect x="100" y="376" width="140" height="46" rx="12" className={box} strokeWidth="2" />
        <text x="170" y="404" textAnchor="middle" className={text}>Winner</text>
        <g stroke="var(--muted)" strokeWidth="2" fill="none" markerEnd="url(#arrow)">
          <path d="M108 64v36" />
          <path d="M108 158v128" />
          <path d="M32 64v222" />
          <path d="M255 64v36" />
          <path d="M255 158v36" />
          <path d="M255 252v34" />
          <path d="M170 354v18" />
        </g>
        <text x="24" y="210" className={sub} transform="rotate(-90 24 210)">USDC on NEAR</text>
      </svg>
    </figure>
  );
}
