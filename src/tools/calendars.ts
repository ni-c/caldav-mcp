import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/server';

import { freeBusyQueryBody, textMatchBody } from '../dav-xml.js';
import type { ToolContext } from '../entries.js';
import { notes, shapedCalendar, untrustedFields } from '../output-schema.js';
import { ownWordsResult, run, untrustedResult } from '../result.js';
import { shapeCalendar } from '../shape.js';
import { toUtcStamp } from '../time.js';
import { READ_ONLY } from './annotations.js';

/**
 * The two tools that describe the connection rather than its contents.
 *
 * Both take no calendar argument, and both are guarded by **filtering what they
 * print** rather than by resolving anything: they never turn a caller's string
 * into a URL, so there is nothing to bypass. `list_calendars` reports how many
 * entries `CALDAV_CALENDARS` withheld, because a listing that silently omits
 * calendars teaches the reader they do not exist — and then a perfectly correct
 * id from another source looks like a bug.
 */
export function registerCalendarTools(
  server: McpServer,
  context: ToolContext
): void {
  server.registerTool(
    'list_calendars',
    {
      title: 'List the calendars',
      description:
        'Every calendar this server may use, with the id to pass to the other ' +
        'tools. Always asks the server rather than answering from a cache — ' +
        'being current is this tool’s whole job.',
      inputSchema: z.object({}),
      annotations: READ_ONLY,
      outputSchema: z.object({
        ...untrustedFields,
        calendars: z.array(shapedCalendar),
        count: z.number().int(),
        withheld: z
          .number()
          .int()
          .describe(
            'Calendars CALDAV_CALENDARS is keeping out of sight. Reported so ' +
              'their absence does not read as their non-existence.'
          ),
        notes,
      }),
    },
    async () =>
      run(async () => {
        const registry = await context.discovery.registry(true);
        const principal = await context.discovery.principal();
        const allowed = registry.allowed();
        const unmatched = registry.unmatched();

        const collected = [...principal.notes];
        if (unmatched.length > 0) {
          collected.push(
            `CALDAV_CALENDARS names ${unmatched.length} entr` +
              `${unmatched.length === 1 ? 'y' : 'ies'} that match no calendar: ` +
              `${unmatched.join(', ')}. Check the spelling — an entry that ` +
              'matches nothing narrows this server for no reason.'
          );
        }

        return untrustedResult({
          calendars: allowed.map(shapeCalendar),
          count: allowed.length,
          withheld: registry.withheld(),
          ...(collected.length > 0 ? { notes: collected } : {}),
        });
      })
  );

  server.registerTool(
    'get_server_info',
    {
      title: 'What the connected CalDAV server can do',
      description:
        'Reports the DAV compliance tokens, which components each calendar ' +
        'accepts, and whether the optional features this server relies on ' +
        'actually work here. The first thing to run when something behaves ' +
        'differently than expected — CalDAV implementations differ more than ' +
        'the specification suggests.',
      inputSchema: z.object({}),
      annotations: READ_ONLY,
      // No untrusted marker: every field here is either a protocol token or
      // this server's own probe result. A marker on everything is a marker on
      // nothing.
      outputSchema: z.object({
        url: z.string(),
        principal: z.string().optional(),
        calendar_homes: z.array(z.string()),
        dav: z
          .array(z.string())
          .describe('DAV compliance tokens from the OPTIONS response.'),
        allowed_methods: z.array(z.string()),
        scheduling: z
          .boolean()
          .describe(
            'True when the server advertises calendar-auto-schedule, which ' +
              'means replying to an invitation sends mail to the organiser.'
          ),
        calendars: z.array(
          z.object({
            id: z.string(),
            components: z.array(z.string()),
            read_only: z.boolean(),
          })
        ),
        withheld: z.number().int(),
        features: z.object({
          text_match: z
            .boolean()
            .describe('Whether search_events can run on this server.'),
          free_busy: z
            .boolean()
            .describe('Whether get_free_busy can run on this server.'),
        }),
        self_addresses: z
          .array(z.string())
          .describe(
            'Addresses respond_to_event would act as. Empty means it cannot ' +
              'identify you — set CALDAV_USER_EMAIL.'
          ),
        notes,
      }),
    },
    async () =>
      run(async () => {
        const registry = await context.discovery.registry();
        const principal = await context.discovery.principal();
        const allowed = registry.allowed();
        const collected = [...principal.notes];

        const options = await context.api.options(`${context.api.url}/`);
        const scheduling = options.dav.some(
          (token) =>
            token.includes('calendar-auto-schedule') ||
            token.includes('calendar-schedule')
        );

        // Probe against a real calendar rather than guessing from the DAV
        // header: both features are things a server can advertise and answer
        // badly, and a listing that says "supported" and then returns nothing
        // is worse than one that says "no".
        const probe = allowed[0];
        let textMatch = false;
        let freeBusy = false;
        if (probe !== undefined) {
          const window = {
            start: toUtcStamp(new Date(Date.now() - 86_400_000)),
            end: toUtcStamp(new Date(Date.now() + 86_400_000)),
          };
          textMatch = await succeeds(() =>
            context.api.report(
              probe.url,
              1,
              textMatchBody('VEVENT', 'SUMMARY', 'caldav-mcp-probe', {
                range: window,
              })
            )
          );
          freeBusy = await succeeds(() =>
            context.api.freeBusy(probe.url, freeBusyQueryBody(window))
          );
          if (!textMatch) {
            collected.push(
              'This server refused a text-match query, so search_events will ' +
                'not work here. Use list_events with a time range instead.'
            );
          }
          if (!freeBusy) {
            collected.push(
              'This server refused a free-busy query, so get_free_busy falls ' +
                'back to computing busy periods from the events themselves.'
            );
          }
        }

        const selfAddresses =
          context.config.userEmail === undefined
            ? [...principal.addresses]
            : [context.config.userEmail, ...principal.addresses];
        if (selfAddresses.length === 0) {
          collected.push(
            'No address could be determined for this account, so ' +
              'respond_to_event cannot tell which attendee is you. Set ' +
              'CALDAV_USER_EMAIL. (Radicale reports a path here rather than an ' +
              'address, which is legal and unusable for that purpose.)'
          );
        }

        return ownWordsResult({
          url: context.api.url,
          ...(principal.url === undefined ? {} : { principal: principal.url }),
          calendar_homes: [...principal.homes],
          dav: options.dav,
          allowed_methods: options.allow,
          scheduling,
          calendars: allowed.map((calendar) => ({
            id: calendar.path,
            components: [...calendar.components],
            read_only: calendar.readOnly,
          })),
          withheld: registry.withheld(),
          features: { text_match: textMatch, free_busy: freeBusy },
          self_addresses: [...new Set(selfAddresses)],
          ...(collected.length > 0 ? { notes: collected } : {}),
        });
      })
  );
}

/** Whether a probe request went through at all. */
async function succeeds(request: () => Promise<unknown>): Promise<boolean> {
  try {
    await request();
    return true;
  } catch {
    return false;
  }
}
