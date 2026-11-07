// Reads `<bits> <es_number>` lines on stdin and checks each against ECMAScript String(x).
import { createInterface } from "node:readline";
const dv = new DataView(new ArrayBuffer(8));
let n = 0, bad = 0;
for await (const line of createInterface({ input: process.stdin })) {
  const [bits, got] = line.split(" ");
  dv.setBigUint64(0, BigInt("0x" + bits));
  const want = String(dv.getFloat64(0));
  n++;
  if (want !== got) { bad++; if (bad < 10) console.log(`MISMATCH ${bits}: rust=${got} js=${want}`); }
}
console.log(`${n} doubles checked, ${bad} mismatches`);
process.exit(bad ? 1 : 0);
