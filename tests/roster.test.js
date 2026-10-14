import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildDays, parseTeam, formatTeam, checkInput, checkFeasibility, generate, validate, fairness, toCSV, csvCell,
  createRng, SHIFTS,
} from '../src/roster.js';

const START = '2026-11-02'; // a Monday

function team(n, leave = {}) {
  return Array.from({ length: n }, (_, i) => ({ name: `Person ${String(i + 1).padStart(2, '0')}`, leave: leave[i] ?? [] }));
}

function config(overrides = {}) {
  const { rules, ...rest } = overrides;
  return {
    people: team(12),
    startDate: START,
    weeks: 4,
    seed: 1,
    ...rest,
    rules: {
      minPerShift: { M: 3, A: 3, N: 3 },
      maxConsecutiveDays: 6,
      maxConsecutiveNights: 3,
      restAfterNight: true,
      weeklyOff: true,
      ...rules,
    },
  };
}

function mustGenerate(cfg) {
  const result = generate(cfg);
  assert.equal(result.ok, true, result.failure?.message);
  return result;
}

const isWork = (c) => c === 'M' || c === 'A' || c === 'N';

function longestRun(row, match) {
  let best = 0;
  let run = 0;
  for (const c of row) {
    run = match(c) ? run + 1 : 0;
    best = Math.max(best, run);
  }
  return best;
}

// A spread of setups used to check that the rules hold beyond one lucky case.
const VARIETY = [
  config(),
  config({ seed: 99 }),
  config({ people: team(7), rules: { minPerShift: { M: 2, A: 2, N: 2 } } }),
  config({ people: team(9), weeks: 6, rules: { minPerShift: { M: 2, A: 2, N: 2 }, maxConsecutiveDays: 4, maxConsecutiveNights: 2 } }),
  config({ people: team(20), weeks: 3, seed: 5, rules: { minPerShift: { M: 5, A: 4, N: 3 }, maxConsecutiveNights: 1 } }),
  config({ people: team(10, { 0: ['2026-11-04', '2026-11-05'], 3: ['2026-11-14', '2026-11-15', '2026-11-16'] }), seed: 7, rules: { minPerShift: { M: 2, A: 2, N: 2 } } }),
  config({ people: team(5), weeks: 2, rules: { minPerShift: { M: 1, A: 1, N: 1 }, restAfterNight: false, weeklyOff: false } }),
];

describe('generate: every rule holds', () => {
  for (const [i, cfg] of VARIETY.entries()) {
    test(`setup ${i + 1}: ${cfg.people.length} people, ${cfg.weeks} weeks, seed ${cfg.seed}`, () => {
      const { roster } = mustGenerate(cfg);
      const days = buildDays(cfg.startDate, cfg.weeks);
      const r = cfg.rules;

      // 1. minimum staffing on every shift of every day
      for (let d = 0; d < days.length; d++) {
        for (const s of SHIFTS) {
          const have = roster.filter((row) => row[d] === s).length;
          assert.ok(have >= r.minPerShift[s], `${days[d].iso} ${s}: ${have} < ${r.minPerShift[s]}`);
        }
      }
      roster.forEach((row, p) => {
        // 2. rest rule
        if (r.restAfterNight) {
          for (let d = 1; d < row.length; d++) assert.ok(!(row[d - 1] === 'N' && row[d] === 'M'), `person ${p} N then M on day ${d}`);
        }
        // 3 and 4. consecutive limits
        assert.ok(longestRun(row, isWork) <= r.maxConsecutiveDays, `person ${p} works too many days in a row`);
        assert.ok(longestRun(row, (c) => c === 'N') <= r.maxConsecutiveNights, `person ${p} works too many nights in a row`);
        // 5. a day off in every week
        if (r.weeklyOff) {
          for (let w = 0; w < cfg.weeks; w++) {
            assert.ok(row.slice(w * 7, w * 7 + 7).some((c) => !isWork(c)), `person ${p} has no day off in week ${w + 1}`);
          }
        }
        // 6. leave respected
        for (const iso of cfg.people[p].leave) {
          const d = days.findIndex((day) => day.iso === iso);
          assert.equal(row[d], 'L', `person ${p} should be on leave on ${iso}`);
        }
      });
      // and the module's own validator agrees
      assert.deepEqual(validate(cfg, roster), []);
    });
  }
});

