// "Check the math": recompute a settlement from live Sleeper data with settle-core and compare
// it with what the contract stored. Same checks as `commish verify --settlement`.
import type { Settlement } from "./contract.js";
import { points } from "./format.js";
import { runJob, sha256Hex, type Fetcher, type JobInput, type JobOutput, type SettleCore } from "./settle-core.js";

export interface CheckResult {
  /** The math and the bytes match: identical result. */
  matches: boolean;
  /** The input rebuilt from the contract hashes to the stored input_sha256. */
  inputOk: boolean;
  /** SHA-256 of the recomputed output equals the stored result_sha256 (and the attested output hash). */
  resultOk: boolean;
  /** Sleeper's data is byte-for-byte what the enclave saw. */
  sourceOk: boolean;
  /** Human-readable differences in scores, payouts or placements. */
  diffs: string[];
  recomputed: JobOutput;
  recomputedSha256: string;
}

export async function checkMath(core: SettleCore, s: Settlement, inputText: string, fetcher: Fetcher): Promise<CheckResult> {
  const input = JSON.parse(inputText) as JobInput;
  const inputOk = (await sha256Hex(inputText)) === s.input_sha256;
  const { text, output } = await runJob(core, input, fetcher, s.attestation_ref);
  const recomputedSha256 = await sha256Hex(text);
  const resultOk = !!s.result_sha256 && recomputedSha256 === s.result_sha256;
  const diffs: string[] = [];
  if (output.error) diffs.push(`${output.error.code}: ${output.error.message}`);
  for (const sc of output.scores) {
    const chain = s.scores.find((x) => x.roster_id === sc.roster_id);
    if (!chain) diffs.push(`Team ${sc.roster_id} has no score on the receipt`);
    else if (chain.points_x100 !== sc.points_x100) {
      diffs.push(`Team ${sc.roster_id}: ${points(chain.points_x100)} on the receipt, ${points(sc.points_x100)} on Sleeper now`);
    }
  }
  if (output.kind === "weekly_high_score") {
    const chainPay = s.payouts.map((p) => `${p.roster_id}:${p.amount}`).join(",");
    const ourPay = output.payouts.map((p) => `${p.roster_id}:${p.amount}`).join(",");
    if (chainPay !== ourPay) diffs.push(`Winners: ${chainPay || "none"} on the receipt, ${ourPay || "none"} now`);
  } else {
    const a = s.placements.map((p) => `${p.place}:${p.roster_id}`).join(",");
    const b = (output.placements ?? []).map((p) => `${p.place}:${p.roster_id}`).join(",");
    if (a !== b) diffs.push(`Places: ${a} on the receipt, ${b} now`);
  }
  const sourceOk = output.source?.sha256 === s.source_sha256;
  return { matches: resultOk && diffs.length === 0, inputOk, resultOk, sourceOk, diffs, recomputed: output, recomputedSha256 };
}
