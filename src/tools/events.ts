import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/server';

import { freeBusyQueryBody } from '../dav-xml.js';
import { listEntries, searchEntries, type ToolContext } from '../entries.js';
import { parseEntityId } from '../entity-id.js';
import {
  notes,
  shapedEvent,
  truncated,
  untrustedFields,
} from '../output-schema.js';
import {
  fencedUntrustedResult,
  ownWordsResult,
  run,
  untrustedResult,
} from '../result.js';
import {
  afterParam,
  calendarsParam,
  entityIdParam,
  instantParam,
  limitParam,
  timezoneParam,
} from '../schema.js';
import { toUtcStamp } from '../time.js';
import { ICAL } from '../ical.js';
import { READ_ONLY } from './annotations.js';
import { loadEntry, resolveWindow } from './common.js';

export function registerEventReadTools(
  server: McpServer,
  context: ToolContext
): void {
  server.registerTool(
    'list_events',
    {
      title: 'List events in a time range',
      description:
        'Events between two points in time, from every calendar this server ' +
        'may see or from the ones named. Recurring events are expanded into ' +
        'their individual occurrences, so each one has its own id and can be ' +
        'changed on its own. Defaults to the next 30 days.',
      inputSchema: z.object({
        from: instantParam
          .optional()
          .describe('Start of the window. Defaults to now.'),
        to: instantParam
          .optional()
          .describe('End of the window. Defaults to 30 days after `from`.'),
        timezone: timezoneParam,
        calendars: calendarsParam,
        limit: limitParam,
        after: afterParam,
      }),
      annotations: READ_ONLY,
      outputSchema: z.object({
        ...untrustedFields,
        events: z.array(shapedEvent),
        count: z.number().int(),
        window: z.object({ from: z.string(), to: z.string() }),
        notes,
        truncated,
      }),
    },
    async (args) =>
      run(async () => {
        const registry = await context.discovery.registry();
        const window = resolveWindow(args, context.config);
        const listing = await listEntries(context, {
          kind: 'vevent',
          calendars: registry.resolveMany(args.calendars),
          from: window.from,
          to: window.to,
          limit: args.limit ?? context.config.maxEntries,
          after: args.after,
        });
        return untrustedResult({
          events: listing.entries,
          count: listing.entries.length,
          window: {
            from: window.from.toISOString(),
            to: window.to.toISOString(),
          },
          ...(listing.notes.length > 0 ? { notes: listing.notes } : {}),
          ...(listing.truncated === undefined
            ? {}
            : { truncated: listing.truncated }),
        });
      })
  );

  server.registerTool(
    'get_event',
    {
      title: 'Read one event in full',
      description:
        'The complete event behind an id from a listing: the untruncated ' +
        'description, every reminder, every attendee, every attachment as ' +
        'metadata. An occurrence id answers with that one instance; a series ' +
        'id answers with the series and its rule.',
      inputSchema: z.object({ id: entityIdParam }),
      annotations: READ_ONLY,
      outputSchema: z.object({
        ...untrustedFields,
        event: shapedEvent,
        notes,
      }),
    },
    async ({ id }) =>
      run(async () => {
        const registry = await context.discovery.registry();
        const entity = parseEntityId(id, 'vevent', registry);
        const loaded = await loadEntry(context, entity, registry);
        return fencedUntrustedResult(
          {
            event: loaded.shaped.entry,
            ...(loaded.notes.length > 0 ? { notes: loaded.notes } : {}),
          },
          loaded.shaped.fenced,
          loaded.shaped.warnings
        );
      })
  );

  server.registerTool(
    'search_events',
    {
      title: 'Search events by text',
      description:
        'Finds events whose summary, description or location contains a term. ' +
        'The search runs on the CalDAV server, one request per field and per ' +
        'calendar — the specification combines several field filters with AND, ' +
        'so asking for all three at once would only match entries carrying the ' +
        'term in every one of them.',
      inputSchema: z.object({
        query: z
          .string()
          .trim()
          .min(1)
          .max(200)
          .describe(
            'The term to look for. Matching is the server’s to define.'
          ),
        fields: z
          .array(z.enum(['SUMMARY', 'DESCRIPTION', 'LOCATION']))
          .min(1)
          .max(3)
          .optional()
          .describe('Which fields to search. Defaults to all three.'),
        from: instantParam.optional(),
        to: instantParam.optional(),
        timezone: timezoneParam,
        calendars: calendarsParam,
        limit: limitParam,
      }),
      annotations: READ_ONLY,
      outputSchema: z.object({
        ...untrustedFields,
        events: z.array(shapedEvent),
        count: z.number().int(),
        window: z.object({ from: z.string(), to: z.string() }),
        collation: z
          .string()
          .optional()
          .describe('Set when the server refused its own default collation.'),
        notes,
        truncated,
      }),
    },
    async (args) =>
      run(async () => {
        const registry = await context.discovery.registry();
        // A whole year by default: a text search is asked when the time is not
        // known, so defaulting to the next 30 days would answer "nothing" for
        // the case the tool exists to serve.
        const window = resolveWindow(args, context.config, 365);
        const result = await searchEntries(context, {
          kind: 'vevent',
          calendars: registry.resolveMany(args.calendars),
          from: window.from,
          to: window.to,
          limit: args.limit ?? context.config.maxEntries,
          query: args.query,
          fields: args.fields ?? ['SUMMARY', 'DESCRIPTION', 'LOCATION'],
        });
        return untrustedResult({
          events: result.entries,
          count: result.entries.length,
          window: {
            from: window.from.toISOString(),
            to: window.to.toISOString(),
          },
          ...(result.collation === undefined
            ? {}
            : { collation: result.collation }),
          ...(result.notes.length > 0 ? { notes: result.notes } : {}),
          ...(result.truncated === undefined
            ? {}
            : { truncated: result.truncated }),
        });
      })
  );

  server.registerTool(
    'get_free_busy',
    {
      title: 'When the calendar is busy',
      description:
        'Busy periods in a time range — start and end only, no titles and no ' +
        'attendees. The datasparing way to ask "when am I free": nothing ' +
        'anybody else wrote comes back, so there is no untrusted content in ' +
        'the answer at all.',
      inputSchema: z.object({
        from: instantParam.optional(),
        to: instantParam.optional(),
        timezone: timezoneParam,
        calendars: calendarsParam,
      }),
      annotations: READ_ONLY,
      // No untrusted marker: the answer is time periods this server computed or
      // the server reported, and carries none of anybody's text.
      outputSchema: z.object({
        busy: z.array(
          z.object({
            start: z.string().describe('ISO 8601.'),
            end: z.string().describe('ISO 8601.'),
            type: z
              .string()
              .optional()
              .describe('FBTYPE, where the server gave one.'),
            calendar: z.string(),
          })
        ),
        count: z.number().int(),
        window: z.object({ from: z.string(), to: z.string() }),
        method: z
          .enum(['server', 'computed'])
          .describe(
            'Whether the CalDAV server answered a free-busy query, or this ' +
              'server worked the periods out from the events itself.'
          ),
        notes,
      }),
    },
    async (args) =>
      run(async () => {
        const registry = await context.discovery.registry();
        const window = resolveWindow(args, context.config);
        const calendars = registry.resolveMany(args.calendars);
        const range = {
          start: toUtcStamp(window.from),
          end: toUtcStamp(window.to),
        };
        const collected: {
          start: string;
          end: string;
          type?: string;
          calendar: string;
        }[] = [];
        const collectedNotes: string[] = [];
        let method: 'server' | 'computed' = 'server';

        for (const calendar of calendars) {
          try {
            const ics = await context.api.freeBusy(
              calendar.url,
              freeBusyQueryBody(range)
            );
            collected.push(...parseFreeBusy(ics, calendar.path));
          } catch {
            // The principal-level scheduling POST is deliberately not used as a
            // fallback: it aggregates every calendar the principal owns,
            // allowlist or not, which would be a way around CALDAV_CALENDARS.
            method = 'computed';
            const listing = await listEntries(context, {
              kind: 'vevent',
              calendars: [calendar],
              from: window.from,
              to: window.to,
              limit: context.config.maxEntries,
            });
            collectedNotes.push(...listing.notes);
            for (const entry of listing.entries) {
              const busy = busyOf(entry, calendar.path);
              if (busy !== undefined) collected.push(busy);
            }
          }
        }

        collected.sort((left, right) => left.start.localeCompare(right.start));
        if (method === 'computed') {
          collectedNotes.push(
            'At least one calendar refused a free-busy query, so the periods ' +
              'were worked out from the events instead. Events marked ' +
              'transparent or cancelled are left out, as a free-busy answer ' +
              'would leave them out.'
          );
        }

        return ownWordsResult({
          busy: collected,
          count: collected.length,
          window: {
            from: window.from.toISOString(),
            to: window.to.toISOString(),
          },
          method,
          ...(collectedNotes.length > 0
            ? { notes: [...new Set(collectedNotes)] }
            : {}),
        });
      })
  );
}

