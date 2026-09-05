import type { CalDavApi } from './api.js';
import type { CalendarEntry } from './calendars.js';
import type { Config } from './config.js';
import {
  calendarQueryBody,
  textMatchBody,
  type SearchField,
  type TimeRange,
} from './dav-xml.js';
import type { Discovery } from './discovery.js';
import { ToolInputError } from './errors.js';
import {
  COMPONENT_OF,
  componentsOf,
  parseCalendar,
  type Kind,
} from './ical.js';
import {
  expandSeries,
  WINDOW_SLACK_MS,
  type Occurrence,
} from './recurrence.js';
import { shapeEntry } from './shape.js';
import { toUtcStamp } from './time.js';

/**
 * The read pipeline: query, expand, shape, page.
 *
 * Every listing tool goes through here, which is what keeps the three of them
 * (events, tasks, journals) from drifting apart in how they page, how they cap
 * and how they report a truncated answer.
 */

/** Everything a tool needs to answer. Built once in `createServer`. */
export interface ToolContext {
  api: CalDavApi;
  discovery: Discovery;
  config: Config;
}

/** One calendar resource as fetched, with the name its id is built from. */
export interface ResourceDocument {
  calendar: CalendarEntry;
  resourceName: string;
  ics: string;
  etag: string | undefined;
}

/**
 * The file name of a resource, from the href a multistatus reported it under.
 *
 * Percent-encoding is preserved: the name is what goes into an id and what is
 * appended to the collection URL to reach the resource again, so decoding it
 * here would produce a URL that does not resolve.
 *
 * The href is a value the server chose, so it gets the same two checks every
 * other server-supplied link gets. `resolveHref` pins it to the configured
 * origin. The parent-directory check is the one that matters here: a REPORT is
 * issued against one collection, and a response naming a resource in a
 * different one would otherwise be filed under the calendar that was asked —
 * so an entry out of a collection the operator fenced off would be listed as
 * belonging to one they allowed, with an id that then reads a different
 * resource. Empty means "not from this collection, drop it", which is what the
 * caller already does with an unnamed resource.
 */
export function resourceNameOf(
  href: string,
  api: Pick<CalDavApi, 'resolveHref'>,
  calendar: Pick<CalendarEntry, 'url' | 'path'>
): string {
  let path: string;
  try {
    path = new URL(api.resolveHref(href, calendar.url)).pathname;
  } catch {
    return '';
  }
  const parent = path.replace(/[^/]*$/, '');
  if (parent !== calendar.path) return '';
  const parts = path.split('/').filter((part) => part.length > 0);
  return parts[parts.length - 1] ?? '';
}

/** Runs a `calendar-query` against one calendar and returns its resources. */
async function queryCalendar(
  api: CalDavApi,
  calendar: CalendarEntry,
  body: string
): Promise<ResourceDocument[]> {
  const responses = await api.report(calendar.url, 1, body);
  const documents: ResourceDocument[] = [];
  for (const response of responses) {
    const data = response.props['calendar-data'];
    if (typeof data !== 'string' || data.length === 0) continue;
    const name = resourceNameOf(response.href, api, calendar);
    if (name === '') continue;
    documents.push({
      calendar,
      resourceName: name,
      ics: data,
      etag:
        typeof response.props.getetag === 'string'
          ? response.props.getetag
          : undefined,
    });
  }
  return documents;
}

/** A window, already widened by the override slack. */
function requestRange(from: Date, to: Date): TimeRange {
  return {
    start: toUtcStamp(new Date(from.getTime() - WINDOW_SLACK_MS)),
    end: toUtcStamp(new Date(to.getTime() + WINDOW_SLACK_MS)),
  };
}

export interface ListOptions {
  kind: Kind;
  calendars: readonly CalendarEntry[];
  from: Date;
  to: Date;
  /** Most entries to return. Already clamped by the caller. */
  limit: number;
  /** A cursor from a previous truncated answer. */
  after?: string | undefined;
}

export interface Listing {
  entries: Record<string, unknown>[];
  notes: string[];
  truncated?: Record<string, unknown>;
}

/**
 * Lists entries across calendars, merged and sorted by start time.
 *
 * The cap applies **after** merging, never per calendar: capping each calendar
 * separately lets the alphabetically first one spend the whole budget and hides
 * everything in the others behind it.
 */
