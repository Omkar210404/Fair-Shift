// Runs the generator on many random setups and reports what happened.
// The setups come from a fixed pseudo-random sequence, so the numbers repeat on every run.
//   node tools/sweep.js          1,000 setups
//   node tools/sweep.js 200      any other count
import { generate, validate } from '../src/roster.js';

const count = Number(process.argv[2] ?? 1000);
let state = 7;
const rand = () => {
  state = (state * 1103515245 + 12345) % 2147483648;
  return state / 2147483648;
};
const pick = (min, max) => min + Math.floor(rand() * (max - min + 1));

const tally = { found: 0, proven: 0, notFound: 0, brokenRules: 0 };
const provenCodes = {};
const scores = [];
const gains = [];
let slowest = 0;

for (let i = 0; i < count; i++) {
  const people = Array.from({ length: pick(3, 22) }, (_, n) => ({ name: `Person ${n + 1}`, leave: [] }));
  const config = {
    people,
    startDate: '2026-11-02',
    weeks: pick(1, 6),
    seed: i,
    rules: {
      minPerShift: { M: pick(0, 3), A: pick(0, 3), N: pick(0, 3) },
      maxConsecutiveDays: pick(3, 7),
      maxConsecutiveNights: pick(1, 4),
      restAfterNight: true,
      weeklyOff: true,
    },
  };
  const started = performance.now();
  const result = generate(config);
  slowest = Math.max(slowest, performance.now() - started);
  if (result.ok) {
    tally.found++;
    scores.push(result.score);
    gains.push(result.score - result.greedyScore);
    if (validate(config, result.roster).length) tally.brokenRules++;
  } else if (result.failure.proven) {
    tally.proven++;
    provenCodes[result.failure.code] = (provenCodes[result.failure.code] ?? 0) + 1;
  } else {
    tally.notFound++;
  }
}

scores.sort((a, b) => a - b);
const median = (list) => list[Math.floor(list.length / 2)];
const pct = (n) => `${((100 * n) / count).toFixed(1)}%`;
console.log(`Random setups:             ${count}`);
console.log(`Roster found:              ${tally.found} (${pct(tally.found)})`);
console.log(`Proven impossible:         ${tally.proven} (${pct(tally.proven)}) ${JSON.stringify(provenCodes)}`);
console.log(`Not found (heuristic):     ${tally.notFound} (${pct(tally.notFound)})`);
console.log(`Found rosters breaking a rule: ${tally.brokenRules}`);
console.log(`Fairness score of found rosters: median ${median(scores)}, lowest ${scores[0]}`);
console.log(`Balancing pass raised the score in ${gains.filter((g) => g > 0).length} of ${gains.length} rosters (median gain ${median([...gains].sort((a, b) => a - b))})`);
console.log(`Slowest single run:        ${slowest.toFixed(0)} ms`);
