import ICAL from 'ical.js';

import { quoted } from './analyze.js';
import { ToolInputError } from './errors.js';
import { cacheZone, isKnownZone, wallClockToInstant } from './time.js';

export { isKnownZone };

/**
 * The one place ical.js is touched.
 *
 * Everything else in this server works with plain objects, so the library's
 * surface is this file and its test. Three decisions live here, each of them
 * verified against ical.js 2.2.1 rather than assumed:
 *
 * 1. **`ICAL.TimezoneService.register` is never called.** Parsing a document
 *    does not register the VTIMEZONEs it carries, so a hostile entry that
 *    redefines `Europe/Berlin` affects only itself. Registering would make that
 *    redefinition global and shift every event parsed afterwards. There is no
 *    snapshot-and-restore dance because there is nothing to restore.
 * 2. **`ICAL.Time#toJSDate()` is used only for a UTC value.** On a floating
 *    value it applies the *host's* local zone, so a container that inherited
 *    `TZ=UTC` and a workstation in Berlin would disagree about when an
 *    appointment is. Every other form is resolved through {@link resolveTime}.
 * 3. **A known IANA zone beats the document's own VTIMEZONE.** A bare
 *    `TZID=Europe/Berlin` with no VTIMEZONE is legal, common, and resolves to
 *    "floating" in ical.js — the wrong instant, silently. So the platform's zone
 *    database answers for any zone id it knows, and the document's VTIMEZONE is
 *    the fallback for a private zone name it does not.
 */

/** The three component kinds this server handles. */
export type Kind = 'vevent' | 'vtodo' | 'vjournal';

/** iCalendar's spelling of the same three, for a request body. */
export const COMPONENT_OF: Record<Kind, 'VEVENT' | 'VTODO' | 'VJOURNAL'> = {
  vevent: 'VEVENT',
  vtodo: 'VTODO',
  vjournal: 'VJOURNAL',
};

/**
 * Parses an iCalendar document, refusing anything that is not one.
 *
 * The parser's own message is quoted only in part. ical.js repeats the
 * offending line verbatim, and that line is the one piece of the document
 * most under the control of whoever wrote it: unbounded, unsanitised, and
 * about to be delivered in this server's own voice outside any fence. A short,
 * escaped excerpt is enough to find the line; the document itself is not
 * something to paste into an error.
 */
export function parseCalendar(ics: string, what: string): ICAL.Component {
  let root: ICAL.Component;
  try {
    root = new ICAL.Component(ICAL.parse(ics));
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new ToolInputError(
      `caldav-mcp: ${what} is not a readable iCalendar document ` +
        `(${quoted(reason.replace(/\s+/g, ' '), 120)}). This is the stored ` +
        'entry, not the arguments of this call.'
    );
  }
  if (root.name !== 'vcalendar') {
    throw new ToolInputError(
      `caldav-mcp: ${what} is not a VCALENDAR document.`
    );
  }
  return root;
}

/** Serialises a document back to the wire form. */
export function serialize(root: ICAL.Component): string {
  return root.toString();
}

/** Every component of a kind in a document, in document order. */
export function componentsOf(
  root: ICAL.Component,
  kind: Kind
): ICAL.Component[] {
  return root.getAllSubcomponents(kind);
}

/**
 * Splits a document's components into the master and its overrides.
 *
 * A document may legally contain overrides and no master — a client that was
 * handed only a "this occurrence" update writes exactly that. Callers have to
 * cope, so this reports it rather than throwing.
 */
export function splitSeries(components: ICAL.Component[]): {
  master: ICAL.Component | undefined;
  overrides: ICAL.Component[];
} {
  const overrides: ICAL.Component[] = [];
  let master: ICAL.Component | undefined;
  for (const component of components) {
    if (component.getFirstProperty('recurrence-id') === null) {
      master ??= component;
    } else {
      overrides.push(component);
    }
  }
  return { master, overrides };
}

/** A timestamp as the document wrote it, before any zone is applied. */
export interface RawTime {
  /** The instant it names, resolved through the rules described above. */
  instant: Date;
  /** The zone the document named, where it named one this platform knows. */
  zone: string | undefined;
  /** True for a `VALUE=DATE` value. */
  allDay: boolean;
  /** True when the document wrote a UTC value. */
  utc: boolean;
}

