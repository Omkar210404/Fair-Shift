// fairshift roster logic.
// Pure functions only: no DOM and no browser APIs, so Node can test this file on its own.
// A roster is an array with one row per person; each row has one letter per day:
// M (Morning), A (Afternoon), N (Night), O (Off) or L (Leave).

export const SHIFTS = ['M', 'A', 'N'];
export const OFF = 'O';
export const LEAVE = 'L';
export const LETTERS = ['M', 'A', 'N', 'O', 'L'];
export const SHIFT_NAMES = { M: 'Morning', A: 'Afternoon', N: 'Night', O: 'Off', L: 'Leave' };

export const LIMITS = {
  weeks: { min: 1, max: 6 },
  people: { max: 50 },
  nameLength: 40,
  minPerShift: { min: 0, max: 50 },
  maxConsecutiveDays: { min: 1, max: 14 },
  maxConsecutiveNights: { min: 1, max: 14 },
};

export const DEFAULT_RULES = Object.freeze({
  minPerShift: Object.freeze({ M: 2, A: 2, N: 2 }),
  maxConsecutiveDays: 6,
  maxConsecutiveNights: 3,
  restAfterNight: true,
  weeklyOff: true,
});

export const RULE_LABELS = {
  staffing: 'Minimum people per shift',
  maxConsecutiveDays: 'Maximum consecutive working days',
  maxConsecutiveNights: 'Maximum consecutive nights',
  restAfterNight: 'No Morning right after a Night',
  weeklyOff: 'At least one day off each week',
  leave: 'Leave is always respected',
  invalid: 'Every cell holds M, A, N, O or L',
  input: 'Setup is complete and valid',
};

// Weights of the three part scores in the overall fairness score.
export const WEIGHTS = Object.freeze({ nights: 0.4, weekends: 0.4, total: 0.2 });

const MAX_ATTEMPTS = 25;
const MAX_BALANCE_ROUNDS = 50;
const DAY_MS = 86400000;
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

const isWork = (letter) => letter === 'M' || letter === 'A' || letter === 'N';

// ---------------------------------------------------------------- dates

// Dates are handled as UTC midnights so the local time zone can never shift a day.
export function parseISODate(text) {
  const m = ISO_DATE.exec(String(text ?? '').trim());
  if (!m) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const t = Date.UTC(y, mo - 1, d);
  const check = new Date(t);
  if (check.getUTCFullYear() !== y || check.getUTCMonth() !== mo - 1 || check.getUTCDate() !== d) return null;
  return t;
}

export function toISODate(t) {
  return new Date(t).toISOString().slice(0, 10);
}

export function buildDays(startDate, weeks) {
  const start = parseISODate(startDate);
  if (start === null) throw new RangeError(`Start date must be a real date in YYYY-MM-DD form, got "${startDate}".`);
  if (!Number.isInteger(weeks) || weeks < LIMITS.weeks.min || weeks > LIMITS.weeks.max) {
    throw new RangeError(`Weeks must be a whole number from ${LIMITS.weeks.min} to ${LIMITS.weeks.max}, got "${weeks}".`);
  }
  const days = [];
  for (let i = 0; i < weeks * 7; i++) {
    const t = start + i * DAY_MS;
    const date = new Date(t);
    const dow = date.getUTCDay();
    days.push({
      index: i,
      iso: toISODate(t),
      dow,
      weekday: WEEKDAYS[dow],
      dayOfMonth: date.getUTCDate(),
      month: MONTHS[date.getUTCMonth()],
      isWeekend: dow === 0 || dow === 6,
      week: Math.floor(i / 7),
    });
  }
  return days;
}

export function formatDay(day) {
  return `${day.weekday} ${day.dayOfMonth} ${day.month}`;
}

// ---------------------------------------------------------------- team text format
//
// One person per line. Leave goes after a colon, as dates or "from to until" ranges:
//   Asha Sample
//   Bharat Sample: 2026-11-05, 2026-11-10 to 2026-11-12
// A line without a colon may hold several names separated by commas.

function cleanName(raw) {
  return String(raw ?? '').replace(/\s+/g, ' ').trim();
}

export function checkName(name) {
  if (!name) return 'A name is empty.';
  if (name.length > LIMITS.nameLength) return `"${name.slice(0, 20)}..." is longer than ${LIMITS.nameLength} characters.`;
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(name)) return `"${name}" contains a control character.`;
  return null;
}