describe('generate: determinism', () => {
  test('same seed and inputs give the same roster', () => {
    const a = mustGenerate(config({ seed: 42 }));
    const b = mustGenerate(config({ seed: 42 }));
    assert.deepEqual(a.roster, b.roster);
    assert.equal(a.score, b.score);
  });

  test('a different seed gives a different roster', () => {
    const a = mustGenerate(config({ seed: 1 }));
    const b = mustGenerate(config({ seed: 2 }));
    assert.notDeepEqual(a.roster, b.roster);
  });

  test('the random number generator repeats for a seed', () => {
    const a = createRng(7);
    const b = createRng(7);
    const seqA = [a(), a(), a()];
    assert.deepEqual(seqA, [b(), b(), b()]);
    assert.ok(seqA.every((x) => x >= 0 && x < 1));
  });
});

describe('generate: clear failures', () => {
  test('too few people fails and names the staffing rule', () => {
    const result = generate(config({ people: team(8) }));
    assert.equal(result.ok, false);
    assert.equal(result.roster, undefined);
    assert.equal(result.failure.code, 'team-too-small');
    assert.equal(result.failure.rule, 'staffing');
    assert.equal(result.failure.proven, true);
    assert.match(result.failure.message, /needs 9 people/);
  });

  test('too many people on leave on one date fails and names that date', () => {
    const leave = {};
    for (let i = 0; i < 4; i++) leave[i] = ['2026-11-11'];
    const result = generate(config({ people: team(12, leave) }));
    assert.equal(result.ok, false);
    assert.equal(result.failure.code, 'leave-shortfall');
    assert.equal(result.failure.day, '2026-11-11');
    assert.match(result.failure.message, /Wed 11 Nov/);
  });

  test('not enough working days once rest days are counted fails and names the rules', () => {
    // 9 people cover a crew of 9 every day only if nobody ever rests.
    const result = generate(config({ people: team(9) }));
    assert.equal(result.ok, false);
    assert.equal(result.failure.code, 'capacity');
    assert.deepEqual(result.failure.rules, ['weeklyOff', 'maxConsecutiveDays']);
    assert.equal(result.failure.proven, true);
    assert.match(result.failure.message, /needs 252 shifts .* can work at most 216/);
  });

  test('when only the weekly day off blocks, only that rule is named', () => {
    // 10 people, crew of 9, limit of 14 days in a row: only the weekly day off makes it impossible.
    const result = generate(config({ people: team(10), rules: { maxConsecutiveDays: 14, minPerShift: { M: 3, A: 3, N: 3 } } }));
    assert.equal(result.ok, false);
    assert.deepEqual(result.failure.rules, ['weeklyOff']);
  });

  test('a Night crew that cannot take the next Morning or Night is caught', () => {
    const result = generate(config({ people: team(7), rules: { minPerShift: { M: 2, A: 1, N: 3 }, maxConsecutiveNights: 1 } }));
    assert.equal(result.ok, false);
    assert.equal(result.failure.code, 'rest-shortfall');
    assert.equal(result.failure.rule, 'restAfterNight');
  });

  test('bad setup is reported, not guessed', () => {
    assert.equal(generate(config({ people: [] })).failure.code, 'invalid-input');
    assert.equal(generate(config({ weeks: 7 })).failure.code, 'invalid-input');
    assert.equal(generate(config({ startDate: '2026-02-30' })).failure.code, 'invalid-input');
    assert.ok(checkInput(config({ rules: { maxConsecutiveDays: 0 } })).length > 0);
    assert.equal(checkFeasibility(config()), null);
  });

  test('a failed result never contains a roster', () => {
    for (const cfg of [config({ people: team(3) }), config({ people: team(9) }), config({ weeks: 0 })]) {
      const result = generate(cfg);
      assert.equal(result.ok, false);
      assert.deepEqual(Object.keys(result).sort(), ['failure', 'ok']);
      assert.ok(result.failure.message.length > 20);
    }
  });
});

