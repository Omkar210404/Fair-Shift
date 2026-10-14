// fairshift UI: state, rendering and events. All roster logic lives in roster.js.
import {
  buildDays, formatDay, parseTeam, formatTeam, checkInput, generate, validate, fairness, toCSV,
  parseISODate, toISODate, DEFAULT_RULES, LIMITS, RULE_LABELS, SHIFT_NAMES, SHIFTS, LETTERS,
} from './roster.js';
import { loadSaved, save, forget } from './storage.js';
import { sampleSetup } from './sample.js';

const $ = (id) => document.getElementById(id);
const DAY_MS = 86400000;
const DEFAULT_TIMES = { M: ['06:00', '14:00'], A: ['14:00', '22:00'], N: ['22:00', '06:00'] };

function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value === null || value === undefined || value === false) continue;
    if (key === 'class') node.className = value;
    else if (key === 'text') node.textContent = value;
    else if (key === 'dataset') Object.assign(node.dataset, value);
    else if (key.startsWith('on')) node.addEventListener(key.slice(2), value);
    else node.setAttribute(key, value === true ? '' : value);
  }
  for (const child of children.flat()) {
    if (child === null || child === undefined || child === false) continue;
    node.append(child instanceof Node ? child : String(child));
  }
  return node;
}

function nextMonday() {
  const now = new Date();
  const today = Date.UTC(now.getFullYear(), now.getMonth(), now.getDate());
  const dow = new Date(today).getUTCDay();
  return toISODate(today + (((8 - dow) % 7) || 7) * DAY_MS);
}

function freshRules() {
  return { ...DEFAULT_RULES, minPerShift: { ...DEFAULT_RULES.minPerShift } };
}

// ---------------------------------------------------------------- state

const state = {
  people: [],
  startDate: nextMonday(),
  weeks: 4,
  times: structuredClone(DEFAULT_TIMES),
  rules: freshRules(),
  seed: 1,
  roster: null, // null means draft: only leave can be marked
  result: null,
  failure: null,
  edited: false,
  remember: false,
  notice: '',
};
const focus = { p: 0, d: 0 };

const config = () => ({ people: state.people, startDate: state.startDate, weeks: state.weeks, rules: state.rules, seed: state.seed });

function days() {
  try {
    return buildDays(state.startDate, state.weeks);
  } catch {
    return [];
  }
}

function persist() {
  if (!state.remember) return;
  const ok = save({
    version: 1,
    people: state.people, startDate: state.startDate, weeks: state.weeks, times: state.times,
    rules: state.rules, seed: state.seed, roster: state.roster, result: state.result, edited: state.edited,
  });
  if (!ok) {
    state.remember = false;
    $('remember').checked = false;
    $('remember-note').textContent = 'This browser blocked saving. fairshift still works, but nothing is kept after you close the tab.';
  }
}

function restore() {
  const saved = loadSaved();
  if (!saved || saved.version !== 1) return false;
  const candidate = { people: saved.people, startDate: saved.startDate, weeks: saved.weeks, rules: saved.rules, seed: saved.seed };
  if (checkInput(candidate).length) return false;
  Object.assign(state, {
    people: saved.people.map((p) => ({ name: p.name, leave: [...p.leave] })),
    startDate: saved.startDate,
    weeks: saved.weeks,
    times: saved.times ?? structuredClone(DEFAULT_TIMES),
    rules: { ...freshRules(), ...saved.rules, minPerShift: { ...saved.rules.minPerShift } },
    seed: saved.seed ?? 1,
    remember: true,
  });
  if (saved.roster && !validate(config(), saved.roster).some((v) => v.rule === 'invalid')) {
    state.roster = saved.roster;
    state.result = saved.result ?? null;
    state.edited = Boolean(saved.edited);
  }
  state.notice = 'Restored the roster saved on this device.';
  return true;
}

// ---------------------------------------------------------------- changes