/**
 * Resolves a date-time property to an instant.
 *
 * `fallbackZone` is used for a floating value — one written with neither a `Z`
 * nor a `TZID`. iCalendar says such a value means "whatever local time is where
 * this is read", which for a server is not a usable answer; the configured zone
 * is the closest thing to the user's intent.
 *
 * The `zone` carried forward is **only ever a zone the platform knows**. It is
 * handed to `Intl` at every later step — rendering, spelling a RECURRENCE-ID,
 * writing the value back — and `Intl` throws for a name it does not know. A
 * `TZID` is written by whoever wrote the entry, so an unknown one used to be a
 * `RangeError` out of the whole listing, planted by one invitation. The private
 * name still decides the *instant* below, through the document's own VTIMEZONE;
 * it just does not travel as a name.
 */
export function resolveTime(
  property: ICAL.Property,
  fallbackZone: string
): RawTime {
  const value = property.getFirstValue() as ICAL.Time;
  const tzid = property.getParameter('tzid');
  const named = typeof tzid === 'string' ? tzid : undefined;
  const known = named !== undefined && isKnownZone(named) ? named : undefined;
  const wall = {
    year: value.year,
    month: value.month,
    day: value.day,
    hour: value.hour,
    minute: value.minute,
    second: value.second,
  };

  if (value.isDate) {
    return {
      instant: wallClockToInstant(known ?? fallbackZone, wall),
      zone: known,
      allDay: true,
      utc: false,
    };
  }

  if (value.zone?.tzid === 'UTC') {
    // The one case where the library's own conversion is trustworthy.
    return {
      instant: value.toJSDate(),
      zone: undefined,
      allDay: false,
      utc: true,
    };
  }

  if (known !== undefined) {
    return {
      instant: wallClockToInstant(known, wall),
      zone: known,
      allDay: false,
      utc: false,
    };
  }

  if (named !== undefined) {
    // A private zone name — "Customized Time Zone", the shape Exchange emits.
    // Only the document's own VTIMEZONE can say what it means, so ical.js is
    // asked, and its answer is used even though the definition is untrusted:
    // an entry misreporting its own time is a thing it could do with DTSTART
    // anyway, and it cannot reach any other entry. The name itself is dropped:
    // it means nothing outside this document.
    const zoned = property.getFirstValue() as ICAL.Time;
    if (zoned.zone !== undefined && zoned.zone.tzid !== 'floating') {
      return {
        instant: zoned.toJSDate(),
        zone: undefined,
        allDay: false,
        utc: false,
      };
    }
  }

  return {
    instant: wallClockToInstant(fallbackZone, wall),
    zone: undefined,
    allDay: false,
    utc: false,
  };
}

/** Reads a date-time property, or undefined when the component has none. */
export function readTime(
  component: ICAL.Component,
  name: string,
  fallbackZone: string
): RawTime | undefined {
  const property = component.getFirstProperty(name);
  if (property === null) return undefined;
  return resolveTime(property, fallbackZone);
}

/** Reads a text property, or undefined when it is absent or empty. */
export function readText(
  component: ICAL.Component,
  name: string
): string | undefined {
  const value = component.getFirstPropertyValue(name);
  if (value === null || value === undefined) return undefined;
  const text = String(value).trim();
  return text.length > 0 ? text : undefined;
}

