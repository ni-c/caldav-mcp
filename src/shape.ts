import {
  detectScriptMix,
  detectSuspicious,
  sanitizeText,
  MAX_TEXT_CHARS,
} from './analyze.js';
import type { CalendarEntry } from './calendars.js';
import { buildOccurrenceId, buildSeriesId } from './entity-id.js';
import { ICAL, readInt, readList, readText, type Kind } from './ical.js';
import type { Occurrence } from './recurrence.js';
import { renderTime, type RenderedTime } from './time.js';

/**
 * Turning a parsed component into the object a tool answers with.
 *
 * Every string that leaves this module has been through `sanitizeText`, and
 * that includes the short ones. A summary is quoted back by the model far more
 * often than a description is, and a calendar's *display name* reaches the model
 * through `list_calendars` before anybody opens an entry at all — the imap
 * lesson was a folder name that went through neither sanitiser for months.
 */

/** How long a description may be inside a listing before it is shortened. */
const LIST_TEXT_CHARS = MAX_TEXT_CHARS;

/** How long a description may be in a single-entry answer. */
const DETAIL_TEXT_CHARS = 20_000;

export interface ShapeOptions {
  kind: Kind;
  calendar: CalendarEntry;
  /** File name of the resource this occurrence came out of, e.g. `a1b2c3.ics`. */
  resourceName: string;
  /** Zone for a value written with neither `Z` nor a `TZID`. */
  fallbackZone: string;
  /** True for `get_*`, which returns the full text of one entry. */
  detailed: boolean;
  /** The address `respond_to_event` would act as, for marking `is_self`. */
  selfAddresses?: readonly string[];
}

export interface Shaped {
  /** The object for `structuredContent` and the JSON text block. */
  entry: Record<string, unknown>;
  /** The entry's own words, for the nonce fence in a single-entry answer. */
  fenced: string;
  /** Injection shapes found anywhere in the entry's text. */
  warnings: string[];
}