function clearRoster(reason) {
  if (state.roster) state.notice = `${reason}, so the roster was cleared. Leave is kept. Press Generate to build a new one.`;
  else state.notice = '';
  state.roster = null;
  state.result = null;
  state.failure = null;
  state.edited = false;
}

function setPeople(people, reason) {
  state.people = people;
  focus.p = Math.min(focus.p, Math.max(0, people.length - 1));
  clearRoster(reason);
  $('team-text').value = formatTeam(state.people);
  persist();
  render();
}

function runGenerate(newSeed) {
  if (newSeed) state.seed = (state.seed % 999999) + 1;
  const hadEdits = state.edited && state.roster;
  const result = generate(config());
  if (result.ok) {
    state.roster = result.roster;
    state.failure = null;
    state.edited = false;
    state.result = { attempts: result.attempts, swaps: result.swaps, greedyScore: result.greedyScore, score: result.score, seed: result.seed };
    const tries = result.attempts === 1 ? 'first attempt' : `attempt ${result.attempts}`;
    const swaps = `${result.swaps} swap${result.swaps === 1 ? '' : 's'}`;
    const effect = result.score === result.greedyScore
      ? `The balancing pass made ${swaps}; the score stayed at ${result.score}.`
      : `The balancing pass made ${swaps}, taking the score from ${result.greedyScore} to ${result.score}.`;
    state.notice = `Roster built with seed ${result.seed} (${tries}). ${effect}${hadEdits ? ' Your manual edits were replaced.' : ''}`;
  } else {
    state.roster = null;
    state.result = null;
    state.failure = result.failure;
    state.notice = '';
  }
  persist();
  render();
}

function leaveSet(p) {
  return new Set(state.people[p].leave);
}

function setLeave(p, iso, on) {
  const set = leaveSet(p);
  if (on) set.add(iso);
  else set.delete(iso);
  state.people[p] = { ...state.people[p], leave: [...set].sort() };
  $('team-text').value = formatTeam(state.people);
}

// Changes one cell. Before a roster exists only leave can be set.
function applyLetter(p, d, letter) {
  const day = days()[d];
  if (!day) return;
  const onLeave = leaveSet(p).has(day.iso);
  if (!state.roster) {
    if (letter === 'L' && !onLeave) setLeave(p, day.iso, true);
    else if ((letter === '' || letter === 'O' || letter === 'L') && onLeave) setLeave(p, day.iso, false);
    else if (SHIFTS.includes(letter)) {
      state.notice = 'Before a roster is generated, cells only take leave (L). Press Generate first to set shifts.';
    }
  } else {
    const prev = state.roster[p][d];
    if (!LETTERS.includes(letter) || letter === prev) return;
    if (letter === 'L') setLeave(p, day.iso, true);
    else if (prev === 'L') setLeave(p, day.iso, false);
    state.roster[p][d] = letter;
    state.edited = true;
    state.notice = `${state.people[p].name}, ${formatDay(day)}: set to ${SHIFT_NAMES[letter]}.`;
  }
  focus.p = p;
  focus.d = d;
  persist();
  render({ refocus: true });
}

// ---------------------------------------------------------------- setup forms

function showErrors(id, messages) {
  const box = $(id);
  box.replaceChildren();
  if (!messages.length) return;
  box.append(el('ul', {}, messages.map((m) => el('li', { text: m }))));
}

function fillForms() {
  $('team-text').value = formatTeam(state.people);
  $('start-date').value = state.startDate;
  $('weeks').value = state.weeks;
  for (const s of SHIFTS) {
    $(`min-${s}`).value = state.rules.minPerShift[s];
    $(`time-${s}-start`).value = state.times[s][0];
    $(`time-${s}-end`).value = state.times[s][1];
  }
  $('max-days').value = state.rules.maxConsecutiveDays;
  $('max-nights').value = state.rules.maxConsecutiveNights;
  $('rest-rule').checked = state.rules.restAfterNight;
  $('weekly-off').checked = state.rules.weeklyOff;
  $('remember').checked = state.remember;
}