/** Reads an integer property, or undefined. */
export function readInt(
  component: ICAL.Component,
  name: string
): number | undefined {
  const value = component.getFirstPropertyValue(name);
  if (value === null || value === undefined) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

/** Every value of a property that may appear more than once. */
export function readList(component: ICAL.Component, name: string): string[] {
  return component
    .getAllProperties(name)
    .flatMap((property) => property.getValues())
    .map((value) => String(value).trim())
    .filter((value) => value.length > 0);
}

/**
 * Writes a date-time property, replacing whatever was there.
 *
 * An all-day value is written as `VALUE=DATE`, a zoned value as a local time
 * with a `TZID` parameter, and everything else as UTC. The zoned form
 * deliberately does not emit a VTIMEZONE: this server resolves a known zone id
 * from the platform database and so does every real client, and a VTIMEZONE
 * synthesised from an offset would be wrong the moment the rule changes.
 */
export function writeTime(
  component: ICAL.Component,
  name: string,
  time: { instant: Date; zone?: string | undefined; allDay: boolean }
): void {
  component.removeAllProperties(name);
  const property = new ICAL.Property(name, component);
  if (time.allDay) {
    const zone = time.zone ?? 'UTC';
    const value = ICAL.Time.fromData({
      year: Number(formatPart(time.instant, zone, 'year')),
      month: Number(formatPart(time.instant, zone, 'month')),
      day: Number(formatPart(time.instant, zone, 'day')),
      isDate: true,
    });
    property.setValue(value);
    component.addProperty(property);
    return;
  }
  if (time.zone === undefined) {
    const value = ICAL.Time.fromJSDate(time.instant, true);
    property.setValue(value);
    component.addProperty(property);
    return;
  }
  const zone = time.zone;
  const value = ICAL.Time.fromData({
    year: Number(formatPart(time.instant, zone, 'year')),
    month: Number(formatPart(time.instant, zone, 'month')),
    day: Number(formatPart(time.instant, zone, 'day')),
    hour: Number(formatPart(time.instant, zone, 'hour')) % 24,
    minute: Number(formatPart(time.instant, zone, 'minute')),
    second: Number(formatPart(time.instant, zone, 'second')),
    isDate: false,
  });
  property.setValue(value);
  property.setParameter('tzid', zone);
  component.addProperty(property);
}

const partFormatters = new Map<string, Intl.DateTimeFormat>();

function formatPart(
  instant: Date,
  zone: string,
  part: 'year' | 'month' | 'day' | 'hour' | 'minute' | 'second'
): string {
  let formatter = partFormatters.get(zone);
  if (formatter === undefined) {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone: zone,
      hour12: false,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    cacheZone(partFormatters, zone, formatter);
  }
  return (
    formatter.formatToParts(instant).find((p) => p.type === part)?.value ?? '0'
  );
}

/**
 * Folds every line break in a caller's text to LF, which ical.js escapes.
 *
 * ical.js escapes `\`, `;`, `,` and LF in a TEXT value and nothing else, so a
 * bare CR would go into the resource as a raw CR — and a reader that splits
 * content lines on it sees a property nobody wrote. The schema refuses every
 * other control character outright; CR is folded rather than refused because
 * a description pasted from a Windows client legitimately carries CRLF.
 */
export function foldNewlines(value: string): string {
  return value.replace(/\r\n?/g, '\n');
}

/** Sets a text property, or removes it when the value is null. */
export function writeText(
  component: ICAL.Component,
  name: string,
  value: string | null | undefined
): void {
  if (value === undefined) return;
  component.removeAllProperties(name);
  if (value === null) return;
  component.updatePropertyWithValue(name, foldNewlines(value));
}

/** Builds an empty VCALENDAR carrying one component of the given kind. */
export function newCalendar(
  kind: Kind,
  uid: string
): {
  root: ICAL.Component;
  component: ICAL.Component;
} {
  const root = new ICAL.Component('vcalendar');
  root.updatePropertyWithValue('version', '2.0');
  root.updatePropertyWithValue('prodid', '-//ni-c//caldav-mcp//EN');
  const component = new ICAL.Component(kind);
  component.updatePropertyWithValue('uid', uid);
  component.updatePropertyWithValue(
    'dtstamp',
    ICAL.Time.fromJSDate(new Date(), true)
  );
  root.addSubcomponent(component);
  return { root, component };
}

/**
 * Stamps a component as changed.
 *
 * `SEQUENCE` is a counter of *revisions the organiser published*, not of writes,
 * and iTIP uses it to decide whether an update supersedes what an attendee
 * already has. Incrementing it is what makes a change visible to the other side;
 * `DTSTAMP` and `LAST-MODIFIED` are the timestamps clients sort and sync on.
 *
 * Which is exactly why answering an invitation must not touch it. RFC 5546
 * §3.2.3 has an attendee **echo** the organiser's `SEQUENCE` in a REPLY, and
 * for a good reason: a reply carrying a higher number claims to be a newer
 * revision of the event than the one the organiser sent. Clients that compare
 * sequences then treat the attendee's copy as the current one, and the
 * organiser's next genuine update arrives looking stale and is ignored — an
 * accepted invitation that silently stops receiving changes. `DTSTAMP` still
 * moves, because a reply does need to be orderable against other replies.
 */
export function touch(
  component: ICAL.Component,
  options: { bumpSequence?: boolean } = {}
): void {
  if (options.bumpSequence !== false) {
    const sequence = readInt(component, 'sequence') ?? 0;
    component.updatePropertyWithValue('sequence', sequence + 1);
  }
  const now = ICAL.Time.fromJSDate(new Date(), true);
  component.updatePropertyWithValue('dtstamp', now);
  component.updatePropertyWithValue('last-modified', now);
}

export { ICAL };