/** Projects one occurrence into the shape its tool declares. */
export function shapeEntry(
  occurrence: Occurrence,
  options: ShapeOptions
): Shaped {
  const component = occurrence.component;
  const limit = options.detailed ? DETAIL_TEXT_CHARS : LIST_TEXT_CHARS;
  const truncatedFields: string[] = [];

  const text = (name: string): string | undefined => {
    const raw = readText(component, name);
    if (raw === undefined) return undefined;
    const clean = sanitizeText(raw, limit);
    if (clean.length < raw.length) truncatedFields.push(name.toLowerCase());
    return clean;
  };

  const summary = text('summary');
  const description = text('description');
  const location = text('location');
  const comment = text('comment');
  const categories = readList(component, 'categories').map((value) =>
    sanitizeText(value, 200)
  );

  const seriesId = buildSeriesId(
    options.kind,
    options.calendar.path,
    options.resourceName
  );
  const id =
    occurrence.recurrenceId === undefined
      ? seriesId
      : buildOccurrenceId(
          options.kind,
          options.calendar.path,
          options.resourceName,
          occurrence.recurrenceId
        );

  const attendees = readAttendees(component, options.selfAddresses ?? []);
  const organizer = readOrganizer(component, options.selfAddresses ?? []);
  const alarms = readAlarms(component);
  const attachments = readAttachments(component);

  const rrule = component.getFirstProperty('rrule');
  const entry: Record<string, unknown> = {
    id,
    series_id: seriesId,
    calendar: options.calendar.path,
    ...maybe('uid', readText(component, 'uid')),
    ...maybe('summary', summary),
    ...maybe('description', description),
    ...maybe('location', location),
    ...maybe('comment', comment),
    ...(categories.length > 0 ? { categories } : {}),
    ...maybe('status', readText(component, 'status')),
    ...maybe('url', readText(component, 'url')),
    ...maybe('created', isoOf(component, 'created')),
    ...maybe('last_modified', isoOf(component, 'last-modified')),
    ...maybe('sequence', readInt(component, 'sequence')),
    recurring: occurrence.recurrenceId !== undefined || rrule !== null,
    ...(occurrence.recurrenceId === undefined
      ? {}
      : {
          recurrence_id: renderTime(occurrence.start.instant, {
            zone: occurrence.start.zone,
            allDay: occurrence.start.allDay,
            fallbackZone: options.fallbackZone,
          }),
          is_override: occurrence.isOverride,
        }),
    ...maybe(
      'recurrence_rule',
      rrule === null ? undefined : String(rrule.getFirstValue())
    ),
    ...(alarms.length > 0 ? { alarms } : {}),
    ...(attachments.length > 0 ? { attachments } : {}),
    ...(organizer === undefined ? {} : { organizer }),
    ...(attendees.length > 0 ? { attendees } : {}),
  };

  // Kind-specific times.
  if (options.kind === 'vevent') {
    setTime(entry, 'start', occurrence.start, options.fallbackZone);
    setTime(entry, 'end', occurrence.end, options.fallbackZone);
    const transparency = readText(component, 'transp');
    if (transparency !== undefined) {
      entry.transparent = transparency.toUpperCase() === 'TRANSPARENT';
    }
  } else if (options.kind === 'vtodo') {
    setTime(entry, 'start', occurrence.start, options.fallbackZone);
    setTime(entry, 'due', occurrence.end, options.fallbackZone);
    const completed = component.getFirstProperty('completed');
    if (completed !== null) {
      entry.completed = {
        value: String(completed.getFirstValue()),
        all_day: false,
      };
    }
    const percent = readInt(component, 'percent-complete');
    if (percent !== undefined) entry.percent_complete = percent;
    const priority = readInt(component, 'priority');
    if (priority !== undefined) entry.priority = priority;
  } else {
    setTime(entry, 'start', occurrence.start, options.fallbackZone);
  }

  if (truncatedFields.length > 0) entry.truncated_fields = truncatedFields;

  // The signals run over every field somebody else could have written, joined,
  // so a phrase split across a summary and a location is still found.
  const searchable = [summary, description, location, comment]
    .filter((value): value is string => value !== undefined)
    .join('\n');
  const warnings = detectSuspicious(searchable);
  const lookalikes = detectScriptMix(
    [searchable, organizer?.name, ...attendees.map((a) => a.name)]
      .filter((value): value is string => typeof value === 'string')
      .join(' ')
  );
  if (warnings.length > 0) entry.warnings = warnings;
  if (lookalikes.length > 0) entry.lookalike_words = lookalikes;

  const fenced = [
    summary === undefined ? undefined : `SUMMARY: ${summary}`,
    location === undefined ? undefined : `LOCATION: ${location}`,
    description === undefined ? undefined : `DESCRIPTION:\n${description}`,
    comment === undefined ? undefined : `COMMENT:\n${comment}`,
  ]
    .filter((line): line is string => line !== undefined)
    .join('\n\n');

  return { entry, fenced, warnings };
}

function maybe(key: string, value: unknown): Record<string, unknown> {
  return value === undefined ? {} : { [key]: value };
}

function setTime(
  entry: Record<string, unknown>,
  key: string,
  time: Occurrence['start'] | undefined,
  fallbackZone: string
): void {
  if (time === undefined) return;
  const rendered: RenderedTime = renderTime(time.instant, {
    zone: time.zone,
    allDay: time.allDay,
    fallbackZone,
  });
  entry[key] = {
    value: rendered.value,
    ...(rendered.tzid === undefined ? {} : { tzid: rendered.tzid }),
    all_day: rendered.allDay,
  };
}

function isoOf(component: ICAL.Component, name: string): string | undefined {
  const property = component.getFirstProperty(name);
  if (property === null) return undefined;
  const value = property.getFirstValue() as ICAL.Time;
  // CREATED and LAST-MODIFIED are defined as UTC, so the library's own
  // conversion is trustworthy here — the one place in this server it is.
  return value.toJSDate().toISOString();
}

interface Participant {
  email?: string;
  name?: string;
  role?: string;
  status?: string;
  rsvp?: boolean;
  is_self?: boolean;
}

function readParticipant(
  property: ICAL.Property,
  selfAddresses: readonly string[]
): Participant {
  const raw = String(property.getFirstValue() ?? '');
  const email = /^mailto:/i.test(raw)
    ? raw.replace(/^mailto:/i, '').toLowerCase()
    : undefined;
  const name = property.getParameter('cn');
  const role = property.getParameter('role');
  const status = property.getParameter('partstat');
  const rsvp = property.getParameter('rsvp');
  return {
    ...(email === undefined ? {} : { email }),
    ...(typeof name === 'string' ? { name: sanitizeText(name, 200) } : {}),
    ...(typeof role === 'string' ? { role } : {}),
    ...(typeof status === 'string' ? { status } : {}),
    ...(typeof rsvp === 'string'
      ? { rsvp: rsvp.toUpperCase() === 'TRUE' }
      : {}),
    ...(email !== undefined && selfAddresses.includes(email)
      ? { is_self: true }
      : {}),
  };
}