function parseLeaveList(text) {
  const dates = new Set();
  for (const item of text.split(',')) {
    const part = item.trim();
    if (!part) continue;
    const m = /^(\S+)(?:\s+to\s+(\S+))?$/i.exec(part);
    const from = m && parseISODate(m[1]);
    const until = m && (m[2] === undefined ? from : parseISODate(m[2]));
    if (from === null || until === null || !m) {
      return { error: `"${part}" is not a date in YYYY-MM-DD form or a range like 2026-11-10 to 2026-11-12.` };
    }
    if (until < from) return { error: `The range "${part}" ends before it starts.` };
    if ((until - from) / DAY_MS > 62) return { error: `The range "${part}" is longer than 62 days.` };
    for (let t = from; t <= until; t += DAY_MS) dates.add(toISODate(t));
  }
  return { dates: [...dates].sort() };
}

export function parseTeam(text) {
  const people = [];
  const errors = [];
  const seen = new Map();
  String(text ?? '').split(/\r?\n/).forEach((raw, i) => {
    const line = raw.trim();
    const lineNo = i + 1;
    if (!line) return;
    let entries;
    const colon = line.indexOf(':');
    if (colon >= 0) {
      const parsed = parseLeaveList(line.slice(colon + 1));
      if (parsed.error) {
        errors.push({ line: lineNo, message: parsed.error });
        return;
      }
      entries = [{ name: cleanName(line.slice(0, colon)), leave: parsed.dates }];
    } else {
      entries = line.split(',').map((s) => ({ name: cleanName(s), leave: [] })).filter((e) => e.name);
    }
    for (const entry of entries) {
      const problem = checkName(entry.name);
      if (problem) {
        errors.push({ line: lineNo, message: problem });
        continue;
      }
      const key = entry.name.toLowerCase();
      if (seen.has(key)) {
        errors.push({ line: lineNo, message: `"${entry.name}" is already listed on line ${seen.get(key)}.` });
        continue;
      }
      seen.set(key, lineNo);
      people.push(entry);
    }
  });
  if (people.length > LIMITS.people.max) {
    errors.push({ line: null, message: `A team can have at most ${LIMITS.people.max} people; this list has ${people.length}.` });
  }
  return { people, errors };
}

// The reverse of parseTeam: consecutive leave days are written as one range.
export function formatTeam(people) {
  return people
    .map((person) => {
      const dates = [...new Set(person.leave ?? [])].sort();
      if (!dates.length) return person.name;
      const parts = [];
      let from = dates[0];
      let prev = dates[0];
      for (const iso of [...dates.slice(1), null]) {
        if (iso && parseISODate(iso) - parseISODate(prev) === DAY_MS) {
          prev = iso;
          continue;
        }
        parts.push(from === prev ? from : `${from} to ${prev}`);
        from = prev = iso;
      }
      return `${person.name}: ${parts.join(', ')}`;
    })
    .join('\n');
}

// ---------------------------------------------------------------- setup checks

function mergeRules(rules = {}) {
  return {
    ...DEFAULT_RULES,
    ...rules,
    minPerShift: { ...DEFAULT_RULES.minPerShift, ...(rules.minPerShift ?? {}) },
  };
}

function normalisePeople(people) {
  return (people ?? []).map((p) => (typeof p === 'string' ? { name: p, leave: [] } : { name: p.name, leave: p.leave ?? [] }));
}

function inRange(value, { min, max }) {
  return Number.isInteger(value) && value >= min && value <= max;
}

// Returns a list of plain-language problems with the setup; empty when it can be used.
export function checkInput(config) {
  const errors = [];
  const people = normalisePeople(config?.people);
  if (!people.length) errors.push('Add at least one team member.');
  if (people.length > LIMITS.people.max) errors.push(`A team can have at most ${LIMITS.people.max} people.`);
  const seen = new Set();
  for (const p of people) {
    const problem = checkName(p.name);
    if (problem) errors.push(problem);
    const key = String(p.name).toLowerCase();
    if (seen.has(key)) errors.push(`"${p.name}" appears twice in the team.`);
    seen.add(key);
    for (const iso of p.leave) if (parseISODate(iso) === null) errors.push(`Leave date "${iso}" for ${p.name} is not a real date.`);
  }
  if (parseISODate(config?.startDate) === null) errors.push('Start date must be a real date in YYYY-MM-DD form.');
  if (!inRange(config?.weeks, LIMITS.weeks)) errors.push(`Weeks must be a whole number from ${LIMITS.weeks.min} to ${LIMITS.weeks.max}.`);
  const rules = mergeRules(config?.rules);
  for (const s of SHIFTS) {
    if (!inRange(rules.minPerShift[s], LIMITS.minPerShift)) {
      errors.push(`Minimum people on ${SHIFT_NAMES[s]} must be a whole number from ${LIMITS.minPerShift.min} to ${LIMITS.minPerShift.max}.`);
    }
  }
  for (const key of ['maxConsecutiveDays', 'maxConsecutiveNights']) {
    if (!inRange(rules[key], LIMITS[key])) {
      errors.push(`${RULE_LABELS[key]} must be a whole number from ${LIMITS[key].min} to ${LIMITS[key].max}.`);
    }
  }
  return errors;
}