export async function listEntries(
  context: ToolContext,
  options: ListOptions
): Promise<Listing> {
  const notes: string[] = [];
  const deadline = Date.now() + 5_000;
  const boundedSeries: string[] = [];
  const collected: {
    occurrence: Occurrence;
    document: ResourceDocument;
  }[] = [];

  const range = requestRange(options.from, options.to);
  const component = COMPONENT_OF[options.kind];

  for (const calendar of options.calendars) {
    if (!accepts(calendar, component)) continue;
    const documents = await queryCalendar(
      context.api,
      calendar,
      calendarQueryBody(component, range)
    );
    for (const document of documents) {
      const result = expandOne(
        document,
        options,
        deadline,
        context.config.timezone
      );
      notes.push(...result.notes);
      if (result.bounded) {
        const uid = uidOf(document);
        if (uid !== undefined) boundedSeries.push(uid);
      }
      for (const occurrence of result.occurrences) {
        collected.push({ occurrence, document });
      }
    }
  }

  collected.sort(
    (left, right) =>
      left.occurrence.start.instant.getTime() -
        right.occurrence.start.instant.getTime() ||
      left.document.resourceName.localeCompare(right.document.resourceName)
  );

  const principal = await context.discovery.principal();
  const selfAddresses = selfAddressesOf(context.config, principal.addresses);

  const shaped = collected.map(({ occurrence, document }) =>
    shapeEntry(occurrence, {
      kind: options.kind,
      calendar: document.calendar,
      resourceName: document.resourceName,
      fallbackZone: context.config.timezone,
      detailed: false,
      selfAddresses,
    })
  );

  const afterIndex =
    options.after === undefined ? 0 : cursorIndex(shaped, options.after);
  const page = shaped.slice(afterIndex, afterIndex + options.limit);
  const remaining = shaped.length - (afterIndex + page.length);

  const listing: Listing = {
    entries: page.map((item) => item.entry),
    notes: dedupe(notes),
  };

  if (remaining > 0 || boundedSeries.length > 0) {
    const last = page[page.length - 1];
    const nextStart = shaped[afterIndex + page.length];
    listing.truncated = {
      reason:
        remaining > 0
          ? `${remaining} more entr${remaining === 1 ? 'y' : 'ies'} in this window.`
          : 'At least one recurring entry generated more occurrences than could be walked.',
      returned: page.length,
      ...(last === undefined
        ? {}
        : {
            window_covered_until: startValueOf(last.entry) ?? '',
          }),
      ...(nextStart === undefined
        ? {}
        : { next_cursor: cursorOf(nextStart.entry) }),
      ...(boundedSeries.length > 0
        ? { bounded_series: dedupe(boundedSeries) }
        : {}),
      follow_up:
        remaining > 0
          ? 'Call again with `after` set to next_cursor, or narrow the window.'
          : 'Narrow the window; the entries named in bounded_series are the expensive ones.',
    };
  }

  return listing;
}