/**
 * Reads the periods out of a VFREEBUSY document.
 *
 * Deliberately a small hand parser rather than a trip through ical.js: the
 * answer is a flat list of `start/end` pairs and the only thing that can go
 * wrong is the shape, which a regex states more plainly than a component walk.
 * Radicale answers with one VFREEBUSY *component per period* rather than one
 * component carrying several FREEBUSY properties, so both are read.
 */
export function parseFreeBusy(
  ics: string,
  calendarPath: string
): { start: string; end: string; type?: string; calendar: string }[] {
  const unfolded = ics.replace(/\r?\n[ \t]/g, '');
  const periods: {
    start: string;
    end: string;
    type?: string;
    calendar: string;
  }[] = [];

  // One component per period: DTSTART/DTEND inside a VFREEBUSY block.
  for (const block of unfolded.split(/BEGIN:VFREEBUSY/i).slice(1)) {
    const body = block.split(/END:VFREEBUSY/i)[0] ?? '';
    const start = /^DTSTART[^:]*:(\S+)/m.exec(body)?.[1];
    const end = /^DTEND[^:]*:(\S+)/m.exec(body)?.[1];
    const type = /^FBTYPE[^:]*:(\S+)/m.exec(body)?.[1];
    const from = start === undefined ? undefined : isoOfStamp(start);
    const until = end === undefined ? undefined : isoOfStamp(end);
    if (from !== undefined && until !== undefined) {
      periods.push({
        start: from,
        end: until,
        ...(type === undefined ? {} : { type }),
        calendar: calendarPath,
      });
    }
    // The other shape: FREEBUSY properties carrying `start/end` pairs.
    for (const match of body.matchAll(
      /^FREEBUSY(?:;FBTYPE=([A-Z-]+))?[^:]*:(.+)$/gim
    )) {
      for (const pair of (match[2] ?? '').split(',')) {
        const [rawStart, rawEnd] = pair.trim().split('/');
        if (rawStart === undefined || rawEnd === undefined) continue;
        const pairStart = isoOfStamp(rawStart);
        const pairEnd = periodEnd(pairStart, rawEnd);
        if (pairStart === undefined || pairEnd === undefined) continue;
        periods.push({
          start: pairStart,
          end: pairEnd,
          ...(match[1] === undefined ? {} : { type: match[1] }),
          calendar: calendarPath,
        });
      }
    }
  }
  return periods;
}

