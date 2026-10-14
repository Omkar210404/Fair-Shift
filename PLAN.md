# fairshift: build plan

A fair shift roster planner for factory and shop-floor teams.
Tagline: "Rosters your whole team can call fair."

Status: approved on 2026-10-14 with the recommendations in section 1, plus one addition: every input must be typed in a clear, stated format and applied with a button (see "Input formats" below).

### Input formats (added at approval)

Every setup section shows its format next to the box and has its own Set button. Nothing changes until Set is pressed, and a bad line is reported with its line number instead of being skipped.

- Team: one person per line. A line can carry leave after a colon: `Asha Sample: 2026-11-05, 2026-11-06` or a range `2026-11-10 to 2026-11-12`. Names may also be comma-separated on one line when no leave is given.
- Dates: start date in `YYYY-MM-DD`, weeks 1 to 6.
- Shift times: `HH:MM` start and end for M, A, N.
- Rules: whole numbers within stated ranges, and two checkboxes.

The team text is parsed by `parseTeam` in `roster.js`, so the format is covered by tests.

## 1. Decisions (answered: go with the recommendations)

These four change what gets built. Each has a recommendation, so "go with your recommendations" is a complete answer.

1. **ES modules and "open index.html" do not fully go together.** Chrome and Edge refuse to load `src/app.js` as a module from a `file://` page, so a double-click on `index.html` shows a blank app in those browsers. It works from GitHub Pages and from any local static server.
   - Recommended: keep ES modules as you asked. The README says "use the live demo, or run `python -m http.server` in the folder". I will test what a double-click really does in Edge and Chrome and write down the true result.
   - Alternative: plain non-module scripts, which do work on a double-click, but then `roster.js` is not an ES module.
2. **"Minimum people per shift" is used as the crew size.** Each shift gets exactly that many people each day and everyone else is Off. With 12 people and 3 per shift, 9 work and 3 rest each day, about 5 shifts a week each. This keeps the method simple and easy to explain. The alternative (fill everyone up to their limit) needs an extra "working days per week" input and more rules.
3. **Fonts are system fonts, not web fonts.** A serif stack (Iowan Old Style, Palatino, Georgia) for headings and the system sans for the UI. This means zero network requests and no font files in the repo. Loading Google Fonts would break the "no requests leave the browser" promise.
4. **GitHub account and push.** Your git name is `Omkar210404`. I need to know the GitHub username for the CI badge and demo link (`https://<user>.github.io/fairshift/`), and whether you want me to push or you will do it. I will not push without your say-so. Pages must be switched on once in the repo settings (Source: GitHub Actions), which only you can do.

Smaller choices I made (tell me if any is wrong):

- The colour scheme is the warm off-white look from this brief, not the dark theme used in your other portfolio apps.
- Minimum staffing is three small inputs (one each for M, A, N), since night crews are often smaller.
- A week is a 7-day block counted from the start date. Weekend means Saturday and Sunday.
- Leave is shown as `L` in the grid and the CSV, so it is not confused with a normal Off. A leave day counts as a day off for the weekly-off and consecutive-day rules.
- One click target, one picker: clicking a cell opens a small menu with M, A, N, O and Leave. This covers both "mark leave" and "change a cell by hand".
- Generate and Regenerate keep leave but replace manual edits.
- Saving to localStorage is a "Remember on this device" checkbox, off by default.
- Opening `index.html#sample` loads the sample team straight away. The README demo link and the screenshot use it.
- No `.env.example` or `requirements.txt`: the app has no secrets and no dependencies.

## 2. Structure

```
fairshift/
  index.html            page shell, CSP meta tag, all labels
  styles/
    app.css             tokens, layout, grid, panels
    print.css           A4 landscape notice-board view
  src/
    roster.js           all roster logic, no DOM, no browser APIs
    app.js              state, rendering, events
    storage.js          localStorage in try/catch, safe when blocked
    sample.js           12 made-up names, 4 weeks, a few leave days
  tests/
    roster.test.js      node --test
  docs/
    screenshot.png      real capture from the running app
  .github/workflows/
    ci.yml              runs the tests on push and pull request
    pages.yml           deploys the static files to GitHub Pages
  package.json          "type": "module", test script, zero dependencies
  README.md  LICENSE (MIT)  .gitignore  PLAN.md
  .claude/settings.json attribution off, folder ignored by git
```

What `roster.js` exports:

| Function | What it returns |
|---|---|
| `buildDays(startDate, weeks)` | The list of days with date, weekday, weekend flag, week number. Dates are handled in UTC so time zones cannot shift a day. |
| `checkFeasibility(config)` | Problems that can be proven by counting, before any search. |
| `generate(config)` | `{ ok: true, roster, seed, attempts, swaps }` or `{ ok: false, failure }`. |
| `validate(config, roster)` | Every broken rule, with person, day and a plain message. |
| `fairness(config, roster)` | Per-person counts, fair shares, the three part scores, the overall score, most and least loaded. |
| `toCSV(config, roster)` | The CSV text. |

