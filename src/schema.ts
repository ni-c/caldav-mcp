import { z } from 'zod';

import { MAX_MAX_ENTRIES } from './config.js';
import { isKnownZone } from './time.js';

/**
 * The input fragments more than one tool takes.
 *
 * Kept apart from `output-schema.ts` because the two answer different
 * questions: this one is what a caller may send, that one is what this server
 * promises to return. They also fail differently — a bad input is a message to
 * the caller, a bad output is a failed tool call.
 */

/**
 * C0 and C1 control characters, except TAB, LF and CR.
 *
 * Refused at the schema boundary for every free-text field a write tool takes,
 * and the reason is structural rather than cosmetic. ical.js escapes `\`, `;`,
 * `,` and LF when it serialises a TEXT value — and nothing else. A bare CR
 * inside a summary therefore goes into the PUT body as a raw CR, and a lenient
 * reader that splits lines on it sees a property line nobody wrote. The read
 * path already refuses these characters (`dav-xml.ts`); the write path, where
 * a line break actually is structure, has to as well. CR and LF themselves are
 * accepted here and folded to LF before serialisation, because a description
 * may legitimately span lines and ical.js escapes LF correctly.
 */
// eslint-disable-next-line no-control-regex -- matching them is the point
const CONTROL_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/;

const NO_CONTROL = {
  message:
    'contains control characters, which cannot appear in a calendar entry. ' +
    'Remove them and try again.',
};

function noControl(value: string): boolean {
  return !CONTROL_CHARS.test(value);
}

/** The title of an entry. Required where an entry is created. */
export const summaryParam = z
  .string()
  .trim()
  .min(1)
  .max(1000)
  .refine(noControl, NO_CONTROL)
  .describe('The title.');

/** An id from a listing. Never composed by hand; `entity-id.ts` validates it. */
export const entityIdParam = z
  .string()
  .trim()
  .min(1)
  .max(1024)
  .describe('An id from a listing tool. Not meant to be built by hand.');

/** A calendar, by the `id` (its path) that `list_calendars` prints. */
export const calendarRefParam = z
  .string()
  .trim()
  .min(1)
  .max(1024)
  .describe(
    'A calendar id from list_calendars — its path. A full URL or the final ' +
      'path segment work too.'
  );

/** Several calendars; absent means every calendar this server may see. */
export const calendarsParam = z
  .array(calendarRefParam)
  .max(64)
  .optional()
  .describe(
    'Which calendars to look in. Leave it out for all of them. A calendar ' +
      'outside CALDAV_CALENDARS is refused rather than silently skipped.'
  );

/**
 * A point in time.
 *
 * Three accepted forms, and the middle one is why this is not just a date
 * string: `2026-09-07T09:00:00` is resolved in the `timezone` argument or in
 * CALDAV_TIMEZONE, never in whatever zone the server process happens to run in.
 */
export const instantParam = z
  .string()
  .trim()
  .min(4)
  .max(64)
  .describe(
    'ISO 8601: "2026-09-07" for a whole day, "2026-09-07T09:00:00" in the ' +
      'timezone argument or CALDAV_TIMEZONE, or "2026-09-07T09:00:00+02:00".'
  );

/** The zone a bare date-time is read in. */
export const timezoneParam = z
  .string()
  .trim()
  .min(1)
  .max(64)
  // Checked here rather than left to `Intl` deep inside the write path, where
  // the failure surfaces as a raw RangeError quoting the input. A zone this
  // platform does not know is not something to write into a TZID parameter.
  .refine((zone) => isKnownZone(zone), {
    message: 'is not an IANA time zone name this server knows.',
  })
  .optional()
  .describe(
    'IANA zone for timestamps that carry no offset, e.g. "Europe/Berlin". ' +
      'Defaults to CALDAV_TIMEZONE. Refused together with a value that ' +
      'already carries an offset.'
  );

/** How many entries a listing returns. */
export const limitParam = z
  .number()
  .int()
  .min(1)
  .max(MAX_MAX_ENTRIES)
  .optional()
  .describe(
    `Entries to return, at most ${MAX_MAX_ENTRIES}. Defaults to CALDAV_MAX_EVENTS.`
  );

/** Continues a truncated listing. */
export const afterParam = z
  .string()
  .trim()
  .max(2048)
  .optional()
  .describe(
    'The `truncated.next_cursor` of a previous call, to continue where it ' +
      'stopped. The window has to be the same one.'
  );

/** The two-call fallback for a client that cannot show a dialog. */
export const confirmTokenParam = z
  .string()
  .trim()
  .max(256)
  .optional()
  .describe('Token from the first call of this tool.');

/**
 * Which part of a recurring entry a write applies to.
 *
 * `this_and_future` is deliberately absent. Doing it correctly means splitting
 * the series — UNTIL on the old master, a fresh UID for the remainder, a
 * RELATED-TO between them — and a half-correct implementation corrupts a
 * calendar silently. Changing one occurrence, or the whole series, are both
 * exact.
 */
export const scopeParam = z
  .enum(['this_occurrence', 'entire_series'])
  .optional()
  .describe(
    'For a recurring entry: change just this occurrence, or the whole series. ' +
      'Defaults to whichever the id names. Changing a whole series asks first.'
  );

/** A plain reminder. */
export const alarmParam = z.object({
  trigger: z
    .string()
    .trim()
    .min(2)
    .max(64)
    .describe(
      'Relative to the start ("-PT15M", "-P1D") or an absolute ISO 8601 time.'
    ),
  description: z
    .string()
    .trim()
    .max(500)
    .refine(noControl, NO_CONTROL)
    .optional(),
});

export const alarmsParam = z
  .array(alarmParam)
  .max(20)
  .optional()
  .describe(
    'Replaces the plain DISPLAY reminders. An empty array removes them. ' +
      'Reminders this server cannot write — email alarms, repeating ones, ' +
      'ones with an attachment — are always kept, and the answer says how many.'
  );

/** Free text that can also be cleared by passing null. */
export const textParam = (what: string, max = 8192) =>
  z
    .string()
    .max(max)
    .refine(noControl, NO_CONTROL)
    .nullish()
    .describe(`${what} Pass null to remove it, leave it out to keep it.`);

/** Categories, replaced as a whole. */
export const categoriesParam = z
  .array(z.string().trim().min(1).max(200).refine(noControl, NO_CONTROL))
  .max(50)
  .nullish()
  .describe('Replaces every category. Pass null or an empty array to clear.');