describe('validate', () => {
  const small = {
    people: team(3, { 2: ['2026-11-03'] }),
    startDate: START,
    weeks: 1,
    rules: { minPerShift: { M: 1, A: 0, N: 1 }, maxConsecutiveDays: 5, maxConsecutiveNights: 2, restAfterNight: true, weeklyOff: true },
  };

  test('a clean roster reports nothing', () => {
    const roster = [
      ['M', 'M', 'M', 'O', 'N', 'N', 'O'],
      ['N', 'N', 'O', 'M', 'M', 'O', 'M'],
      ['O', 'L', 'N', 'N', 'O', 'M', 'N'],
    ];
    assert.deepEqual(validate(small, roster), []);
  });

  test('each kind of broken rule is reported with the right rule, person and day', () => {
    const roster = [
      ['M', 'M', 'M', 'M', 'M', 'M', 'M'], // 7 days in a row, no weekly off
      ['N', 'N', 'N', 'M', 'O', 'N', 'O'], // 3 nights in a row, then a Morning after a Night
      ['O', 'A', 'O', 'O', 'O', 'O', 'N'], // works on a leave day
    ];
    const v = validate(small, roster);
    const find = (rule, person) => v.find((x) => x.rule === rule && x.person === person);

    assert.equal(find('maxConsecutiveDays', 0).day, 5);
    assert.deepEqual(find('maxConsecutiveDays', 0).cells, [5, 6]);
    assert.equal(find('weeklyOff', 0).day, 6);
    assert.equal(find('maxConsecutiveNights', 1).day, 2);
    assert.equal(find('restAfterNight', 1).day, 3);
    assert.equal(find('leave', 2).day, 1);
    // day 4 (Fri) has no Night
    const gap = v.find((x) => x.rule === 'staffing' && x.day === 4);
    assert.equal(gap.shift, 'N');
    assert.equal(gap.have, 0);
    assert.match(find('restAfterNight', 1).message, /Person 02 has a Morning on Thu 5 Nov straight after a Night/);
  });

  test('turned-off rules are not reported', () => {
    const cfg = { ...small, people: team(3), rules: { ...small.rules, maxConsecutiveDays: 7, restAfterNight: false, weeklyOff: false } };
    const roster = [
      ['N', 'M', 'N', 'M', 'N', 'O', 'M'], // Mornings straight after Nights
      ['A', 'A', 'A', 'A', 'A', 'N', 'A'], // no day off all week
      ['M', 'N', 'M', 'N', 'M', 'M', 'N'],
    ];
    assert.deepEqual(validate(cfg, roster), []);
    const strict = { ...cfg, rules: { ...cfg.rules, restAfterNight: true, weeklyOff: true } };
    const rules = new Set(validate(strict, roster).map((x) => x.rule));
    assert.deepEqual([...rules].sort(), ['restAfterNight', 'weeklyOff']);
  });

  test('a roster of the wrong size or with unknown letters is reported', () => {
    assert.equal(validate(small, [['M']])[0].rule, 'invalid');
    const roster = [
      ['M', 'X', 'O', 'N', 'N', 'O', 'M'],
      ['N', 'N', 'N', 'M', 'M', 'M', 'O'],
      ['O', 'L', 'M', 'O', 'O', 'O', 'N'],
    ];
    assert.ok(validate(small, roster).some((x) => x.rule === 'invalid' && x.person === 0 && x.day === 1));
  });
});

