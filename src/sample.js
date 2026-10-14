// The sample team. Every name is made up and ends in "Sample" so nobody mistakes it for real staff.
// Never put real employee data in this file.
import { parseISODate, toISODate } from './roster.js';

export const SAMPLE_NAMES = [
  'Asha Sample', 'Bharat Sample', 'Chitra Sample', 'Dev Sample',
  'Esha Sample', 'Farhan Sample', 'Gita Sample', 'Harish Sample',
  'Isha Sample', 'Jai Sample', 'Kavya Sample', 'Leo Sample',
];

// Leave as day offsets from the start date, so the sample works for any start.
const SAMPLE_LEAVE = {
  'Chitra Sample': [9, 10],
  'Harish Sample': [15, 16, 17],
  'Kavya Sample': [23],
};

export function sampleSetup(startDate) {
  const start = parseISODate(startDate);
  return {
    people: SAMPLE_NAMES.map((name) => ({
      name,
      leave: (SAMPLE_LEAVE[name] ?? []).map((offset) => toISODate(start + offset * 86400000)),
    })),
    startDate,
    weeks: 4,
    rules: {
      minPerShift: { M: 3, A: 3, N: 3 },
      maxConsecutiveDays: 6,
      maxConsecutiveNights: 3,
      restAfterNight: true,
      weeklyOff: true,
    },
  };
}
