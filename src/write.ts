import { randomUUID } from 'node:crypto';

import { CalDavApiError } from './api.js';
import type { CalendarEntry } from './calendars.js';
import type { ToolContext } from './entries.js';
import type { EntityId } from './entity-id.js';
import { PreconditionFailedError, ToolInputError } from './errors.js';
import {
  COMPONENT_OF,
  ICAL,
  componentsOf,
  newCalendar,
  parseCalendar,
  readText,
  serialize,
  splitSeries,
  touch,
  writeText,
  writeTime,
  type Kind,
} from './ical.js';
import { parseRecurrenceId, spellRecurrenceId } from './recurrence.js';
import { isSimpleAlarm } from './shape.js';
import { parseInstant } from './time.js';

/**
 * The write path: read the whole resource, edit the parsed tree, write it back.
 *
 * A CalDAV `PUT` replaces the entire resource, so the only safe shape is a
 * read-modify-write over what is actually stored — never a document rebuilt
 * from the fields a tool happens to model. That single decision is what
 * preserves the unknown `X-` properties, the VALARMs, the ATTACH values, the
 * ATTENDEE lines and every parameter this server has no opinion about: they are
 * not preserved by special-case code, they are simply never touched.
 *
 * Verified against ical.js 2.2.1 rather than assumed. Editing one property and
 * re-serialising kept all of the above, folded at 75 octets with CRLF, and
 * differed from the input only where the library *normalised* it: it added the
 * RFC-required escape before a comma in a TEXT value, and it reordered
 * parameters, whose order is insignificant.
 */

/** How the caller wants a recurring entry changed. */
export type Scope = 'this_occurrence' | 'entire_series';

/** A simple DISPLAY reminder, which is the only alarm this server writes. */
export interface AlarmInput {
  /** `-PT15M`, `-P1D`, or an absolute ISO 8601 timestamp. */
  trigger: string;
  description?: string | undefined;
}

/** The resource, its validator, and the component the caller addressed. */
export interface LoadedEntry {
  root: ICAL.Component;
  /** The component to edit: the master, or the override for this occurrence. */
  target: ICAL.Component;
  master: ICAL.Component | undefined;
  url: string;
  etag: string;
  calendar: CalendarEntry;
  /** True when `target` was created here and is not yet in the document. */
  createdOverride: boolean;
}

/**
 * Fetches a resource for editing, resolving the occurrence the id addresses.
 *
 * The read uses the write-path ceiling, and that is the point: a resource this
 * server cannot read in full is one it must not write at all. A PUT assembled
 * from a truncated read would silently destroy whatever fell off the end —
 * most likely an inline attachment, which is the largest thing an entry
 * carries.
 */
export async function loadForWrite(
  context: ToolContext,
  id: EntityId,
  scope: Scope
): Promise<LoadedEntry> {
  const registry = await context.discovery.registry();
  const calendar = registry.byPath(id.calendarPath);
  if (calendar === undefined) {
    throw new ToolInputError(
      'caldav-mcp: that calendar is no longer available. Call list_calendars.'
    );
  }
  const url = `${calendar.url}${id.resourceName}`;

  let resource;
  try {
    resource = await context.api.get(url, true);
  } catch (error) {
    if (error instanceof Error && /larger than/.test(error.message)) {
      throw new ToolInputError(
        'caldav-mcp: this entry carries more inline attachment data than this ' +
          'server will read, and editing it here would lose the attachment. ' +
          'Change it in a calendar client instead.'
      );
    }
    throw error;
  }

  if (resource.etag === undefined) {
    throw new ToolInputError(
      'caldav-mcp: the server (or a proxy in front of it) did not return a ' +
        'strong ETag for this entry, so a change cannot be protected against ' +
        'someone else writing at the same time. Nothing was written.'
    );
  }

  const root = parseCalendar(resource.ics, `the entry ${id.resourceName}`);
  const components = componentsOf(root, id.kind);
  const { master, overrides } = splitSeries(components);

  if (id.recurrenceId === undefined || scope === 'entire_series') {
    const target = master ?? components[0];
    if (target === undefined) {
      throw new ToolInputError(
        'caldav-mcp: that entry no longer holds anything this tool can change.'
      );
    }
    if (scope === 'entire_series' && hasThisAndFuture(overrides)) {
      throw new ToolInputError(
        'caldav-mcp: this series uses RECURRENCE-ID;RANGE=THISANDFUTURE, which ' +
          'this server does not model. Changing the whole series could move ' +
          'occurrences it does not understand, so it refuses. Change the ' +
          'single occurrence instead, or edit the series in a calendar client.'
      );
    }
    return {
      root,
      target,
      master,
      url,
      etag: resource.etag,
      calendar,
      createdOverride: false,
    };
  }

  // A single occurrence: an existing override, or a new one cloned from the
  // master. Creating it here is what makes "change just this one" work on a
  // series that has never been edited before.
  const wanted = parseRecurrenceId(id.recurrenceId, context.config.timezone);
  const existing = overrides.find((override) => {
    const property = override.getFirstProperty('recurrence-id');
    if (property === null) return false;
    const spelling = spellRecurrenceId(
      {
        instant: valueInstant(property, context.config.timezone),
        zone: zoneOf(property),
        allDay: (property.getFirstValue() as ICAL.Time).isDate,
        utc: false,
      },
      context.config.timezone
    );
    return spelling === id.recurrenceId;
  });

  if (existing !== undefined) {
    return {
      root,
      target: existing,
      master,
      url,
      etag: resource.etag,
      calendar,
      createdOverride: false,
    };
  }

  if (master === undefined) {
    throw new ToolInputError(
      'caldav-mcp: that occurrence is not in this entry any more.'
    );
  }

  const override = cloneAsOverride(
    master,
    id.kind,
    wanted,
    context.config.timezone
  );
  return {
    root,
    target: override,
    master,
    url,
    etag: resource.etag,
    calendar,
    createdOverride: true,
  };
}