A roster is a table of letters: one row per person, one letter per day (`M`, `A`, `N`, `O`, `L`).

CSP: `default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'none'; base-uri 'none'; form-action 'none'`. No inline scripts or inline style attributes.

## 3. How the roster is built

Step 0, count first. Before searching, check what can be proven impossible by simple counting:

- the team is smaller than one day's total crew
- on a given date, the people not on leave are fewer than that day's crew
- the whole roster needs more shifts than the team can work once weekly offs and leave are taken out

If any of these is true, the app stops and says "This cannot be done", with the rule, the date and the numbers.

Step 1, greedy fill. Go through the days in order. On each day fill Night first, then Morning, then Afternoon, because Night has the most rules attached. For each open place:

1. List the people who can take it without breaking a rule: not on leave, not already working that day, not over the consecutive-day limit, not over the consecutive-night limit, not a Morning straight after a Night, and still able to get a day off that week.
2. From that list pick the person who has done the least of that kind of work so far (fewest nights for a Night, fewest weekend days on a weekend), then fewest shifts overall.
3. Break ties with the seeded random number generator.

Everyone not picked is Off.

If a place cannot be filled, the attempt is dropped and a new one starts with a different tie-break order taken from the same seed. Up to 25 attempts. Same seed, same inputs, same result every time.

Step 2, balancing pass. Look at every day and every pair of people with different letters on that day. Swap the two if both people still pass every rule and the unfairness number (section 4) goes down. A swap inside one day never changes how many people are on each shift, so staffing stays correct. Repeat until no swap helps or 50 rounds have passed.

Step 3, final gate. The finished roster goes through `validate`. A roster that breaks any rule is never returned.

If no attempt succeeds, the app says "No roster found" and names where the search got stuck: the date, the shift, how many were needed, how many were eligible, and which rule blocked the most people. It also says this is a heuristic, so "not found" is not proof that no roster exists. The two messages, "cannot be done" and "not found", are kept separate on purpose.

What it does not do: it does not search every possibility, so it does not promise the fairest roster that exists. It does not know about the roster before the start date, so a night worked the day before is not seen.

## 4. Fairness score

Three things are counted per person: nights, weekend days worked, and total shifts.

Fair share. The team's total is split in proportion to the days each person could have worked, meaning days not on leave. With no leave this is the team average. Someone on leave for a week is not expected to catch up on nights afterwards.

Part score, worked the same way for each of the three counts:

```
gap         = sum over people of | actual - fair share |
unavoidable = the gap of the best whole-number split (shares rounded, leftovers to the largest remainders)
part score  = 100 x (1 - (gap - unavoidable) / team total), never below 0
```

The "unavoidable" term was added during the build. The sweep in `tools/sweep.js` showed a correct roster scoring 0 when 7 shifts were shared by 22 people, because most people must get 0 and some 1. Not counting what whole shifts make unavoidable fixed that, and 100 now means "as even as whole shifts allow".

Example: 12 people, 84 nights, fair share 7 each. If everyone has 7, the gap is 0 and the part score is 100. If six people do 14 each and six do none, the gap is 84 and the part score is 0.

Overall score:

```
score = 0.4 x nights + 0.4 x weekend days + 0.2 x total shifts
```

Rounded to a whole number from 0 to 100. Nights and weekends carry more weight because they are what people complain about.

The balancing pass lowers the same weighted gap, so the pass and the score always agree.

Most and least loaded: the person furthest above and furthest below their fair share, using the same weights. If everyone is level, nobody is highlighted.

When the shifts do not divide evenly (85 nights among 12 people), the best possible split still scores 100, because the leftover night has to go to someone.

## 5. UI layout

```
+----------------------------------------------------------------------+
| fairshift   Rosters your whole team can call fair.                   |
+----------------+-------------------------------------+---------------+
| SETUP          | ROSTER                              | FAIRNESS      |
| Team           | [Generate] [Regenerate]  [CSV][Print]|  Score  94    |
|  name list     | Legend: M A N O L       Seed 3      |  how it is    |
|  add / paste   | +------+--+--+--+--+--+--+--+--     |  worked out   |
| Dates          | | Name |Mo|Tu|We|Th|Fr|Sa|Su| ...   |  Nights   96  |
|  start, weeks  | +------+--+--+--+--+--+--+--+--     |  Weekends 91  |
| Shift times    | | ...  |M |M |O |N |N |A |O |       |  Total    97  |
| Rules          | +------+--+--+--+--+--+--+--+--     |               |
|  crew M A N    |                                     | Name   N  W  T|
|  max days      | Warnings (list, each jumps to cell) | ...    7  4 21|
|  max nights    |                                     | Most loaded   |
|  rest rule     |                                     | Least loaded  |
|  weekly off    |                                     |               |
| [Load sample]  |                                     |               |
+----------------+-------------------------------------+---------------+
| How it works. Planning aid only, not a labour-law check.             |
+----------------------------------------------------------------------+
```