function makeContext(config) {
  const rules = mergeRules(config.rules);
  const days = buildDays(config.startDate, config.weeks);
  const people = normalisePeople(config.people);
  const dayIndex = new Map(days.map((d) => [d.iso, d.index]));
  const leave = people.map((p) => {
    const set = new Set();
    for (const iso of p.leave) if (dayIndex.has(iso)) set.add(dayIndex.get(iso));
    return set;
  });
  const crew = SHIFTS.reduce((n, s) => n + rules.minPerShift[s], 0);
  return { rules, days, people, leave, crew, P: people.length, D: days.length };
}

// ---------------------------------------------------------------- validation

function violation(rule, person, day, cells, message, extra = {}) {
  return { rule, person, day, cells, message, ...extra };
}

// Checks one person's row against every per-person rule.
// Stops early once `limit` problems are found (the balancing pass only needs a yes or no).
function rowViolations(ctx, row, p, limit = Infinity) {
  const { rules, days, leave, people } = ctx;
  const name = people[p].name;
  const out = [];
  const push = (v) => {
    out.push(v);
    return out.length >= limit;
  };
  const runCheck = (rule, max, start, end, what) => {
    const length = end - start + 1;
    if (length <= max) return false;
    const cells = [];
    for (let d = start + max; d <= end; d++) cells.push(d);
    return push(violation(rule, p, start + max, cells,
      `${name} works ${length} ${what} in a row (${formatDay(days[start])} to ${formatDay(days[end])}); the limit is ${max}.`));
  };

  let runStart = -1;
  let nightStart = -1;
  for (let d = 0; d <= row.length; d++) {
    const c = d < row.length ? row[d] : OFF;
    if (d < row.length) {
      if (!LETTERS.includes(c)) {
        if (push(violation('invalid', p, d, [d], `${name} on ${formatDay(days[d])} has "${c}", which is not M, A, N, O or L.`))) return out;
        continue;
      }
      if (isWork(c) && leave[p].has(d)) {
        if (push(violation('leave', p, d, [d], `${name} is on leave on ${formatDay(days[d])} but has a ${SHIFT_NAMES[c]} shift.`))) return out;
      }
      if (rules.restAfterNight && c === 'M' && d > 0 && row[d - 1] === 'N') {
        if (push(violation('restAfterNight', p, d, [d], `${name} has a Morning on ${formatDay(days[d])} straight after a Night.`))) return out;
      }
    }
    if (isWork(c)) {
      if (runStart < 0) runStart = d;
    } else if (runStart >= 0) {
      if (runCheck('maxConsecutiveDays', rules.maxConsecutiveDays, runStart, d - 1, 'days')) return out;
      runStart = -1;
    }
    if (c === 'N') {
      if (nightStart < 0) nightStart = d;
    } else if (nightStart >= 0) {
      if (runCheck('maxConsecutiveNights', rules.maxConsecutiveNights, nightStart, d - 1, 'nights')) return out;
      nightStart = -1;
    }
  }
  if (rules.weeklyOff) {
    for (let start = 0; start < row.length; start += 7) {
      const end = Math.min(start + 6, row.length - 1);
      let worked = true;
      for (let d = start; d <= end; d++) if (!isWork(row[d])) worked = false;
      if (worked && push(violation('weeklyOff', p, end, [end],
        `${name} has no day off in week ${start / 7 + 1} (${formatDay(days[start])} to ${formatDay(days[end])}).`))) return out;
    }
  }
  return out;
}

function staffingViolations(ctx, roster) {
  const { rules, days, P, D } = ctx;
  const out = [];
  for (let d = 0; d < D; d++) {
    for (const s of SHIFTS) {
      let have = 0;
      for (let p = 0; p < P; p++) if (roster[p][d] === s) have++;
      const needed = rules.minPerShift[s];
      if (have < needed) {
        out.push(violation('staffing', null, d, [], `${formatDay(days[d])}: ${SHIFT_NAMES[s]} has ${have} of the ${needed} people needed.`,
          { shift: s, needed, have }));
      }
    }
  }
  return out;
}

function validateCtx(ctx, roster) {
  if (!Array.isArray(roster) || roster.length !== ctx.P || roster.some((row) => !Array.isArray(row) || row.length !== ctx.D)) {
    return [violation('invalid', null, null, [], `The roster must have ${ctx.P} rows of ${ctx.D} days.`)];
  }
  const out = staffingViolations(ctx, roster);
  for (let p = 0; p < ctx.P; p++) out.push(...rowViolations(ctx, roster[p], p));
  return out.sort((a, b) => (a.day ?? -1) - (b.day ?? -1) || (a.person ?? -1) - (b.person ?? -1));
}