function hasThisAndFuture(overrides: readonly ICAL.Component[]): boolean {
  return overrides.some((override) => {
    const property = override.getFirstProperty('recurrence-id');
    return property !== null && property.getParameter('range') !== undefined;
  });
}

function zoneOf(property: ICAL.Property): string | undefined {
  const tzid = property.getParameter('tzid');
  return typeof tzid === 'string' ? tzid : undefined;
}

function valueInstant(property: ICAL.Property, fallbackZone: string): Date {
  const value = property.getFirstValue() as ICAL.Time;
  const zone = zoneOf(property);
  const spelled = parseRecurrenceId(
    value.isDate
      ? `VALUE=DATE:${pad4(value.year)}${pad2(value.month)}${pad2(value.day)}`
      : zone === undefined
        ? `${pad4(value.year)}${pad2(value.month)}${pad2(value.day)}T${pad2(value.hour)}${pad2(value.minute)}${pad2(value.second)}Z`
        : `TZID=${zone}:${pad4(value.year)}${pad2(value.month)}${pad2(value.day)}T${pad2(value.hour)}${pad2(value.minute)}${pad2(value.second)}`,
    fallbackZone
  );
  return spelled.instant;
}

const pad2 = (value: number): string => String(value).padStart(2, '0');
const pad4 = (value: number): string => String(value).padStart(4, '0');

/**
 * Builds an override for an occurrence that has never been edited.
 *
 * Only the identity and the times are copied. Everything else is left to the
 * master, which is what iCalendar means: an override carries the fields that
 * differ, and a reader falls back to the master for the rest.
 */
function cloneAsOverride(
  master: ICAL.Component,
  kind: Kind,
  at: { instant: Date; zone: string | undefined; allDay: boolean },
  fallbackZone: string
): ICAL.Component {
  const override = new ICAL.Component(kind);
  const uid = readText(master, 'uid');
  if (uid !== undefined) override.updatePropertyWithValue('uid', uid);
  override.updatePropertyWithValue(
    'dtstamp',
    ICAL.Time.fromJSDate(new Date(), true)
  );
  writeTime(override, 'recurrence-id', {
    instant: at.instant,
    zone: at.zone ?? (at.allDay ? undefined : fallbackZone),
    allDay: at.allDay,
  });
  writeTime(override, 'dtstart', {
    instant: at.instant,
    zone: at.zone ?? (at.allDay ? undefined : fallbackZone),
    allDay: at.allDay,
  });
  return override;
}

/**
 * Replaces the simple DISPLAY alarms, keeping every other kind.
 *
 * The partition is the whole design: an EMAIL alarm, one with a REPEAT, or one
 * carrying its own attachment is something this server cannot faithfully
 * rewrite, so it is preserved untouched and reported as `simple: false`.
 * `alarms: []` therefore means "remove the plain reminders" and not "remove
 * everything" — and the answer says how many were kept, so a caller who expected
 * a clean slate finds out rather than assuming.
 */