function buildTimeFields() {
  const box = $('times-fields');
  box.append(el('span', { class: 'times-head', 'aria-hidden': 'true' }, 'Start'), el('span', { class: 'times-head', 'aria-hidden': 'true' }, 'End'));
  for (const s of SHIFTS) {
    box.append(
      el('span', { class: 'label times-name', id: `time-${s}-label` }, `${SHIFT_NAMES[s]} (${s})`),
      el('input', { class: 'input num', id: `time-${s}-start`, type: 'time', 'aria-label': `${SHIFT_NAMES[s]} start (HH:MM)` }),
      el('input', { class: 'input num', id: `time-${s}-end`, type: 'time', 'aria-label': `${SHIFT_NAMES[s]} end (HH:MM)` }),
    );
  }
}

function readInt(id) {
  const raw = $(id).value.trim();
  return /^-?\d+$/.test(raw) ? Number(raw) : NaN;
}

function onSetTeam(event) {
  event.preventDefault();
  const { people, errors } = parseTeam($('team-text').value);
  $('team-text').setAttribute('aria-invalid', errors.length ? 'true' : 'false');
  showErrors('team-errors', errors.map((e) => (e.line ? `Line ${e.line}: ${e.message}` : e.message)));
  if (errors.length) return;
  setPeople(people, 'The team changed');
  state.notice = state.notice || `Team set: ${people.length} ${people.length === 1 ? 'person' : 'people'}.`;
  render();
}

function onAddPerson() {
  const input = $('add-name');
  const { people, errors } = parseTeam(input.value.replace(/[,:]/g, ' '));
  const problems = errors.map((e) => e.message);
  if (!people.length && !problems.length) problems.push('Type a name first.');
  const name = people[0]?.name;
  if (name && state.people.some((p) => p.name.toLowerCase() === name.toLowerCase())) problems.push(`"${name}" is already in the team.`);
  if (state.people.length >= LIMITS.people.max) problems.push(`A team can have at most ${LIMITS.people.max} people.`);
  input.setAttribute('aria-invalid', problems.length ? 'true' : 'false');
  showErrors('add-errors', problems);
  if (problems.length) return;
  input.value = '';
  setPeople([...state.people, { name, leave: [] }], 'The team changed');
  input.focus();
}

function onRemovePerson(index) {
  const name = state.people[index].name;
  setPeople(state.people.filter((_, i) => i !== index), 'The team changed');
  state.notice = `${name} removed. ${state.notice}`.trim();
  render();
  const buttons = $('team-list').querySelectorAll('button');
  (buttons[Math.min(index, buttons.length - 1)] ?? $('add-name')).focus();
}

function onSetDates(event) {
  event.preventDefault();
  const startDate = $('start-date').value;
  const weeks = readInt('weeks');
  const errors = [];
  if (parseISODate(startDate) === null) errors.push('Pick a start date.');
  if (!Number.isInteger(weeks) || weeks < LIMITS.weeks.min || weeks > LIMITS.weeks.max) errors.push('Weeks must be a whole number from 1 to 6.');
  $('start-date').setAttribute('aria-invalid', parseISODate(startDate) === null ? 'true' : 'false');
  $('weeks').setAttribute('aria-invalid', errors.some((e) => e.startsWith('Weeks')) ? 'true' : 'false');
  showErrors('dates-errors', errors);
  if (errors.length) return;
  state.startDate = startDate;
  state.weeks = weeks;
  focus.d = Math.min(focus.d, weeks * 7 - 1);
  clearRoster('The dates changed');
  if (!state.notice) state.notice = `Dates set: ${weeks} week${weeks === 1 ? '' : 's'} from ${formatDay(days()[0])}.`;
  persist();
  render();
}

function onSetTimes(event) {
  event.preventDefault();
  const errors = [];
  const times = {};
  for (const s of SHIFTS) {
    const start = $(`time-${s}-start`).value;
    const end = $(`time-${s}-end`).value;
    if (!/^\d{2}:\d{2}$/.test(start) || !/^\d{2}:\d{2}$/.test(end)) errors.push(`${SHIFT_NAMES[s]} needs a start and end time in HH:MM.`);
    times[s] = [start, end];
  }
  showErrors('times-errors', errors);
  if (errors.length) return;
  state.times = times;
  state.notice = 'Shift times set. They are shown in the key and on the printout.';
  persist();
  render();
}