// Every broken rule in a roster, sorted by day. Each item has rule, person (index or null),
// day (index), cells (day indexes to flag in that person's row) and a plain message.
export function validate(config, roster) {
  const errors = checkInput(config);
  if (errors.length) return errors.map((message) => violation('input', null, null, [], message));
  return validateCtx(makeContext(config), roster);
}

// ---------------------------------------------------------------- proofs by counting

// The most days one person can work on their own, given leave, the consecutive-day limit
// and the weekly day off. With nightsOnly it is the most nights instead. Computed exactly
// with a small dynamic programme over (days in a row, nights in a row, day off this week yet).
function personCapacity(ctx, p, { nightsOnly = false, ignoreWeeklyOff = false, ignoreMaxDays = false } = {}) {
  const { rules, D, leave } = ctx;
  const maxRun = ignoreMaxDays ? D : rules.maxConsecutiveDays;
  const maxNights = nightsOnly ? rules.maxConsecutiveNights : D;
  const weeklyOff = rules.weeklyOff && !ignoreWeeklyOff;
  const key = (run, nights, off) => `${run}|${nights}|${off ? 1 : 0}`;
  let states = new Map([[key(0, 0, false), { run: 0, nights: 0, off: false, count: 0 }]]);
  for (let d = 0; d < D; d++) {
    const next = new Map();
    const keep = (s) => {
      const k = key(s.run, s.nights, s.off);
      if (!next.has(k) || next.get(k).count < s.count) next.set(k, s);
    };
    for (const s of states.values()) {
      const off = d % 7 === 0 ? false : s.off;
      keep({ run: 0, nights: 0, off: true, count: s.count });
      if (leave[p].has(d)) continue;
      const lastDayOfWeek = d % 7 === 6;
      if (s.run >= maxRun || s.nights >= maxNights || (weeklyOff && lastDayOfWeek && !off)) continue;
      keep({ run: s.run + 1, nights: nightsOnly ? s.nights + 1 : 0, off, count: s.count + 1 });
    }
    states = next;
  }
  let best = 0;
  for (const s of states.values()) best = Math.max(best, s.count);
  return best;
}

function teamCapacity(ctx, options) {
  let total = 0;
  for (let p = 0; p < ctx.P; p++) total += personCapacity(ctx, p, options);
  return total;
}

function proofs(ctx) {
  const { rules, days, people, leave, crew, P, D } = ctx;
  const m = rules.minPerShift;
  const crewText = `${crew} people (${m.M} Morning + ${m.A} Afternoon + ${m.N} Night)`;
  if (crew > P) {
    return {
      code: 'team-too-small', proven: true, rule: 'staffing', needed: crew, available: P,
      message: `This cannot be done: each day needs ${crewText}, but the team has ${P}.`,
    };
  }
  for (let d = 0; d < D; d++) {
    let away = 0;
    for (let p = 0; p < P; p++) if (leave[p].has(d)) away++;
    if (P - away < crew) {
      return {
        code: 'leave-shortfall', proven: true, rule: 'staffing', day: days[d].iso, needed: crew, available: P - away,
        message: `This cannot be done: on ${formatDay(days[d])}, ${away} of ${P} people are on leave, which leaves ${P - away} to cover ${crewText}.`,
      };
    }
  }
  const needed = D * crew;
  const capacity = teamCapacity(ctx);
  if (capacity < needed) {
    // Name each rule that blocks the roster on its own; if only the two together do, name both.
    const blocking = [];
    if (rules.weeklyOff && teamCapacity(ctx, { ignoreMaxDays: true }) < needed) blocking.push('weeklyOff');
    if (teamCapacity(ctx, { ignoreWeeklyOff: true }) < needed) blocking.push('maxConsecutiveDays');
    if (!blocking.length) blocking.push('weeklyOff', 'maxConsecutiveDays');
    const limits = [];
    if (rules.weeklyOff) limits.push('a day off every week');
    limits.push(`no more than ${rules.maxConsecutiveDays} days in a row`);
    if (leave.some((set) => set.size)) limits.push('the leave entered');
    return {
      code: 'capacity', proven: true, rule: blocking[0], rules: blocking, needed, available: capacity,
      message: `This cannot be done: the roster needs ${needed} shifts (${D} days x ${crew} people), but with ${limits.join(', ')}, the ${people.length} people can work at most ${capacity}.`,
    };
  }
  if (rules.restAfterNight && m.N > 0) {
    // The Night crew of day d cannot take a Morning on day d + 1, and with a limit of one night
    // in a row they cannot take another Night either. Only people who were not on that crew are left.
    const blocksNight = rules.maxConsecutiveNights === 1;
    const placesLeft = m.M + (blocksNight ? m.N : 0);
    for (let d = 0; d + 1 < D; d++) {
      let free = 0;
      let newLeave = 0;
      for (let p = 0; p < P; p++) {
        if (!leave[p].has(d + 1)) free++;
        else if (!leave[p].has(d)) newLeave++;
      }
      const left = free - Math.max(0, m.N - newLeave);
      if (left < placesLeft) {
        const what = blocksNight ? 'the next Morning or Night (rest rule and a limit of 1 night in a row)' : 'the next Morning (rest rule)';
        return {
          code: 'rest-shortfall', proven: true, rule: 'restAfterNight', day: days[d + 1].iso, needed: placesLeft, available: left,
          message: `This cannot be done: the ${m.N} people on Night on ${formatDay(days[d])} cannot take ${what}, so on ${formatDay(days[d + 1])} only ${left} people are left for ${placesLeft} places.`,
        };
      }
    }
  }
  const nightsNeeded = D * m.N;
  if (nightsNeeded > 0) {
    const nightCapacity = teamCapacity(ctx, { nightsOnly: true });
    if (nightCapacity < nightsNeeded) {
      return {
        code: 'night-capacity', proven: true, rule: 'maxConsecutiveNights', needed: nightsNeeded, available: nightCapacity,
        message: `This cannot be done: the roster needs ${nightsNeeded} Night shifts, but with no more than ${rules.maxConsecutiveNights} nights in a row the team can work at most ${nightCapacity}.`,
      };
    }
  }
  return null;
}

