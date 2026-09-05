import type { CalendarRegistry } from '../calendars.js';
import type { Config } from '../config.js';
import type { ToolContext } from '../entries.js';
import type { EntityId } from '../entity-id.js';
import { ToolInputError } from '../errors.js';
import { componentsOf, parseCalendar } from '../ical.js';
import { expandSeries, type Occurrence } from '../recurrence.js';
import { shapeEntry, type Shaped } from '../shape.js';
import { parseInstant } from '../time.js';

/** Longest window a listing accepts, in days. */
const MAX_WINDOW_DAYS = 366;

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Turns the `from`/`to`/`timezone` arguments into a window.
 *
 * A window longer than a year is **refused rather than truncated**. A truncated
 * ten-year window reads exactly like "there is nothing after this", which is
 * the worst wrong answer a calendar can give — the caller believes the diary is
 * empty. Saying no is unhelpful in a way the reader can see and act on.
 */
export function resolveWindow(
  args: {
    from?: string | undefined;
    to?: string | undefined;
    timezone?: string | undefined;
  },
  config: Config,
  defaultDays = 30
): { from: Date; to: Date } {
  const from =
    args.from === undefined
      ? new Date()
      : parseInstant(args.from, 'from', config.timezone, args.timezone).instant;
  const to =
    args.to === undefined
      ? new Date(from.getTime() + defaultDays * DAY_MS)
      : parseInstant(args.to, 'to', config.timezone, args.timezone).instant;

  if (to.getTime() <= from.getTime()) {
    throw new ToolInputError('caldav-mcp: `to` has to be after `from`.');
  }
  if (to.getTime() - from.getTime() > MAX_WINDOW_DAYS * DAY_MS) {
    throw new ToolInputError(
      `caldav-mcp: that window is longer than ${MAX_WINDOW_DAYS} days. Ask ` +
        'for a shorter one — a window this server had to cut short would look ' +
        'exactly like a calendar with nothing in it.'
    );
  }
  return { from, to };
}

/** One entry, fetched and shaped in full. */
export interface LoadedShape {
  shaped: Shaped;
  notes: string[];
  etag: string | undefined;
}

/**
 * Fetches the resource an id names and shapes the instance it addresses.
 *
 * The allowlist check already happened in `parseEntityId`, which is why this
 * takes an `EntityId` rather than a string: there is no way to reach this
 * function with a calendar the operator fenced off.
 */
export async function loadEntry(
  context: ToolContext,
  entity: EntityId,
  registry: CalendarRegistry
): Promise<LoadedShape> {
  const calendar = registry.byPath(entity.calendarPath);
  if (calendar === undefined) {
    throw new ToolInputError(
      'caldav-mcp: that calendar is no longer available. Call list_calendars.'
    );
  }
  const url = `${calendar.url}${entity.resourceName}`;
  const resource = await context.api.get(url);
  const root = parseCalendar(resource.ics, `the entry ${entity.resourceName}`);
  const components = componentsOf(root, entity.kind);
  if (components.length === 0) {
    throw new ToolInputError(
      'caldav-mcp: that entry no longer holds anything of the kind this tool ' +
        'reads. It may have been replaced.'
    );
  }

  // A window wide enough that the addressed occurrence is certainly inside it,
  // rather than a guess based on the recurrence id: an override may have moved
  // the instance far from where the rule put it.
  const expansion = expandSeries(components, {
    from: new Date(-8_640_000_000_000),
    to: new Date(8_640_000_000_000),
    cap: 1_000,
    fallbackZone: context.config.timezone,
  });

  const occurrence = pick(expansion.occurrences, entity.recurrenceId);
  if (occurrence === undefined) {
    throw new ToolInputError(
      entity.recurrenceId === undefined
        ? 'caldav-mcp: that entry has no readable content.'
        : 'caldav-mcp: that occurrence is not part of this entry any more — ' +
            'the series may have been changed or the occurrence deleted. List ' +
            'the entries again.'
    );
  }

  const principal = await context.discovery.principal();
  const selfAddresses =
    context.config.userEmail === undefined
      ? [...principal.addresses]
      : [context.config.userEmail, ...principal.addresses];

  return {
    shaped: shapeEntry(occurrence, {
      kind: entity.kind,
      calendar,
      resourceName: entity.resourceName,
      fallbackZone: context.config.timezone,
      detailed: true,
      selfAddresses,
    }),
    notes: expansion.notes,
    etag: resource.etag,
  };
}

/**
 * The occurrence an id addresses.
 *
 * A series id takes the first occurrence, which is the master's own instance —
 * that is what "the series" means when one component has to stand for it, and
 * the RRULE travels with it.
 */
function pick(
  occurrences: readonly Occurrence[],
  recurrenceId: string | undefined
): Occurrence | undefined {
  if (recurrenceId === undefined) return occurrences[0];
  return occurrences.find(
    (occurrence) => occurrence.recurrenceId === recurrenceId
  );
}