export function applyAlarms(
  component: ICAL.Component,
  alarms: readonly AlarmInput[] | undefined,
  fallbackZone: string
): number {
  if (alarms === undefined) return 0;
  const existing = component.getAllSubcomponents('valarm');
  let preserved = 0;
  for (const alarm of existing) {
    if (isSimpleAlarm(alarm)) {
      component.removeSubcomponent(alarm);
    } else {
      preserved += 1;
    }
  }
  for (const alarm of alarms) {
    const valarm = new ICAL.Component('valarm');
    valarm.updatePropertyWithValue('action', 'DISPLAY');
    valarm.updatePropertyWithValue(
      'description',
      alarm.description ?? 'Reminder'
    );
    const trigger = new ICAL.Property('trigger', valarm);
    if (/^[+-]?P/i.test(alarm.trigger.trim())) {
      trigger.setValue(ICAL.Duration.fromString(alarm.trigger.trim()));
    } else {
      const parsed = parseInstant(
        alarm.trigger,
        'alarms[].trigger',
        fallbackZone
      );
      trigger.setValue(ICAL.Time.fromJSDate(parsed.instant, true));
      trigger.setParameter('value', 'DATE-TIME');
    }
    valarm.addProperty(trigger);
    component.addSubcomponent(valarm);
  }
  return preserved;
}

/** Sets or clears the plain text fields every kind shares. */
export function applyCommonFields(
  component: ICAL.Component,
  fields: {
    summary?: string | null | undefined;
    description?: string | null | undefined;
    location?: string | null | undefined;
    status?: string | null | undefined;
    url?: string | null | undefined;
    categories?: readonly string[] | null | undefined;
  }
): void {
  writeText(component, 'summary', fields.summary);
  writeText(component, 'description', fields.description);
  writeText(component, 'location', fields.location);
  writeText(component, 'status', fields.status?.toUpperCase());
  writeText(component, 'url', fields.url);
  if (fields.categories !== undefined) {
    component.removeAllProperties('categories');
    if (fields.categories !== null && fields.categories.length > 0) {
      const property = new ICAL.Property('categories', component);
      property.setValues([...fields.categories]);
      component.addProperty(property);
    }
  }
}

/**
 * Writes an edited document back, guarded by the ETag read in the same call.
 *
 * On 412 the resource is re-read **once** and the current state is reported.
 * There is deliberately no retry: a blind second attempt is precisely the lost
 * update the ETag just prevented. What the caller gets instead is a sentence
 * they can act on — what the entry is now, that nothing was written, and that
 * the same call will work on top of the current version.
 */
export async function commit(
  context: ToolContext,
  loaded: LoadedEntry,
  describe: (component: ICAL.Component) => Record<string, unknown>
): Promise<{ etag: string | undefined }> {
  if (loaded.createdOverride) {
    loaded.root.addSubcomponent(loaded.target);
  }
  touch(loaded.target);
  const ics = serialize(loaded.root);

  try {
    return await context.api.put(loaded.url, ics, { ifMatch: loaded.etag });
  } catch (error) {
    if (!(error instanceof CalDavApiError) || error.status !== 412) throw error;
    let current: Record<string, unknown> | undefined;
    try {
      const fresh = await context.api.get(loaded.url);
      const root = parseCalendar(fresh.ics, 'the entry');
      const components = componentsOf(root, loaded.target.name as Kind);
      const { master } = splitSeries(components);
      if (master !== undefined) current = describe(master);
    } catch {
      // The re-read is a courtesy. If it fails too, the message below is still
      // the right one.
    }
    throw new PreconditionFailedError(
      'caldav-mcp: this entry changed on the server between reading it and ' +
        'writing it, so **nothing was written**. ' +
        (current === undefined
          ? ''
          : `It is now: ${JSON.stringify(current)}. `) +
        'If your change still applies, make the same call again — it will be ' +
        'applied on top of the current version.',
      current
    );
  }
}

/**
 * Creates a new resource in a calendar.
 *
 * The UID and the file name are generated here, never taken from the caller.
 * That removes path traversal and accidental overwriting in one move, and
 * `If-None-Match: *` closes the remaining race.
 */
export async function createEntry(
  context: ToolContext,
  calendar: CalendarEntry,
  kind: Kind,
  build: (component: ICAL.Component) => void
): Promise<{
  uid: string;
  resourceName: string;
  url: string;
  etag: string | undefined;
}> {
  if (calendar.readOnly) {
    throw new ToolInputError(
      `caldav-mcp: the account can read ${calendar.path} but not write to it.`
    );
  }
  if (
    calendar.components.length > 0 &&
    !calendar.components.includes(COMPONENT_OF[kind])
  ) {
    throw new ToolInputError(
      `caldav-mcp: ${calendar.path} does not accept ${COMPONENT_OF[kind]} ` +
        `entries. It takes: ${calendar.components.join(', ')}.`
    );
  }

  const uid = `${randomUUID()}@caldav-mcp`;
  const { root, component } = newCalendar(kind, uid);
  build(component);
  const resourceName = `${uid.split('@')[0] ?? randomUUID()}.ics`;
  const url = `${calendar.url}${resourceName}`;
  const { etag } = await context.api.put(url, serialize(root), {
    create: true,
  });
  return { uid, resourceName, url, etag };
}