function readAttendees(
  component: ICAL.Component,
  selfAddresses: readonly string[]
): Participant[] {
  return component
    .getAllProperties('attendee')
    .map((property) => readParticipant(property, selfAddresses));
}

function readOrganizer(
  component: ICAL.Component,
  selfAddresses: readonly string[]
): Participant | undefined {
  const property = component.getFirstProperty('organizer');
  return property === null
    ? undefined
    : readParticipant(property, selfAddresses);
}

/**
 * Whether an alarm is one this server could also write.
 *
 * A "simple" alarm is `ACTION:DISPLAY` with nothing but a TRIGGER and a
 * DESCRIPTION. That is the set the `alarms` parameter replaces; everything else
 * — EMAIL alarms, repeats, alarms with their own attachment — is reported and
 * then left strictly alone on every write.
 */
export function isSimpleAlarm(alarm: ICAL.Component): boolean {
  const action = String(
    alarm.getFirstPropertyValue('action') ?? ''
  ).toUpperCase();
  if (action !== 'DISPLAY') return false;
  const names = new Set(
    alarm.getAllProperties().map((property) => property.name.toLowerCase())
  );
  names.delete('action');
  names.delete('trigger');
  names.delete('description');
  return names.size === 0;
}

function readAlarms(component: ICAL.Component): Record<string, unknown>[] {
  return component.getAllSubcomponents('valarm').map((alarm) => {
    const trigger = alarm.getFirstProperty('trigger');
    const description = readText(alarm, 'description');
    return {
      ...maybe('action', readText(alarm, 'action')),
      ...maybe(
        'trigger',
        trigger === null ? undefined : String(trigger.getFirstValue())
      ),
      ...maybe(
        'description',
        description === undefined ? undefined : sanitizeText(description, 500)
      ),
      simple: isSimpleAlarm(alarm),
    };
  });
}

/**
 * Attachment metadata, and never the bytes.
 *
 * The size of an inline attachment is computed from the base64 length
 * arithmetically rather than by decoding it: the point of reporting metadata
 * only is that the content never becomes resident, and decoding a 20 MB
 * attachment to measure it would defeat that in the most literal way.
 */
function readAttachments(component: ICAL.Component): Record<string, unknown>[] {
  return component.getAllProperties('attach').map((property) => {
    const encoding = property.getParameter('encoding');
    const inline =
      typeof encoding === 'string' && encoding.toUpperCase() === 'BASE64';
    const fmtType = property.getParameter('fmttype');
    const filename =
      property.getParameter('filename') ??
      property.getParameter('x-apple-filename');
    const sizeParam = property.getParameter('size');
    const raw = String(property.getFirstValue() ?? '');

    let size: number | undefined;
    if (typeof sizeParam === 'string' && /^\d+$/.test(sizeParam)) {
      size = Number(sizeParam);
    } else if (inline) {
      const padding = raw.endsWith('==') ? 2 : raw.endsWith('=') ? 1 : 0;
      size = Math.max(0, Math.floor((raw.length * 3) / 4) - padding);
    }

    return {
      ...(typeof filename === 'string'
        ? { filename: sanitizeText(filename, 200) }
        : {}),
      ...(typeof fmtType === 'string' ? { mime_type: fmtType } : {}),
      ...(size === undefined ? {} : { size }),
      ...(inline || raw.length === 0 ? {} : { url: sanitizeText(raw, 2000) }),
      inline,
    };
  });
}

/** One calendar, as `list_calendars` reports it. */
export function shapeCalendar(
  calendar: CalendarEntry
): Record<string, unknown> {
  return {
    id: calendar.path,
    url: calendar.url,
    ...(calendar.displayName === undefined
      ? {}
      : { name: sanitizeText(calendar.displayName, 200) }),
    ...(calendar.description === undefined
      ? {}
      : { description: sanitizeText(calendar.description, 500) }),
    ...(calendar.color === undefined
      ? {}
      : { color: sanitizeText(calendar.color, 50) }),
    components: [...calendar.components],
    read_only: calendar.readOnly,
  };
}