// Problems that can be proven by counting, before any search. Returns a failure or null.
export function checkFeasibility(config) {
  const errors = checkInput(config);
  if (errors.length) return inputFailure(errors);
  return proofs(makeContext(config));
}

function inputFailure(errors) {
  return { code: 'invalid-input', proven: true, rule: 'input', message: errors[0], errors };
}

// ---------------------------------------------------------------- seeded random numbers

// mulberry32: a small, fast generator. The same seed always gives the same sequence.
export function createRng(seed) {
  let a = seed >>> 0;
  return function next() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function attemptSeed(seed, attempt) {
  return (Math.imul(seed >>> 0, 2654435761) + Math.imul(attempt + 1, 40503)) >>> 0;
}

// ---------------------------------------------------------------- greedy fill

const FILL_ORDER = ['N', 'M', 'A'];

function availability(ctx) {
  const { days, leave, P, D } = ctx;
  const weekendDays = days.filter((d) => d.isWeekend).length;
  const days_ = [];
  const weekends = [];
  for (let p = 0; p < P; p++) {
    let a = 0;
    let w = 0;
    for (let d = 0; d < D; d++) {
      if (leave[p].has(d)) continue;
      a++;
      if (days[d].isWeekend) w++;
    }
    days_.push(a);
    weekends.push(w);
  }
  return { days: days_, weekends, totalWeekendDays: weekendDays };
}

function attempt(ctx, rng, attemptNo) {
  const { rules, days, leave, crew, P, D } = ctx;
  const avail = availability(ctx);
  const roster = Array.from({ length: P }, () => new Array(D).fill(OFF));
  const st = Array.from({ length: P }, () => ({ run: 0, nightRun: 0, prev: OFF, offThisWeek: false, nights: 0, weekend: 0, total: 0 }));
  const leaveCount = days.map((_, d) => leave.reduce((n, set) => n + (set.has(d) ? 1 : 0), 0));
  const jitter = Math.min(attemptNo, 5) * 0.5;

  for (let d = 0; d < D; d++) {
    const day = days[d];
    const weekEnd = day.week * 7 + 6;
    if (d % 7 === 0) for (const s of st) s.offThisWeek = false;

    // Who still needs a day off this week, and how many off places are left after today.
    // When the week is running out of off places, people who still need theirs are kept free.
    const needsOff = st.map((s, p) => {
      if (!rules.weeklyOff || s.offThisWeek || leave[p].has(d)) return false;
      for (let f = d + 1; f <= weekEnd; f++) if (leave[p].has(f)) return false;
      return true;
    });
    let futureOffPlaces = 0;
    for (let f = d + 1; f <= weekEnd; f++) futureOffPlaces += P - leaveCount[f] - crew;
    const weekTight = needsOff.filter(Boolean).length > futureOffPlaces;

    const tie = st.map(() => rng());
    const noise = st.map(() => rng() * jitter);
    const assigned = new Array(P).fill(null);
    for (let p = 0; p < P; p++) if (leave[p].has(d)) assigned[p] = LEAVE;

    for (const shift of FILL_ORDER) {
      const need = rules.minPerShift[shift];
      if (need === 0) continue;
      const candidates = [];
      const blocked = {};
      for (let p = 0; p < P; p++) {
        if (assigned[p] !== null) {
          const why = assigned[p] === LEAVE ? 'leave' : 'otherShift';
          blocked[why] = (blocked[why] ?? 0) + 1;
          continue;
        }
        const s = st[p];
        let why = null;
        if (s.run >= rules.maxConsecutiveDays) why = 'maxConsecutiveDays';
        else if (needsOff[p] && d === weekEnd) why = 'weeklyOff';
        else if (shift === 'N' && s.nightRun >= rules.maxConsecutiveNights) why = 'maxConsecutiveNights';
        else if (shift === 'M' && rules.restAfterNight && s.prev === 'N') why = 'restAfterNight';
        if (why) blocked[why] = (blocked[why] ?? 0) + 1;
        else candidates.push(p);
      }
      if (candidates.length < need) {
        return { ok: false, stuck: { day: d, shift, needed: need, eligible: candidates.length, blocked } };
      }
      // Load so far, scaled by the days each person is available, so leave is not held against anyone.
      const key = (p) => {
        const s = st[p];
        const k = [weekTight && needsOff[p] ? 1 : 0];
        // Every other retry prefers to keep last night's crew on Nights (blocks of nights).
        if (shift === 'N' && attemptNo % 2 === 1) k.push(s.prev === 'N' ? 0 : 1);
        if (shift === 'N') k.push((s.nights * D) / avail.days[p]);
        if (day.isWeekend) k.push((s.weekend * avail.totalWeekendDays) / avail.weekends[p]);
        k.push((s.total * D) / avail.days[p] + noise[p], tie[p]);
        return k;
      };
      const keys = new Map(candidates.map((p) => [p, key(p)]));
      candidates.sort((a, b) => {
        const ka = keys.get(a);
        const kb = keys.get(b);
        for (let i = 0; i < ka.length; i++) if (ka[i] !== kb[i]) return ka[i] - kb[i];
        return a - b;
      });
      let picked = candidates.slice(0, need);
      if (shift === 'N' && rules.restAfterNight && rules.minPerShift.M > 0) {
        // Night is filled before Morning. Keep enough people who can still take a Morning
        // (anyone not coming off a Night) so the Morning places can be filled afterwards.
        const canMorning = (p) => st[p].prev !== 'N';
        let spare = candidates.filter(canMorning).length - rules.minPerShift.M;
        const keep = [];
        const skipped = [];
        for (const p of candidates) {
          if (keep.length === need) break;
          if (canMorning(p) && spare <= 0) {
            skipped.push(p);
            continue;
          }
          if (canMorning(p)) spare--;
          keep.push(p);
        }
        picked = keep.concat(skipped).slice(0, need);
      }
      for (const p of picked) assigned[p] = shift;
    }

    for (let p = 0; p < P; p++) {
      const c = assigned[p] ?? OFF;
      roster[p][d] = c;
      const s = st[p];
      if (isWork(c)) {
        s.run++;
        s.total++;
        if (day.isWeekend) s.weekend++;
      } else {
        s.run = 0;
        s.offThisWeek = true;
      }
      if (c === 'N') {
        s.nightRun++;
        s.nights++;
      } else {
        s.nightRun = 0;
      }
      s.prev = c;
    }
  }
  return { ok: true, roster };
}

// ---------------------------------------------------------------- fairness

function countsFor(ctx, roster) {
  const { days, P, D } = ctx;
  const counts = [];
  for (let p = 0; p < P; p++) {
    let nights = 0;
    let weekends = 0;
    let total = 0;
    for (let d = 0; d < D; d++) {
      const c = roster[p][d];
      if (!isWork(c)) continue;
      total++;
      if (c === 'N') nights++;
      if (days[d].isWeekend) weekends++;
    }
    counts.push({ nights, weekends, total });
  }
  return counts;
}

// Each person's fraction of the team total they should carry: days they could work
// (not on leave) divided by the team's days they could work. Weekends use weekend days only.
function shareFractions(ctx, roster) {
  const { days, leave, P, D } = ctx;
  const a = [];
  const w = [];
  for (let p = 0; p < P; p++) {
    let ap = 0;
    let wp = 0;
    for (let d = 0; d < D; d++) {
      if (leave[p].has(d) || roster[p][d] === LEAVE) continue;
      ap++;
      if (days[d].isWeekend) wp++;
    }
    a.push(ap);
    w.push(wp);
  }
  const sumA = a.reduce((x, y) => x + y, 0);
  const sumW = w.reduce((x, y) => x + y, 0);
  return {
    days: a.map((x) => (sumA ? x / sumA : 0)),
    weekends: w.map((x) => (sumW ? x / sumW : 0)),
  };
}

const MEASURES = [
  { key: 'nights', share: 'days' },
  { key: 'weekends', share: 'weekends' },
  { key: 'total', share: 'days' },
];

// The weighted gap that the balancing pass lowers, for one person.
function personGap(totals, fractions, p, c) {
  let gap = 0;
  for (const m of MEASURES) {
    const T = totals[m.key];
    if (T > 0) gap += (WEIGHTS[m.key] * Math.abs(c[m.key] - T * fractions[m.share][p])) / T;
  }
  return gap;
}

// The smallest gap any roster could reach, because shifts come in whole numbers: give everyone
// their fair share rounded down, then hand the leftover shifts to the largest remainders.
export function unavoidableGap(total, shares) {
  const floors = shares.map(Math.floor);
  const rest = shares.map((s, i) => s - floors[i]);
  let leftover = Math.round(total - floors.reduce((a, b) => a + b, 0));
  const order = rest.map((r, i) => i).sort((a, b) => rest[b] - rest[a] || a - b);
  let gap = 0;
  for (const i of order) {
    if (leftover > 0 && rest[i] > 0) {
      gap += 1 - rest[i];
      leftover--;
    } else {
      gap += rest[i];
    }
  }
  return gap;
}

function fairnessCtx(ctx, roster) {
  const counts = countsFor(ctx, roster);
  const fractions = shareFractions(ctx, roster);
  const totals = { nights: 0, weekends: 0, total: 0 };
  for (const c of counts) for (const m of MEASURES) totals[m.key] += c[m.key];

  const parts = {};
  for (const m of MEASURES) {
    const T = totals[m.key];
    const shares = counts.map((_, p) => T * fractions[m.share][p]);
    let gap = 0;
    for (let p = 0; p < ctx.P; p++) gap += Math.abs(counts[p][m.key] - shares[p]);
    const avoidable = Math.max(0, gap - unavoidableGap(T, shares));
    parts[m.key] = T > 0 ? 100 * Math.max(0, 1 - avoidable / T) : 100;
  }
  const exact = MEASURES.reduce((s, m) => s + WEIGHTS[m.key] * parts[m.key], 0);

  const people = counts.map((c, p) => {
    const share = {};
    let load = 0;
    for (const m of MEASURES) {
      share[m.key] = totals[m.key] * fractions[m.share][p];
      if (totals[m.key] > 0) load += (WEIGHTS[m.key] * (c[m.key] - share[m.key])) / totals[m.key];
    }
    return { name: ctx.people[p].name, ...c, share, load };
  });

  let mostLoaded = null;
  let leastLoaded = null;
  if (people.length > 1) {
    let hi = 0;
    let lo = 0;
    people.forEach((person, p) => {
      if (person.load > people[hi].load) hi = p;
      if (person.load < people[lo].load) lo = p;
    });
    if (people[hi].load - people[lo].load > 1e-9) {
      mostLoaded = hi;
      leastLoaded = lo;
    }
  }

  return {
    score: Math.round(exact),
    exactScore: exact,
    parts: { nights: Math.round(parts.nights), weekends: Math.round(parts.weekends), total: Math.round(parts.total) },
    exactParts: parts,
    totals,
    people,
    mostLoaded,
    leastLoaded,
  };
}

// Fairness of any roster, generated or hand-edited. See README for the formula in plain words.
export function fairness(config, roster) {
  const errors = checkInput(config);
  if (errors.length) throw new RangeError(errors[0]);
  return fairnessCtx(makeContext(config), roster);
}

// ---------------------------------------------------------------- balancing pass

// Swaps two people's letters on the same day when that lowers the weighted gap and both rows
// still pass every rule. A same-day swap never changes how many people are on each shift.
function balance(ctx, roster) {
  const { days, P, D } = ctx;
  const counts = countsFor(ctx, roster);
  const fractions = shareFractions(ctx, roster);
  const totals = { nights: 0, weekends: 0, total: 0 };
  for (const c of counts) for (const m of MEASURES) totals[m.key] += c[m.key];

  const after = (c, from, to, weekend) => ({
    nights: c.nights - (from === 'N') + (to === 'N'),
    weekends: c.weekends + (weekend ? isWork(to) - isWork(from) : 0),
    total: c.total - isWork(from) + isWork(to),
  });

  let swaps = 0;
  for (let round = 0; round < MAX_BALANCE_ROUNDS; round++) {
    let improved = false;
    for (let d = 0; d < D; d++) {
      const weekend = days[d].isWeekend;
      for (let p = 0; p < P; p++) {
        for (let q = p + 1; q < P; q++) {
          const a = roster[p][d];
          const b = roster[q][d];
          if (a === b || a === LEAVE || b === LEAVE) continue;
          const cp = after(counts[p], a, b, weekend);
          const cq = after(counts[q], b, a, weekend);
          const delta = personGap(totals, fractions, p, cp) + personGap(totals, fractions, q, cq)
            - personGap(totals, fractions, p, counts[p]) - personGap(totals, fractions, q, counts[q]);
          if (delta >= -1e-12) continue;
          roster[p][d] = b;
          roster[q][d] = a;
          if (rowViolations(ctx, roster[p], p, 1).length || rowViolations(ctx, roster[q], q, 1).length) {
            roster[p][d] = a;
            roster[q][d] = b;
            continue;
          }
          counts[p] = cp;
          counts[q] = cq;
          swaps++;
          improved = true;
        }
      }
    }
    if (!improved) break;
  }
  return swaps;
}

// ---------------------------------------------------------------- generate

const BLOCK_WORDS = {
  otherShift: 'already on another shift that day',
  leave: 'on leave',
  maxConsecutiveDays: 'at the limit of days in a row',
  maxConsecutiveNights: 'at the limit of nights in a row',
  restAfterNight: 'coming off a Night (rest rule)',
  weeklyOff: 'still owed their weekly day off',
};

function notFound(ctx, stuck) {
  const day = ctx.days[stuck.day];
  const parts = Object.entries(stuck.blocked)
    .sort((x, y) => y[1] - x[1])
    .map(([why, n]) => `${n} ${BLOCK_WORDS[why]}`);
  const ruleBlocks = Object.entries(stuck.blocked).filter(([why]) => why !== 'otherShift' && why !== 'leave');
  ruleBlocks.sort((x, y) => y[1] - x[1]);
  const rule = ruleBlocks.length ? ruleBlocks[0][0] : 'staffing';
  return {
    code: 'not-found', proven: false, rule, day: day.iso, shift: stuck.shift, needed: stuck.needed, available: stuck.eligible,
    blocked: stuck.blocked,
    message: `No roster found that meets every rule. The search got stuck on ${formatDay(day)}, ${SHIFT_NAMES[stuck.shift]}: `
      + `${stuck.needed} needed, ${stuck.eligible} could take it${parts.length ? ` (others: ${parts.join(', ')})` : ''}. `
      + 'fairshift is a heuristic, so this is not proof that no roster exists. Try fewer people per shift, a higher limit, or moving some leave.',
  };
}

function normaliseSeed(seed) {
  const n = Number(seed);
  return Number.isFinite(n) ? Math.trunc(Math.abs(n)) >>> 0 : 1;
}

// Builds a roster that meets every rule, or explains why it could not.
// Success: { ok: true, roster, seed, attempts, swaps, greedyScore, score }
// Failure: { ok: false, failure: { code, proven, rule, message, ... } }
export function generate(config) {
  const errors = checkInput(config);
  if (errors.length) return { ok: false, failure: inputFailure(errors) };
  const ctx = makeContext(config);
  const proof = proofs(ctx);
  if (proof) return { ok: false, failure: proof };

  const seed = normaliseSeed(config.seed ?? 1);
  let furthest = null;
  for (let k = 0; k < MAX_ATTEMPTS; k++) {
    const result = attempt(ctx, createRng(attemptSeed(seed, k)), k);
    if (!result.ok) {
      const s = result.stuck;
      const progress = s.day * 3 + FILL_ORDER.indexOf(s.shift);
      if (!furthest || progress > furthest.progress) furthest = { ...s, progress };
      continue;
    }
    const roster = result.roster;
    const greedyScore = fairnessCtx(ctx, roster).score;
    const swaps = balance(ctx, roster);
    const problems = validateCtx(ctx, roster);
    if (problems.length) {
      // Never hand back a roster that breaks a rule. This should not happen; if it does, say so.
      return {
        ok: false,
        failure: { code: 'internal', proven: false, rule: problems[0].rule, message: `Internal check failed: ${problems[0].message}` },
      };
    }
    return { ok: true, roster, seed, attempts: k + 1, swaps, greedyScore, score: fairnessCtx(ctx, roster).score };
  }
  return { ok: false, failure: notFound(ctx, furthest) };
}

// ---------------------------------------------------------------- CSV

// Quotes a cell when needed and stops spreadsheet apps from reading a name as a formula.
export function csvCell(value) {
  let s = String(value ?? '');
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  if (/[",\r\n]/.test(s)) s = `"${s.replace(/"/g, '""')}"`;
  return s;
}

// Header: Name, one column per date (YYYY-MM-DD), Nights, Weekend days, Total shifts.
// One row per person. Lines end with CRLF as RFC 4180 asks.
export function toCSV(config, roster) {
  const errors = checkInput(config);
  if (errors.length) throw new RangeError(errors[0]);
  const ctx = makeContext(config);
  const counts = countsFor(ctx, roster);
  const rows = [['Name', ...ctx.days.map((d) => d.iso), 'Nights', 'Weekend days', 'Total shifts']];
  ctx.people.forEach((person, p) => {
    rows.push([person.name, ...roster[p], counts[p].nights, counts[p].weekends, counts[p].total]);
  });
  return rows.map((row) => row.map(csvCell).join(',')).join('\r\n') + '\r\n';
}