function onSetRules(event) {
  event.preventDefault();
  const rules = {
    minPerShift: { M: readInt('min-M'), A: readInt('min-A'), N: readInt('min-N') },
    maxConsecutiveDays: readInt('max-days'),
    maxConsecutiveNights: readInt('max-nights'),
    restAfterNight: $('rest-rule').checked,
    weeklyOff: $('weekly-off').checked,
  };
  const errors = checkInput({ people: [{ name: 'x', leave: [] }], startDate: '2026-01-05', weeks: 1, rules });
  showErrors('rules-errors', errors);
  const bad = (id, rangeKey, value) => $(id).setAttribute('aria-invalid', Number.isInteger(value) && value >= LIMITS[rangeKey].min && value <= LIMITS[rangeKey].max ? 'false' : 'true');
  for (const s of SHIFTS) bad(`min-${s}`, 'minPerShift', rules.minPerShift[s]);
  bad('max-days', 'maxConsecutiveDays', rules.maxConsecutiveDays);
  bad('max-nights', 'maxConsecutiveNights', rules.maxConsecutiveNights);
  if (errors.length) return;
  state.rules = rules;
  state.failure = null;
  state.notice = state.roster
    ? 'Rules set. The roster below has been checked against the new rules; press Generate to rebuild it under them.'
    : 'Rules set.';
  persist();
  render();
}

function loadSample() {
  const sample = sampleSetup(nextMonday());
  Object.assign(state, {
    people: sample.people, startDate: sample.startDate, weeks: sample.weeks,
    rules: sample.rules, times: structuredClone(DEFAULT_TIMES), seed: 1,
  });
  focus.p = 0;
  focus.d = 0;
  fillForms();
  for (const id of ['team-errors', 'add-errors', 'dates-errors', 'times-errors', 'rules-errors']) showErrors(id, []);
  runGenerate(false);
}

function clearAll() {
  // eslint-disable-next-line no-alert
  if (state.people.length && !window.confirm('Clear the team, leave, rules and roster?')) return;
  Object.assign(state, {
    people: [], startDate: nextMonday(), weeks: 4, times: structuredClone(DEFAULT_TIMES), rules: freshRules(),
    seed: 1, roster: null, result: null, failure: null, edited: false, notice: 'Everything cleared.',
  });
  fillForms();
  persist();
  render();
}

function onRememberChange() {
  state.remember = $('remember').checked;
  if (state.remember) {
    $('remember-note').textContent = 'Saved in this browser only. Untick to remove it. Do not save real staff data on a shared computer.';
    persist();
  } else {
    forget();
    $('remember-note').textContent = 'Not saved. Anything saved before has been removed from this browser.';
  }
}

// ---------------------------------------------------------------- export and print