- Under about 1100px the fairness panel moves below the grid. Under about 760px setup moves to the top and can be folded shut.
- The grid is a real table. Header row and name column are sticky. All cells are the same fixed size. The grid scrolls sideways inside its own box, so the page never scrolls sideways.
- Keyboard: one Tab stop for the grid, arrow keys move between cells, `M` `A` `N` `O` `L` set the cell, Enter opens the picker. Each cell has a spoken label such as "Asha Sample, Mon 2 Nov, Night".
- A broken rule puts a marked border and a corner flag on the cell, and a line in the warnings list. Staffing shortfalls are flagged on the date header.
- Colour: warm off-white page, deep ink text, one accent (a muted teal) for buttons and focus rings. Shift cells get a soft tint plus the letter. Text contrast is checked to be at least 4.5 to 1.
- Type: serif headings, sans UI, tabular numerals in the grid and tables, numbers right-aligned.
- States: an empty state with "Load sample team", an error state for "cannot be done" and "not found", and the "How it works" note.
- Print: A4 landscape, 10 mm margins, controls hidden, the grid scaled to fit 6 weeks across, the fairness table underneath.
- Limits: 1 to 6 weeks, up to 50 people, no duplicate names.

## 6. Tests

All in `tests/roster.test.js`, run with `node --test`.

Generation
1. Every shift on every day has at least the minimum crew.
2. No Morning directly after a Night when the rest rule is on.
3. Nobody works more than the maximum consecutive days.
4. Nobody works more than the maximum consecutive nights.
5. Everyone has at least one day off in every week.
6. Nobody is given a shift on a leave day.
7. The same seed and inputs give the same roster, and a different seed gives a different one.
8. Tests 1 to 6 also hold across a range of seeds and team sizes, not just one lucky case.

Failure
9. Too few people returns `ok: false` and names the staffing rule.
10. Too many people on leave on one date returns `ok: false` and names that date.
11. A failed result never contains a roster.

Validation
12. A hand-made roster with each kind of broken rule is reported with the right rule, person and day.
13. A clean roster reports nothing.

Fairness
14. A perfectly even roster scores 100.
15. A lopsided roster scores lower, and a more lopsided one lower still.
16. The score stays between 0 and 100.
17. Leave changes the fair share as described in section 4.
18. The balancing pass never makes the score worse than the greedy result.
19. Most and least loaded are the right people in a known case.

CSV and dates
20. Header row, one row per person, dates in `YYYY-MM-DD`, the three count columns, CRLF line ends.
21. Names with commas or quotes are escaped correctly.
22. A name starting with `=`, `+`, `-` or `@` is made safe so a spreadsheet does not run it as a formula.
23. Weekend days and week numbers are right, including across a month end.

The UI is checked by hand in a real browser: the sample team, an impossible setup, manual edits that break each rule, keyboard-only use, phone width, CSV opened in a spreadsheet, and print preview. The README reports only what these runs showed.

## 7. Milestones

Each one ends with passing tests and one or more small commits. No co-author or session lines in any commit.

| # | Milestone | Done when |
|---|---|---|
| 0 | Scaffold: `.gitignore`, `.claude/settings.json`, LICENSE, `package.json`, this plan | First commit exists, `.claude/` is ignored |
| 1 | Dates, seeded random numbers, `validate` | Tests 12, 13, 23 pass |
| 2 | Counting checks and greedy fill with clear failures | Tests 1 to 11 pass |
| 3 | Fairness score and balancing pass | Tests 14 to 19 pass |
| 4 | CSV export | Tests 20 to 22 pass |
| 5 | Page shell, design tokens, setup panel, sample team | Sample loads and inputs are labelled |
| 6 | Roster grid: sticky headers, picker, leave, keyboard, warnings | A manual edit that breaks a rule shows on the cell and in the list |
| 7 | Fairness panel, empty and error states, "How it works" | An impossible setup shows the failing rule |
| 8 | CSV download, print stylesheet, optional save | 6 weeks fits A4 landscape in print preview; app works with storage blocked |
| 9 | CI and Pages workflows | Workflow files are in place; green CI is confirmed after the first push |
| 10 | Browser check, real screenshot, README | Every README command has been run; screenshot is from the running app |
| 11 | Final pass | Clean tree, no secrets, README matches the code |

## 8. Risks

| Risk | Plan |
|---|---|
| Greedy fill gets stuck on a setup that is possible | Retries with new tie-break orders, then an honest "not found" message. I will measure how often this happens on real runs and report it. |
| A double-click on `index.html` fails in Chrome and Edge | See decision 1. Tested and documented either way. |
| 42 columns do not fit on A4 | Print cell size worked out from the page width; checked in print preview at 6 weeks. |
| Sticky headers behave badly on a phone | Checked at 375px wide in a real browser before the README is written. |
| The score looks precise but is a simple measure | The formula and its limits are stated in the UI and the README. |