describe('fairness', () => {
  const four = { people: team(4), startDate: START, weeks: 1, rules: { minPerShift: { M: 1, A: 1, N: 1 } } };
  test('a perfectly even roster scores 100', () => {
    const rows = Array.from({ length: 4 }, () => ['M', 'A', 'N', 'O', 'M', 'N', 'A']);
    const f = fairness(four, rows);
    assert.equal(f.score, 100);
    assert.deepEqual(f.parts, { nights: 100, weekends: 100, total: 100 });
    assert.equal(f.mostLoaded, null);
    assert.equal(f.leastLoaded, null);
  });

  test('a lopsided roster scores lower, and a more lopsided one lower still', () => {
    const base = Array.from({ length: 4 }, () => ['M', 'A', 'N', 'O', 'M', 'N', 'A']);
    const oneExtraNight = base.map((row) => [...row]);
    oneExtraNight[0][3] = 'N'; // person 01 works their Thursday off as a Night
    const allNightsOnOne = [
      ['N', 'N', 'N', 'N', 'N', 'N', 'N'],
      ['M', 'A', 'O', 'O', 'M', 'A', 'M'],
      ['A', 'M', 'M', 'A', 'O', 'M', 'A'],
      ['O', 'O', 'A', 'M', 'A', 'A', 'M'],
    ];
    const even = fairness(four, base).exactScore;
    const a = fairness(four, oneExtraNight).exactScore;
    const b = fairness(four, allNightsOnOne).exactScore;
    assert.equal(even, 100);
    assert.ok(a < even, `${a} should be below ${even}`);
    assert.ok(b < a, `${b} should be below ${a}`);
    assert.equal(fairness(four, allNightsOnOne).parts.nights, 0);
  });

  test('the score stays between 0 and 100', () => {
    const worst = [
      ['N', 'N', 'N', 'N', 'N', 'N', 'N'],
      ['O', 'O', 'O', 'O', 'O', 'O', 'O'],
      ['O', 'O', 'O', 'O', 'O', 'O', 'O'],
      ['O', 'O', 'O', 'O', 'O', 'O', 'O'],
    ];
    const f = fairness(four, worst);
    assert.ok(f.score >= 0 && f.score <= 100);
    assert.ok(f.score < 30);
    const none = Array.from({ length: 4 }, () => new Array(7).fill('O'));
    assert.equal(fairness(four, none).score, 100); // nothing to share out, so nothing is unfair
  });

  test('leave lowers the fair share instead of counting against the person', () => {
    // Person 04 is on leave for all of week 1 of a 2-week roster.
    const week1 = ['2026-11-02', '2026-11-03', '2026-11-04', '2026-11-05', '2026-11-06', '2026-11-07', '2026-11-08'];
    const cfg = { people: team(4, { 3: week1 }), startDate: START, weeks: 2, rules: { minPerShift: { M: 0, A: 0, N: 1 } } };
    const f = fairness(cfg, [
      ['N', 'O', 'O', 'O', 'N', 'O', 'O', 'N', 'O', 'O', 'O', 'O', 'O', 'O'],
      ['O', 'N', 'O', 'O', 'O', 'N', 'O', 'O', 'N', 'O', 'O', 'O', 'O', 'O'],
      ['O', 'O', 'N', 'N', 'O', 'O', 'N', 'O', 'O', 'N', 'O', 'O', 'O', 'O'],
      ['L', 'L', 'L', 'L', 'L', 'L', 'L', 'O', 'O', 'O', 'N', 'O', 'O', 'O'],
    ]);
    // 11 nights; available days 14, 14, 14, 7 out of 49, so person 4's fair share is 11 x 7/49
    assert.ok(Math.abs(f.people[3].share.nights - (11 * 7) / 49) < 1e-9);
    assert.ok(Math.abs(f.people[0].share.nights - (11 * 14) / 49) < 1e-9);
  });

  test('the balancing pass never makes the score worse than the greedy fill', () => {
    for (const cfg of VARIETY) {
      const result = mustGenerate(cfg);
      assert.ok(result.score >= result.greedyScore, `${result.score} < ${result.greedyScore}`);
      assert.equal(result.score, fairness(cfg, result.roster).score);
    }
  });

  test('most and least loaded are the right people', () => {
    const rows = [
      ['N', 'N', 'O', 'N', 'N', 'N', 'N'], // most nights and weekends
      ['M', 'A', 'N', 'O', 'M', 'A', 'O'],
      ['A', 'M', 'M', 'A', 'O', 'O', 'M'],
      ['O', 'O', 'A', 'M', 'O', 'O', 'O'], // fewest of everything
    ];
    const f = fairness(four, rows);
    assert.equal(f.mostLoaded, 0);
    assert.equal(f.leastLoaded, 3);
    assert.deepEqual([f.people[0].nights, f.people[0].weekends, f.people[0].total], [6, 2, 6]);
  });
});