/** Searches one field across calendars and returns whole matching entries. */
export async function searchEntries(
  context: ToolContext,
  options: ListOptions & { query: string; fields: readonly SearchField[] }
): Promise<Listing & { collation?: string }> {
  const range = requestRange(options.from, options.to);
  const component = COMPONENT_OF[options.kind];
  const notes: string[] = [];
  let collation: string | undefined;

  const documents: ResourceDocument[] = [];
  for (const calendar of options.calendars) {
    if (!accepts(calendar, component)) continue;
    const seen = new Set<string>();
    // One REPORT per field, unioned by resource: RFC 4791 combines sibling
    // prop-filters with AND, so a single body asking for SUMMARY *and*
    // DESCRIPTION matches only entries carrying the term in both.
    for (const field of options.fields) {
      let matched: ResourceDocument[];
      try {
        matched = await queryCalendar(
          context.api,
          calendar,
          textMatchBody(component, field, options.query, { range })
        );
      } catch (error) {
        // Some sabre/dav builds refuse the server default collation and want
        // one named. Retried once, and the degradation is reported rather than
        // hidden — a search that quietly became case-sensitive is worse than a
        // search that says so.
        if (!isCollationRefusal(error)) throw error;
        collation = 'i;ascii-casemap';
        matched = await queryCalendar(
          context.api,
          calendar,
          textMatchBody(component, field, options.query, {
            range,
            collation,
          })
        );
      }
      for (const document of matched) {
        if (seen.has(document.resourceName)) continue;
        seen.add(document.resourceName);
        documents.push(document);
      }
    }
  }

  if (collation !== undefined) {
    notes.push(
      'This server refused the default text collation, so the search ran with ' +
        'i;ascii-casemap. Matching outside ASCII may differ from what a ' +
        'calendar client shows.'
    );
  }

  const deadline = Date.now() + 5_000;
  const collected: { occurrence: Occurrence; document: ResourceDocument }[] =
    [];
  for (const document of documents) {
    const result = expandOne(
      document,
      options,
      deadline,
      context.config.timezone
    );
    notes.push(...result.notes);
    for (const occurrence of result.occurrences) {
      collected.push({ occurrence, document });
    }
  }
  collected.sort(
    (left, right) =>
      left.occurrence.start.instant.getTime() -
      right.occurrence.start.instant.getTime()
  );

  const principal = await context.discovery.principal();
  const selfAddresses = selfAddressesOf(context.config, principal.addresses);
  const page = collected.slice(0, options.limit);

  return {
    entries: page.map(
      ({ occurrence, document }) =>
        shapeEntry(occurrence, {
          kind: options.kind,
          calendar: document.calendar,
          resourceName: document.resourceName,
          fallbackZone: context.config.timezone,
          detailed: false,
          selfAddresses,
        }).entry
    ),
    notes: dedupe(notes),
    ...(collected.length > page.length
      ? {
          truncated: {
            reason: `${collected.length - page.length} more matches.`,
            returned: page.length,
            follow_up: 'Narrow the query or the time range.',
          },
        }
      : {}),
    ...(collation === undefined ? {} : { collation }),
  };
}

function expandOne(
  document: ResourceDocument,
  options: { kind: Kind; from: Date; to: Date; limit: number },
  deadline: number,
  fallbackZone: string
) {
  const root = parseCalendar(
    document.ics,
    `the entry ${document.resourceName}`
  );
  return expandSeries(componentsOf(root, options.kind), {
    from: options.from,
    to: options.to,
    // One entry may not exceed the whole answer, so the per-series cap is the
    // request cap. It cannot spend more than that anyway.
    cap: options.limit,
    fallbackZone,
    deadline,
  });
}

function accepts(calendar: CalendarEntry, component: string): boolean {
  return (
    calendar.components.length === 0 || calendar.components.includes(component)
  );
}

function uidOf(document: ResourceDocument): string | undefined {
  const match = /^UID:(.+)$/m.exec(document.ics);
  return match?.[1]?.trim();
}

function startValueOf(entry: Record<string, unknown>): string | undefined {
  const start = entry.start as { value?: string } | undefined;
  return start?.value;
}

/**
 * The cursor for the next page: a start time and an id.
 *
 * Not an offset. An offset into an expansion is not stable between two calls —
 * a new entry created in between shifts everything after it — and two
 * occurrences sharing a start time would be dropped or duplicated at the page
 * boundary if the id half were left out.
 */
function cursorOf(entry: Record<string, unknown>): string {
  return `${startValueOf(entry) ?? ''}|${String(entry.id ?? '')}`;
}

function cursorIndex(
  shaped: readonly { entry: Record<string, unknown> }[],
  cursor: string
): number {
  const index = shaped.findIndex((item) => cursorOf(item.entry) === cursor);
  if (index === -1) {
    throw new ToolInputError(
      'caldav-mcp: that cursor does not match anything in this window. It ' +
        'comes from the `truncated.next_cursor` of a previous call, and the ' +
        'window has to be the same one.'
    );
  }
  return index;
}

/**
 * The addresses `respond_to_event` would act as.
 *
 * `CALDAV_USER_EMAIL` first, because the discovered set is often useless:
 * Radicale answers `calendar-user-address-set` with the principal *path* rather
 * than a `mailto:` URI, so on that server there is nothing to match an ATTENDEE
 * line against and the variable is the only way.
 */
export function selfAddressesOf(
  config: Config,
  discovered: readonly string[]
): string[] {
  const configured = config.userEmail?.toLowerCase();
  return configured === undefined
    ? [...discovered]
    : [configured, ...discovered];
}

function dedupe(values: readonly string[]): string[] {
  return [...new Set(values)];
}

function isCollationRefusal(error: unknown): boolean {
  return (
    error !== null &&
    typeof error === 'object' &&
    'precondition' in error &&
    String((error as { precondition?: unknown }).precondition ?? '').includes(
      'collation'
    )
  );
}