function exportCSV() {
  if (!state.roster) return;
  const csv = toCSV(config(), state.roster);
  const blob = new Blob(['﻿', csv], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const link = el('a', { href: url, download: `fairshift-roster-${state.startDate}.csv` });
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  state.notice = 'CSV downloaded. It opens in any spreadsheet app.';
  render();
}

// ---------------------------------------------------------------- picker

let pickerFor = null;

function openPicker(p, d, anchor) {
  const picker = $('picker');
  const day = days()[d];
  const current = cellLetter(p, d, day);
  const options = state.roster
    ? LETTERS.map((l) => ({ letter: l, label: SHIFT_NAMES[l], time: state.times[l] }))
    : [{ letter: 'L', label: 'Leave' }, { letter: '', label: 'Not on leave' }];
  picker.replaceChildren(
    el('p', { class: 'picker-title', id: 'picker-title' }, `${state.people[p].name}, ${formatDay(day)}`),
    ...options.map((o) => el('button', {
      type: 'button', class: 'picker-item', role: 'menuitemradio', 'aria-checked': String(o.letter === current),
      dataset: { letter: o.letter },
    },
    el('span', { class: `swatch s-${o.letter || 'O'}`, 'aria-hidden': 'true' }, o.letter || '-'),
    o.label,
    o.time ? el('span', { class: 'time' }, `${o.time[0]} to ${o.time[1]}`) : null)),
  );
  picker.setAttribute('aria-labelledby', 'picker-title');
  picker.hidden = false;
  const rect = anchor.getBoundingClientRect();
  const width = picker.offsetWidth;
  const height = picker.offsetHeight;
  let left = rect.left + window.scrollX;
  let top = rect.bottom + window.scrollY + 4;
  left = Math.max(window.scrollX + 8, Math.min(left, window.scrollX + document.documentElement.clientWidth - width - 8));
  if (rect.bottom + height + 8 > window.innerHeight) top = rect.top + window.scrollY - height - 4;
  picker.style.left = `${left}px`;
  picker.style.top = `${Math.max(window.scrollY + 8, top)}px`;
  pickerFor = { p, d };
  const items = [...picker.querySelectorAll('.picker-item')];
  (items.find((b) => b.getAttribute('aria-checked') === 'true') ?? items[0]).focus();
}

function closePicker(returnFocus) {
  const picker = $('picker');
  if (picker.hidden) return;
  picker.hidden = true;
  const target = pickerFor;
  pickerFor = null;
  if (returnFocus && target) focusCell(target.p, target.d);
}

function onPickerClick(event) {
  const item = event.target.closest('.picker-item');
  if (!item || !pickerFor) return;
  const { p, d } = pickerFor;
  closePicker(false);
  applyLetter(p, d, item.dataset.letter);
}

function onPickerKey(event) {
  const items = [...$('picker').querySelectorAll('.picker-item')];
  const i = items.indexOf(document.activeElement);
  if (event.key === 'Escape') {
    event.preventDefault();
    closePicker(true);
  } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
    event.preventDefault();
    const next = (i + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
    items[next].focus();
  } else if (event.key === 'Tab') {
    closePicker(true);
    event.preventDefault();
  } else if (pickerFor && state.roster && LETTERS.includes(event.key.toUpperCase()) && !event.ctrlKey && !event.metaKey) {
    event.preventDefault();
    const { p, d } = pickerFor;
    closePicker(false);
    applyLetter(p, d, event.key.toUpperCase());
  }
}

// ---------------------------------------------------------------- grid

function cellLetter(p, d, day) {
  if (state.roster) return state.roster[p][d];
  return leaveSet(p).has(day.iso) ? 'L' : '';
}

function cellButton(p, d) {
  return $('grid').querySelector(`button[data-p="${p}"][data-d="${d}"]`);
}

function focusCell(p, d, flash = false) {
  const D = state.weeks * 7;
  const P = state.people.length;
  if (!P) return;
  focus.p = Math.max(0, Math.min(P - 1, p));
  focus.d = Math.max(0, Math.min(D - 1, d));
  for (const b of $('grid').querySelectorAll('button[tabindex="0"]')) b.tabIndex = -1;
  const btn = cellButton(focus.p, focus.d);
  if (!btn) return;
  btn.tabIndex = 0;
  btn.focus({ preventScroll: true });
  btn.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  if (flash) {
    btn.classList.remove('flash');
    void btn.offsetWidth;
    btn.classList.add('flash');
  }
}

function onGridKey(event) {
  const btn = event.target.closest('button.cell');
  if (!btn) return;
  const p = Number(btn.dataset.p);
  const d = Number(btn.dataset.d);
  const moves = { ArrowLeft: [0, -1], ArrowRight: [0, 1], ArrowUp: [-1, 0], ArrowDown: [1, 0] };
  if (moves[event.key]) {
    event.preventDefault();
    focusCell(p + moves[event.key][0], d + moves[event.key][1]);
  } else if (event.key === 'Home') {
    event.preventDefault();
    focusCell(event.ctrlKey ? 0 : p, 0);
  } else if (event.key === 'End') {
    event.preventDefault();
    focusCell(event.ctrlKey ? state.people.length - 1 : p, state.weeks * 7 - 1);
  } else if (event.key === 'Delete' || event.key === 'Backspace') {
    if (!state.roster) {
      event.preventDefault();
      applyLetter(p, d, '');
    }
  } else if (!event.ctrlKey && !event.metaKey && !event.altKey && LETTERS.includes(event.key.toUpperCase())) {
    event.preventDefault();
    applyLetter(p, d, event.key.toUpperCase());
  }
}

function renderGrid(dayList, flags) {
  const table = $('grid');
  const P = state.people.length;
  const head = el('tr', {}, el('th', { class: 'corner', scope: 'col' }, 'Name'));
  for (const day of dayList) {
    const short = flags.days.get(day.index);
    head.append(el('th', {
      scope: 'col',
      class: [day.isWeekend && 'weekend', day.index % 7 === 0 && day.index > 0 && 'week-start', short && 'short'].filter(Boolean).join(' '),
      'aria-label': `${formatDay(day)}${short ? `. Short-staffed: ${short.join(' ')}` : ''}`,
      title: short ? short.join('\n') : formatDay(day),
    }, day.weekday.slice(0, 2), el('span', { class: 'dn' }, String(day.dayOfMonth))));
  }
  const body = el('tbody');
  for (let p = 0; p < P; p++) {
    const name = state.people[p].name;
    const row = el('tr', {}, el('th', { class: 'name', scope: 'row', title: name }, name));
    for (const day of dayList) {
      const d = day.index;
      const letter = cellLetter(p, d, day);
      const problems = flags.cells.get(`${p}:${d}`);
      const label = `${name}, ${formatDay(day)}: ${letter ? SHIFT_NAMES[letter] : 'not set'}${problems ? `. Warning: ${problems.join(' ')}` : ''}`;
      row.append(el('td', { class: [day.isWeekend && 'weekend', d % 7 === 0 && d > 0 && 'week-start'].filter(Boolean).join(' ') || null },
        el('button', {
          type: 'button',
          class: `cell s-${letter || 'none'}${problems ? ' warn' : ''}`,
          tabindex: p === focus.p && d === focus.d ? '0' : '-1',
          'aria-label': label,
          'aria-haspopup': 'menu',
          title: problems ? problems.join('\n') : null,
          dataset: { p: String(p), d: String(d) },
        }, letter || '·')));
    }
    body.append(row);
  }
  table.replaceChildren(el('thead', {}, head), body);
}

function renderLegend() {
  const legend = $('legend');
  legend.replaceChildren(...LETTERS.map((l) => el('li', {},
    el('span', { class: `swatch s-${l}`, 'aria-hidden': 'true' }, l),
    SHIFT_NAMES[l],
    state.times[l] ? el('span', { class: 'time' }, `${state.times[l][0]} to ${state.times[l][1]}`) : null)));
}

function renderWarnings(violations, dayList) {
  const summary = $('warn-summary');
  const list = $('warn-list');
  list.replaceChildren();
  if (!state.roster) {
    summary.className = 'warn-summary';
    summary.textContent = 'Rules are checked once a roster is generated.';
    return;
  }
  if (!violations.length) {
    summary.className = 'warn-summary ok';
    summary.textContent = 'Every rule is met.';
    return;
  }
  summary.className = 'warn-summary bad';
  summary.textContent = `${violations.length} rule${violations.length === 1 ? ' is' : 's are'} broken. Flagged cells have a red border and corner mark.`;
  for (const v of violations) {
    const target = v.person === null ? { p: 0, d: v.day ?? 0 } : { p: v.person, d: v.cells[0] ?? v.day };
    list.append(el('li', {},
      el('span', {}, el('span', { class: 'rule' }, RULE_LABELS[v.rule] ?? v.rule), v.message),
      dayList[target.d] ? el('button', {
        type: 'button', class: 'button tiny', 'aria-label': `Show on the grid: ${v.message}`,
        onclick: () => focusCell(target.p, target.d, true),
      }, 'Show') : null));
  }
}

function fmt(n) {
  return Number.isInteger(n) ? String(n) : n.toFixed(1);
}

function renderFairness() {
  const empty = $('fair-empty');
  const body = $('fair-body');
  if (!state.roster) {
    empty.hidden = false;
    body.hidden = true;
    return;
  }
  const f = fairness(config(), state.roster);
  empty.hidden = true;
  body.hidden = false;
  $('score').textContent = String(f.score);
  const parts = [['Nights', 'nights', '40%'], ['Weekend days', 'weekends', '40%'], ['Total shifts', 'total', '20%']];
  $('parts').replaceChildren(...parts.map(([label, key, weight]) => {
    const bar = el('span');
    bar.style.width = `${f.exactParts[key]}%`;
    return el('div', {},
      el('dt', {}, `${label} `, el('span', { class: 'visually-hidden' }, `(weight ${weight})`)),
      el('dd', {}, String(f.parts[key])),
      el('span', { class: 'bar', 'aria-hidden': 'true' }, bar));
  }));

  const describe = (i) => {
    const person = f.people[i];
    return `${person.name}: ${person.nights} nights (fair share ${fmt(person.share.nights)}), `
      + `${person.weekends} weekend days (${fmt(person.share.weekends)}), ${person.total} shifts (${fmt(person.share.total)})`;
  };
  $('loaded').textContent = f.mostLoaded === null
    ? 'As even as whole shifts allow. Any difference left is a shift that had to go to someone, so nobody is marked as most or least loaded.'
    : `Most loaded, ${describe(f.mostLoaded)}. Least loaded, ${describe(f.leastLoaded)}. `
      + 'Load is measured against each person\'s fair share with the same weights as the score.';

  $('people-body').replaceChildren(...f.people.map((person, i) => {
    const most = i === f.mostLoaded;
    const least = i === f.leastLoaded;
    return el('tr', { class: most ? 'row-most' : least ? 'row-least' : null },
      el('th', { scope: 'row' }, person.name,
        most ? el('span', { class: 'tag most' }, 'Most loaded') : null,
        least ? el('span', { class: 'tag least' }, 'Least loaded') : null),
      el('td', { class: 'n', title: `Fair share ${fmt(person.share.nights)}` }, String(person.nights)),
      el('td', { class: 'n', title: `Fair share ${fmt(person.share.weekends)}` }, String(person.weekends)),
      el('td', { class: 'n', title: `Fair share ${fmt(person.share.total)}` }, String(person.total)));
  }));
}

function renderFailure() {
  const box = $('failure');
  const f = state.failure;
  if (!f) {
    box.hidden = true;
    box.replaceChildren();
    return;
  }
  const rules = f.rules ?? [f.rule];
  box.replaceChildren(
    el('h3', {}, f.proven ? 'This cannot be done' : 'No roster found'),
    el('p', {}, f.message
      .replace(/^This cannot be done: /, '')
      .replace(/^No roster found that meets every rule\. /, '')
      .replace(/^./, (c) => c.toUpperCase())),
    el('p', {}, rules.map((r) => el('span', { class: 'rule-tag' }, `Rule: ${RULE_LABELS[r] ?? r}`))),
  );
  box.hidden = false;
}

function renderTeamList() {
  const list = $('team-list');
  list.replaceChildren(...state.people.map((person, i) => el('li', {},
    el('span', { class: 'who', title: person.name }, person.name),
    person.leave.length ? el('span', { class: 'leave-count' }, `${person.leave.length} leave`) : null,
    el('button', { type: 'button', class: 'button tiny', 'aria-label': `Remove ${person.name}`, onclick: () => onRemovePerson(i) }, 'Remove'))));
}

function render({ refocus = false } = {}) {
  const dayList = days();
  const hasTeam = state.people.length > 0;
  renderTeamList();
  renderFailure();
  $('status').textContent = state.notice;
  $('empty').hidden = hasTeam;
  $('grid-wrap').hidden = !hasTeam;
  $('generate').disabled = !hasTeam;
  $('regenerate').disabled = !state.roster;
  $('export-csv').disabled = !state.roster;
  $('print').disabled = !state.roster;
  $('range').textContent = dayList.length
    ? `${formatDay(dayList[0])} to ${formatDay(dayList[dayList.length - 1])}, ${state.weeks} week${state.weeks === 1 ? '' : 's'}, ${state.people.length} ${state.people.length === 1 ? 'person' : 'people'}${state.result ? `, seed ${state.seed}` : ''}`
    : '';
  $('grid-hint').textContent = state.roster
    ? 'Click a cell or press Enter to change it. With a cell focused, arrow keys move and M, A, N, O or L set it.'
    : 'Before generating, click a cell (or focus it and press L) to mark leave. Leave is always respected.';

  const flags = { cells: new Map(), days: new Map() };
  let violations = [];
  if (state.roster) {
    violations = validate(config(), state.roster);
    for (const v of violations) {
      if (v.person === null && v.day !== null) {
        const list = flags.days.get(v.day) ?? [];
        list.push(v.message);
        flags.days.set(v.day, list);
      }
      for (const d of v.cells) {
        const key = `${v.person}:${d}`;
        const list = flags.cells.get(key) ?? [];
        list.push(v.message);
        flags.cells.set(key, list);
      }
    }
  }
  if (hasTeam && dayList.length) {
    renderLegend();
    renderGrid(dayList, flags);
    renderWarnings(violations, dayList);
  }
  renderFairness();
  $('print-head').replaceChildren(
    el('h1', {}, 'fairshift roster'),
    el('p', {}, `${$('range').textContent}. Printed ${new Date().toLocaleDateString()}. `
      + `${violations.length ? `${violations.length} rule warnings, listed under the grid.` : 'Every rule is met.'}`),
  );
  if (refocus) focusCell(focus.p, focus.d);
}

// ---------------------------------------------------------------- start

function start() {
  $('boot-note').hidden = true;
  buildTimeFields();
  const restored = restore();
  fillForms();

  $('team-form').addEventListener('submit', onSetTeam);
  $('add-button').addEventListener('click', onAddPerson);
  $('add-name').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      onAddPerson();
    }
  });
  $('dates-form').addEventListener('submit', onSetDates);
  $('times-form').addEventListener('submit', onSetTimes);
  $('rules-form').addEventListener('submit', onSetRules);
  $('load-sample').addEventListener('click', loadSample);
  $('empty-sample').addEventListener('click', loadSample);
  $('clear-all').addEventListener('click', clearAll);
  $('remember').addEventListener('change', onRememberChange);
  $('generate').addEventListener('click', () => runGenerate(false));
  $('regenerate').addEventListener('click', () => runGenerate(true));
  $('export-csv').addEventListener('click', exportCSV);
  $('print').addEventListener('click', () => window.print());

  const grid = $('grid');
  grid.addEventListener('click', (e) => {
    const btn = e.target.closest('button.cell');
    if (!btn) return;
    focusCell(Number(btn.dataset.p), Number(btn.dataset.d));
    openPicker(Number(btn.dataset.p), Number(btn.dataset.d), btn);
  });
  grid.addEventListener('keydown', onGridKey);
  const picker = $('picker');
  picker.addEventListener('click', onPickerClick);
  picker.addEventListener('keydown', onPickerKey);
  document.addEventListener('mousedown', (e) => {
    if (!picker.hidden && !picker.contains(e.target) && !e.target.closest('button.cell')) closePicker(false);
  });
  window.addEventListener('resize', () => closePicker(false));
  $('grid-scroll').addEventListener('scroll', () => closePicker(false), { passive: true });
  window.addEventListener('hashchange', () => {
    if (window.location.hash === '#sample') loadSample();
  });

  if (window.location.hash === '#sample' && !restored) loadSample();
  else render();
}

start();