describe('CSV export', () => {
  const cfg = { people: team(2), startDate: '2026-10-26', weeks: 1, rules: { minPerShift: { M: 0, A: 0, N: 0 } } };
  const roster = [
    ['M', 'A', 'N', 'O', 'L', 'N', 'O'],
    ['O', 'O', 'O', 'O', 'O', 'M', 'A'],
  ];

  test('header, one row per person, dates, counts and CRLF line ends', () => {
    const csv = toCSV(cfg, roster);
    const lines = csv.split('\r\n');
    assert.equal(lines.pop(), ''); // ends with a line break
    assert.equal(lines.length, 3);
    assert.equal(lines[0], 'Name,2026-10-26,2026-10-27,2026-10-28,2026-10-29,2026-10-30,2026-10-31,2026-11-01,Nights,Weekend days,Total shifts');
    assert.equal(lines[1], 'Person 01,M,A,N,O,L,N,O,2,1,4');
    assert.equal(lines[2], 'Person 02,O,O,O,O,O,M,A,0,2,2');
    assert.equal(csv.split('\n').length, csv.split('\r\n').length); // no bare LF
  });

  test('commas and quotes in names are escaped', () => {
    const csv = toCSV({ ...cfg, people: [{ name: 'Rao, Kiran', leave: [] }, { name: 'Sam "Night Owl" Demo', leave: [] }] }, roster);
    const lines = csv.split('\r\n');
    assert.ok(lines[1].startsWith('"Rao, Kiran",M,'));
    assert.ok(lines[2].startsWith('"Sam ""Night Owl"" Demo",O,'));
  });

  test('names that look like formulas are made safe', () => {
    assert.equal(csvCell('=SUM(A1:A9)'), "'=SUM(A1:A9)");
    assert.equal(csvCell('+91 Team'), "'+91 Team");
    assert.equal(csvCell('-Demo'), "'-Demo");
    assert.equal(csvCell('@Shift'), "'@Shift");
    assert.equal(csvCell('=1,2'), '"\'=1,2"');
    assert.equal(csvCell('Plain Name'), 'Plain Name');
  });
});

describe('dates', () => {
  test('weekends and week numbers, across a month end', () => {
    const days = buildDays('2026-10-26', 2);
    assert.equal(days.length, 14);
    assert.deepEqual(days.filter((d) => d.isWeekend).map((d) => d.iso), ['2026-10-31', '2026-11-01', '2026-11-07', '2026-11-08']);
    assert.equal(days[6].week, 0);
    assert.equal(days[7].week, 1);
    assert.equal(days[6].month, 'Nov');
    assert.equal(days[6].dayOfMonth, 1);
    assert.equal(days[0].weekday, 'Mon');
  });

  test('a start on a Sunday still counts weeks from the start date', () => {
    const days = buildDays('2026-11-01', 1);
    assert.equal(days[0].weekday, 'Sun');
    assert.equal(days[0].isWeekend, true);
    assert.equal(days[6].weekday, 'Sat');
  });

  test('impossible dates and week counts are refused', () => {
    assert.throws(() => buildDays('2026-13-01', 1), RangeError);
    assert.throws(() => buildDays('01/11/2026', 1), RangeError);
    assert.throws(() => buildDays(START, 0), RangeError);
    assert.throws(() => buildDays(START, 2.5), RangeError);
  });
});

describe('team text format', () => {
  test('names one per line or comma-separated, with leave after a colon', () => {
    const { people, errors } = parseTeam([
      'Asha Sample',
      '  Bharat   Sample : 2026-11-05, 2026-11-10 to 2026-11-12',
      'Chetan Sample, Divya Sample',
      '',
    ].join('\n'));
    assert.deepEqual(errors, []);
    assert.deepEqual(people.map((p) => p.name), ['Asha Sample', 'Bharat Sample', 'Chetan Sample', 'Divya Sample']);
    assert.deepEqual(people[1].leave, ['2026-11-05', '2026-11-10', '2026-11-11', '2026-11-12']);
    assert.deepEqual(people[0].leave, []);
  });

  test('bad lines are reported with their line number', () => {
    const { people, errors } = parseTeam('Asha Sample\nBharat: 5 Nov\nasha sample\nChetan: 2026-11-12 to 2026-11-10');
    assert.deepEqual(people.map((p) => p.name), ['Asha Sample']);
    assert.deepEqual(errors.map((e) => e.line), [2, 3, 4]);
    assert.match(errors[0].message, /YYYY-MM-DD/);
    assert.match(errors[1].message, /already listed on line 1/);
    assert.match(errors[2].message, /ends before it starts/);
  });

  test('formatTeam writes the same format back, with ranges', () => {
    const people = [
      { name: 'Asha Sample', leave: [] },
      { name: 'Bharat Sample', leave: ['2026-11-12', '2026-11-05', '2026-11-10', '2026-11-11'] },
    ];
    const text = formatTeam(people);
    assert.equal(text, 'Asha Sample\nBharat Sample: 2026-11-05, 2026-11-10 to 2026-11-12');
    assert.deepEqual(parseTeam(text).people[1].leave, ['2026-11-05', '2026-11-10', '2026-11-11', '2026-11-12']);
  });

  test('more than 50 people is refused', () => {
    const text = Array.from({ length: 51 }, (_, i) => `Person ${i}`).join('\n');
    assert.ok(parseTeam(text).errors.some((e) => /at most 50/.test(e.message)));
  });
});