/**
 * `20260907T070000Z` to an ISO 8601 string, or nothing.
 *
 * Anything unparseable is **dropped**, not passed through. This is the one
 * tool with no untrusted marker, and the justification for that is written
 * into its description: the answer is time periods and nothing else, so there
 * is no place for text a stranger wrote. A passthrough quietly made that
 * false — a server answering `DTSTART:<whatever it liked>` put its own string
 * into a field the model reads as a timestamp, unmarked and unfenced. A
 * free/busy answer whose stamps are not stamps is not a usable answer anyway.
 */
function isoOfStamp(stamp: string): string | undefined {
  const match = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/.exec(
    stamp.trim()
  );
  if (match === null) return undefined;
  return `${match[1]}-${match[2]}-${match[3]}T${match[4]}:${match[5]}:${match[6]}Z`;
}

/**
 * The end of a `FREEBUSY` period, which RFC 5545 writes in either of two ways.
 *
 * `start/end` is the common one and `start/duration` is equally legal — sabre
 * emits it — so refusing what is not a timestamp has to understand a duration
 * as well, or a correct answer from a correct server disappears.
 */
function periodEnd(start: string | undefined, raw: string): string | undefined {
  const asStamp = isoOfStamp(raw);
  if (asStamp !== undefined) return asStamp;
  if (start === undefined || !/^[+-]?P/i.test(raw.trim())) return undefined;
  let seconds: number;
  try {
    seconds = ICAL.Duration.fromString(raw.trim()).toSeconds();
  } catch {
    return undefined;
  }
  if (!Number.isFinite(seconds)) return undefined;
  const end = new Date(Date.parse(start) + seconds * 1000);
  if (Number.isNaN(end.getTime())) return undefined;
  // Second precision, so both branches answer in one format.
  return `${end.toISOString().slice(0, 19)}Z`;
}

/** A busy period from a shaped event, for the computed fallback. */
function busyOf(
  entry: Record<string, unknown>,
  calendarPath: string
): { start: string; end: string; calendar: string } | undefined {
  if (entry.transparent === true) return undefined;
  if (String(entry.status ?? '').toUpperCase() === 'CANCELLED')
    return undefined;
  const start = (entry.start as { value?: string } | undefined)?.value;
  const end = (entry.end as { value?: string } | undefined)?.value ?? start;
  if (start === undefined || end === undefined) return undefined;
  return { start, end, calendar: calendarPath };
}
