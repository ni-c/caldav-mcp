import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/server';
import {
  setResourceKey,
  type Approver,
  type ConfirmationStore,
} from 'mcp-approval';

import { escapeInvisible } from '../analyze.js';
import type { ToolContext } from '../entries.js';
import { buildSeriesId, parseEntityId, type EntityId } from '../entity-id.js';
import { ToolInputError } from '../errors.js';
import {
  ICAL,
  componentsOf,
  parseCalendar,
  readText,
  serialize,
  splitSeries,
  writeTime,
} from '../ical.js';
import { notes, shapedEvent, untrustedFields } from '../output-schema.js';
import {
  errorResult,
  ownWordsResult,
  run,
  untrustedResult,
} from '../result.js';
import { parseRecurrenceId } from '../recurrence.js';
import {
  alarmsParam,
  calendarRefParam,
  categoriesParam,
  confirmTokenParam,
  entityIdParam,
  instantParam,
  scopeParam,
  textParam,
  timezoneParam,
} from '../schema.js';
import { parseInstant } from '../time.js';
import {
  applyAlarms,
  applyCommonFields,
  commit,
  createEntry,
  loadForWrite,
  type Scope,
} from '../write.js';
import { CREATE, DELETE, MOVE, REPLACE, SET_STATE } from './annotations.js';
import { loadEntry } from './common.js';

/**
 * The tools that change a calendar.
 *
 * Which of them ask a person, and why each answer is what it is:
 *
 * - **`delete_event` and `move_event` always ask.** One removes content with no
 *   history behind it; the other changes the resource URL, so every id that
 *   named the entry stops working — and its destination may be a shared
 *   calendar, which makes it a disclosure as well as a move.
 * - **`respond_to_event` always asks**, although it is *not* destructive. On a
 *   scheduling server it emails an iTIP reply to the organiser, and mail that
 *   has left cannot be recalled. Irreversible and destructive are different
 *   axes; only one of them has an annotation, which is exactly why the dialog
 *   exists as well as the hints.
 * - **`update_event` asks only for `scope: entire_series` on a recurring
 *   entry.** Gating every edit is how an operator ends up switching
 *   `ELICITATION` off altogether, and then nothing asks at all. The ETag is what
 *   guards the ordinary edit; the dialog is for the one edit that reaches beyond
 *   the instance the caller was looking at.
 */
export function registerEventWriteTools(
  server: McpServer,
  context: ToolContext,
  confirmations: ConfirmationStore,
  approval: Approver
): void {
  server.registerTool(
    'create_event',
    {
      title: 'Create an event',
      description:
        'Adds an event to a calendar. The UID and the file name are generated ' +
        'here, so an existing entry can never be overwritten by accident. ' +
        'Times without an offset are read in the timezone argument or in ' +
        'CALDAV_TIMEZONE.',
      inputSchema: z.object({
        calendar_id: calendarRefParam,
        summary: z.string().trim().min(1).max(1000).describe('The title.'),
        start: instantParam.describe(
          'When it starts. A bare date makes it an all-day event.'
        ),
        end: instantParam
          .optional()
          .describe(
            'When it ends. For an all-day event this is exclusive, as ' +
              'iCalendar defines it: a single day ends on the following date. ' +
              'Defaults to one hour after the start, or one day for an all-day ' +
              'event.'
          ),
        timezone: timezoneParam,
        description: textParam('Longer text.'),
        location: textParam('Where it happens.', 1000),
        categories: categoriesParam,
        status: z.enum(['CONFIRMED', 'TENTATIVE', 'CANCELLED']).optional(),
        transparent: z
          .boolean()
          .optional()
          .describe('True to leave the time free rather than marking it busy.'),
        recurrence: z
          .string()
          .trim()
          .max(500)
          .optional()
          .describe(
            'A raw RRULE, e.g. "FREQ=WEEKLY;BYDAY=MO;COUNT=10". Given as ' +
              'written rather than as separate fields, because the rule ' +
              'grammar is richer than any short set of parameters, and a ' +
              'half-modelled rule is how a series ends up wrong.'
          ),
        alarms: alarmsParam,
      }),
      annotations: CREATE,
      outputSchema: z.object({
        created: z.literal(true),
        id: z.string(),
        uid: z.string(),
        calendar: z.string(),
        etag: z.string().optional(),
        alarms_preserved: z.number().int().optional(),
      }),
    },
    async (args) =>
      run(async () => {
        const registry = await context.discovery.registry();
        const calendar = registry.resolve(args.calendar_id);
        const start = parseInstant(
          args.start,
          'start',
          context.config.timezone,
          args.timezone
        );
        const end = resolveEnd(args, start, context.config.timezone);

        const created = await createEntry(
          context,
          calendar,
          'vevent',
          (component) => {
            writeTime(component, 'dtstart', {
              instant: start.instant,
              zone: start.zone,
              allDay: start.allDay,
            });
            writeTime(component, 'dtend', {
              instant: end.instant,
              zone: end.zone,
              allDay: end.allDay,
            });
            applyCommonFields(component, {
              summary: args.summary,
              description: args.description,
              location: args.location,
              status: args.status,
              categories: args.categories,
            });
            if (args.transparent !== undefined) {
              component.updatePropertyWithValue(
                'transp',
                args.transparent ? 'TRANSPARENT' : 'OPAQUE'
              );
            }
            if (args.recurrence !== undefined) {
              setRecurrence(component, args.recurrence);
            }
            applyAlarms(component, args.alarms, context.config.timezone);
          }
        );

        context.discovery.invalidate();
        return ownWordsResult({
          created: true,
          id: buildSeriesId('vevent', calendar.path, created.resourceName),
          uid: created.uid,
          calendar: calendar.path,
          ...(created.etag === undefined ? {} : { etag: created.etag }),
        });
      })
  );

  server.registerTool(
    'update_event',
    {
      title: 'Change an event',
      description:
        'Changes the fields named and leaves everything else exactly as it ' +
        'was — including properties this server does not model, attendees, ' +
        'attachments and reminders it cannot write. Pass null to clear a ' +
        'field. Guarded by the entry’s ETag: if it changed since it was read, ' +
        'nothing is written and the answer says what it is now. Changing a ' +
        'whole recurring series asks first.',
      inputSchema: z.object({
        id: entityIdParam,
        scope: scopeParam,
        summary: z.string().trim().min(1).max(1000).optional(),
        start: instantParam.optional(),
        end: instantParam.optional(),
        timezone: timezoneParam,
        description: textParam('Longer text.'),
        location: textParam('Where it happens.', 1000),
        categories: categoriesParam,
        status: z.enum(['CONFIRMED', 'TENTATIVE', 'CANCELLED']).optional(),
        transparent: z.boolean().optional(),
        alarms: alarmsParam,
        confirm_token: confirmTokenParam,
      }),
      annotations: REPLACE,
      outputSchema: z.object({
        ...untrustedFields,
        written: z.literal(true),
        id: z.string(),
        scope: z.enum(['this_occurrence', 'entire_series']),
        etag: z.string().optional(),
        alarms_preserved: z.number().int().optional(),
        event: shapedEvent,
        notes,
      }),
    },
    async (args, mcp) =>
      run(async () => {
        const registry = await context.discovery.registry();
        const entity = parseEntityId(args.id, 'vevent', registry);
        const scope = resolveScope(entity, args.scope);

        if (nothingToDo(args)) {
          throw new ToolInputError(
            'caldav-mcp: nothing to change — pass at least one field.'
          );
        }

        // Only the edit that reaches past the instance the caller was looking
        // at asks. See the note at the top of this file.
        if (scope === 'entire_series' && entity.recurrenceId !== undefined) {
          const outcome = await approval.requestApproval(
            server,
            mcp,
            confirmations,
            {
              what: 'change every occurrence of a recurring event',
              consequence:
                'The change applies to the whole series, not only the ' +
                'occurrence that was listed. A CalDAV server keeps no history, ' +
                'so the previous text cannot be recovered.',
              resourceKey: setResourceKey('update_event:series', [
                entity.calendarPath,
                entity.resourceName,
              ]),
              token: args.confirm_token,
              toolName: 'update_event',
              title: 'Change the whole series?',
              hint: 'Tick to change every occurrence, leave it to cancel.',
              details: [
                {
                  label: 'Calendar',
                  value: escapeInvisible(entity.calendarPath),
                },
              ],
            }
          );
          if (outcome.decision === 'rejected')
            return errorResult(outcome.reason);
          if (outcome.decision === 'declined') {
            return errorResult(
              'The user declined. update_event changed nothing.'
            );
          }
          if (outcome.decision === 'pending') return outcome.result;
        }

        const loaded = await loadForWrite(context, entity, scope);
        const target = loaded.target;

        if (args.start !== undefined || args.end !== undefined) {
          applyTimes(target, args, context.config.timezone);
        }
        applyCommonFields(target, {
          summary: args.summary,
          description: args.description,
          location: args.location,
          status: args.status,
          categories: args.categories,
        });
        if (args.transparent !== undefined) {
          target.updatePropertyWithValue(
            'transp',
            args.transparent ? 'TRANSPARENT' : 'OPAQUE'
          );
        }
        const preserved = applyAlarms(
          target,
          args.alarms,
          context.config.timezone
        );

        const result = await commit(context, loaded, (component) => ({
          summary: readText(component, 'summary') ?? '(no title)',
        }));

        const fresh = await loadEntry(context, entity, registry);
        return untrustedResult({
          written: true,
          id: args.id,
          scope,
          ...(result.etag === undefined ? {} : { etag: result.etag }),
          ...(preserved > 0 ? { alarms_preserved: preserved } : {}),
          event: fresh.shaped.entry,
          ...(fresh.notes.length > 0 ? { notes: fresh.notes } : {}),
        });
      })
  );

  server.registerTool(
    'delete_event',
    {
      title: 'Delete an event',
      description:
        'Removes an event. An occurrence id removes just that occurrence — ' +
        'which iCalendar does by adding an exception date to the series, so ' +
        'the rest of the series is untouched. A series id removes the whole ' +
        'entry. A CalDAV server keeps no history: this cannot be undone.',
      inputSchema: z.object({
        id: entityIdParam,
        scope: scopeParam,
        confirm_token: confirmTokenParam,
      }),
      annotations: DELETE,
      outputSchema: z.object({
        deleted: z.literal(true),
        id: z.string(),
        scope: z.enum(['this_occurrence', 'entire_series']),
      }),
    },
    async (args, mcp) =>
      run(async () => {
        const registry = await context.discovery.registry();
        const entity = parseEntityId(args.id, 'vevent', registry);
        const scope = resolveScope(entity, args.scope);

        const outcome = await approval.requestApproval(
          server,
          mcp,
          confirmations,
          {
            what:
              scope === 'entire_series'
                ? 'delete a whole recurring event and every one of its occurrences'
                : 'delete one occurrence of an event',
            consequence:
              'A CalDAV server keeps no version history. Once it is gone ' +
              'there is nothing to restore it from.',
            resourceKey: setResourceKey(`delete_event:${scope}`, [
              entity.calendarPath,
              entity.resourceName,
              entity.recurrenceId ?? '',
            ]),
            token: args.confirm_token,
            toolName: 'delete_event',
            title: 'Delete this?',
            hint: 'Tick to delete it, leave it to cancel.',
            details: [
              {
                label: 'Calendar',
                value: escapeInvisible(entity.calendarPath),
              },
            ],
          }
        );
        if (outcome.decision === 'rejected') return errorResult(outcome.reason);
        if (outcome.decision === 'declined') {
          return errorResult(
            'The user declined. delete_event deleted nothing.'
          );
        }
        if (outcome.decision === 'pending') return outcome.result;

        if (scope === 'entire_series' || entity.recurrenceId === undefined) {
          const calendar = registry.byPath(entity.calendarPath);
          if (calendar === undefined) {
            throw new ToolInputError(
              'caldav-mcp: that calendar is no longer available.'
            );
          }
          const url = `${calendar.url}${entity.resourceName}`;
          const resource = await context.api.get(url);
          if (resource.etag === undefined) {
            throw new ToolInputError(
              'caldav-mcp: the server did not return a strong ETag for this ' +
                'entry, so the deletion cannot be protected against a ' +
                'simultaneous change. Nothing was deleted.'
            );
          }
          await context.api.del(url, resource.etag);
        } else {
          await excludeOccurrence(context, entity);
        }

        return ownWordsResult({ deleted: true, id: args.id, scope });
      })
  );

  server.registerTool(
    'move_event',
    {
      title: 'Move an event to another calendar',
      description:
        'Copies an event into another calendar and removes it from the first. ' +
        'The content survives, the address does not: every id that named this ' +
        'event stops working, and a listing is needed to get the new one. ' +
        'The destination may be a calendar other people can see.',
      inputSchema: z.object({
        id: entityIdParam,
        destination_calendar_id: calendarRefParam,
        confirm_token: confirmTokenParam,
      }),
      annotations: MOVE,
      outputSchema: z.object({
        moved: z.literal(true),
        id: z
          .string()
          .describe('The new id. The one passed in is now invalid.'),
        from: z.string(),
        to: z.string(),
      }),
    },
    async (args, mcp) =>
      run(async () => {
        const registry = await context.discovery.registry();
        const entity = parseEntityId(args.id, 'vevent', registry);
        const destination = registry.resolve(args.destination_calendar_id);
        if (destination.path === entity.calendarPath) {
          throw new ToolInputError(
            'caldav-mcp: the event is already in that calendar.'
          );
        }
        if (entity.recurrenceId !== undefined) {
          throw new ToolInputError(
            'caldav-mcp: a single occurrence cannot be moved to another ' +
              'calendar on its own — it is part of one stored entry. Pass the ' +
              'series id to move the whole event.'
          );
        }

        const outcome = await approval.requestApproval(
          server,
          mcp,
          confirmations,
          {
            what: 'move an event into a different calendar',
            consequence:
              'The event is written to the destination and deleted from the ' +
              'source. Its id changes, and if the destination is shared, ' +
              'other people can see it from then on.',
            resourceKey: setResourceKey('move_event', [
              entity.calendarPath,
              destination.path,
              entity.resourceName,
            ]),
            token: args.confirm_token,
            toolName: 'move_event',
            title: 'Move this event?',
            hint: 'Tick to move it, leave it to cancel.',
            details: [
              { label: 'From', value: escapeInvisible(entity.calendarPath) },
              { label: 'To', value: escapeInvisible(destination.path) },
            ],
          }
        );
        if (outcome.decision === 'rejected') return errorResult(outcome.reason);
        if (outcome.decision === 'declined') {
          return errorResult('The user declined. move_event moved nothing.');
        }
        if (outcome.decision === 'pending') return outcome.result;

        const source = registry.byPath(entity.calendarPath);
        if (source === undefined) {
          throw new ToolInputError(
            'caldav-mcp: that calendar is no longer available.'
          );
        }
        const sourceUrl = `${source.url}${entity.resourceName}`;
        const resource = await context.api.get(sourceUrl, true);
        if (resource.etag === undefined) {
          throw new ToolInputError(
            'caldav-mcp: the server did not return a strong ETag for this ' +
              'entry, so the move cannot be protected against a simultaneous ' +
              'change. Nothing was moved.'
          );
        }

        // Write first, delete second. The other order can lose the event
        // entirely if the write then fails; this order can at worst leave a
        // copy behind, which is visible and fixable.
        const targetUrl = `${destination.url}${entity.resourceName}`;
        await context.api.put(targetUrl, resource.ics, { create: true });
        await context.api.del(sourceUrl, resource.etag);

        return ownWordsResult({
          moved: true,
          id: buildSeriesId('vevent', destination.path, entity.resourceName),
          from: entity.calendarPath,
          to: destination.path,
        });
      })
  );

  server.registerTool(
    'respond_to_event',
    {
      title: 'Accept or decline an invitation',
      description:
        'Sets your own participation status on an event you were invited to. ' +
        'On a server with scheduling enabled this sends a reply to the ' +
        'organiser, which cannot be unsent — so it asks first. It changes only ' +
        'your own attendee line and never anybody else’s. This server cannot ' +
        'add or remove attendees at all.',
      inputSchema: z.object({
        id: entityIdParam,
        response: z
          .enum(['ACCEPTED', 'DECLINED', 'TENTATIVE'])
          .describe('Your answer.'),
        confirm_token: confirmTokenParam,
      }),
      annotations: SET_STATE,
      outputSchema: z.object({
        responded: z.literal(true),
        id: z.string(),
        response: z.enum(['ACCEPTED', 'DECLINED', 'TENTATIVE']),
        attendee: z.string(),
        scheduling: z
          .boolean()
          .describe(
            'Whether the server advertises scheduling, i.e. whether a reply ' +
              'was sent to the organiser.'
          ),
      }),
    },
    async (args, mcp) =>
      run(async () => {
        const registry = await context.discovery.registry();
        const entity = parseEntityId(args.id, 'vevent', registry);
        const principal = await context.discovery.principal();
        const addresses =
          context.config.userEmail === undefined
            ? principal.addresses
            : [context.config.userEmail, ...principal.addresses];
        if (addresses.length === 0) {
          throw new ToolInputError(
            'caldav-mcp: this server cannot tell which attendee is you, so it ' +
              'will not guess. Set CALDAV_USER_EMAIL to the address you are ' +
              'invited as. (Some servers, Radicale among them, report a path ' +
              'rather than an address for the account, which cannot be matched ' +
              'against an attendee line.)'
          );
        }

        const options = await context.api.options(`${context.api.url}/`);
        const scheduling = options.dav.some(
          (token) =>
            token.includes('calendar-auto-schedule') ||
            token.includes('calendar-schedule')
        );

        const outcome = await approval.requestApproval(
          server,
          mcp,
          confirmations,
          {
            what: `answer an invitation with "${args.response.toLowerCase()}"`,
            consequence: scheduling
              ? 'This server advertises scheduling, so a reply will be emailed ' +
                'to the organiser. Mail that has been sent cannot be recalled.'
              : 'The answer is stored on the calendar. This server does not ' +
                'advertise scheduling, so no mail is sent.',
            resourceKey: setResourceKey('respond_to_event', [
              entity.calendarPath,
              entity.resourceName,
              entity.recurrenceId ?? '',
              args.response,
            ]),
            token: args.confirm_token,
            toolName: 'respond_to_event',
            title: 'Send this answer?',
            hint: 'Tick to answer, leave it to cancel.',
          }
        );
        if (outcome.decision === 'rejected') return errorResult(outcome.reason);
        if (outcome.decision === 'declined') {
          return errorResult(
            'The user declined. respond_to_event answered nothing.'
          );
        }
        if (outcome.decision === 'pending') return outcome.result;

        const scope = resolveScope(entity, undefined);
        const loaded = await loadForWrite(context, entity, scope);
        const mine = findSelfAttendee(loaded.target, addresses);
        if (mine === undefined) {
          throw new ToolInputError(
            'caldav-mcp: none of the attendees on this event matches the ' +
              `address${addresses.length === 1 ? '' : 'es'} this server knows ` +
              `you by (${addresses.join(', ')}). It will not guess which one ` +
              'is yours.'
          );
        }
        mine.setParameter('partstat', args.response);
        mine.setParameter('rsvp', 'FALSE');

        await commit(context, loaded, (component) => ({
          summary: readText(component, 'summary') ?? '(no title)',
        }));

        return ownWordsResult({
          responded: true,
          id: args.id,
          response: args.response,
          attendee: String(mine.getFirstValue() ?? '').replace(/^mailto:/i, ''),
          scheduling,
        });
      })
  );
}

/** Which part of a recurring entry a write applies to. */
function resolveScope(entity: EntityId, requested: Scope | undefined): Scope {
  if (requested !== undefined) return requested;
  return entity.recurrenceId === undefined
    ? 'entire_series'
    : 'this_occurrence';
}

function nothingToDo(args: Record<string, unknown>): boolean {
  const fields = [
    'summary',
    'start',
    'end',
    'description',
    'location',
    'categories',
    'status',
    'transparent',
    'alarms',
  ];
  return fields.every((field) => args[field] === undefined);
}

/** The end of a new event, defaulted from its start. */
function resolveEnd(
  args: { end?: string | undefined; timezone?: string | undefined },
  start: { instant: Date; allDay: boolean; zone: string | undefined },
  fallbackZone: string
): { instant: Date; allDay: boolean; zone: string | undefined } {
  if (args.end !== undefined) {
    const end = parseInstant(args.end, 'end', fallbackZone, args.timezone);
    if (end.instant.getTime() <= start.instant.getTime()) {
      throw new ToolInputError(
        'caldav-mcp: the end has to be after the start. For an all-day event ' +
          'the end is exclusive, so a single day on 2026-09-07 ends on ' +
          '2026-09-08.'
      );
    }
    return end;
  }
  const span = start.allDay ? 24 * 60 * 60 * 1000 : 60 * 60 * 1000;
  return {
    instant: new Date(start.instant.getTime() + span),
    allDay: start.allDay,
    zone: start.zone,
  };
}

function applyTimes(
  component: ICAL.Component,
  args: {
    start?: string | undefined;
    end?: string | undefined;
    timezone?: string | undefined;
  },
  fallbackZone: string
): void {
  if (args.start === undefined || args.end === undefined) {
    throw new ToolInputError(
      'caldav-mcp: pass both start and end when changing the time. Moving one ' +
        'end of an event on its own is how a meeting silently becomes eight ' +
        'hours long.'
    );
  }
  const start = parseInstant(args.start, 'start', fallbackZone, args.timezone);
  const end = resolveEnd(args, start, fallbackZone);
  writeTime(component, 'dtstart', {
    instant: start.instant,
    zone: start.zone,
    allDay: start.allDay,
  });
  writeTime(component, 'dtend', {
    instant: end.instant,
    zone: end.zone,
    allDay: end.allDay,
  });
}

/** Sets an RRULE from its raw text, refusing anything ical.js cannot read. */
function setRecurrence(component: ICAL.Component, rule: string): void {
  const text = rule.trim().replace(/^RRULE:/i, '');
  let recur: ICAL.Recur;
  try {
    recur = ICAL.Recur.fromString(text);
  } catch {
    throw new ToolInputError(
      `caldav-mcp: "${rule}" is not a recurrence rule this server can read. ` +
        'Expected an RFC 5545 RRULE value, e.g. "FREQ=WEEKLY;BYDAY=MO;COUNT=10".'
    );
  }
  const property = new ICAL.Property('rrule', component);
  property.setValue(recur);
  component.addProperty(property);
}

/**
 * Deletes one occurrence by excluding it from the series.
 *
 * That is what deleting an instance means in iCalendar: an EXDATE on the
 * master. The list is de-duplicated because Radicale will happily store the
 * same exception twice, and a second delete of the same occurrence should be a
 * no-op rather than a growing file.
 */
async function excludeOccurrence(
  context: ToolContext,
  entity: EntityId
): Promise<void> {
  const registry = await context.discovery.registry();
  const calendar = registry.byPath(entity.calendarPath);
  if (calendar === undefined) {
    throw new ToolInputError(
      'caldav-mcp: that calendar is no longer available.'
    );
  }
  const url = `${calendar.url}${entity.resourceName}`;
  const resource = await context.api.get(url, true);
  if (resource.etag === undefined) {
    throw new ToolInputError(
      'caldav-mcp: the server did not return a strong ETag for this entry, so ' +
        'the change cannot be protected against a simultaneous write. Nothing ' +
        'was deleted.'
    );
  }
  const root = parseCalendar(resource.ics, `the entry ${entity.resourceName}`);
  const { master, overrides } = splitSeries(componentsOf(root, entity.kind));
  if (master === undefined) {
    throw new ToolInputError(
      'caldav-mcp: this entry has no series to exclude an occurrence from.'
    );
  }
  const at = parseRecurrenceId(
    entity.recurrenceId ?? '',
    context.config.timezone
  );

  // An override for this instance is removed as well, or the exception would
  // leave a component behind that still claims the occurrence exists.
  for (const override of overrides) {
    const property = override.getFirstProperty('recurrence-id');
    if (property === null) continue;
    const value = property.getFirstValue() as ICAL.Time;
    if (Math.abs(value.toJSDate().getTime() - at.instant.getTime()) < 1000) {
      root.removeSubcomponent(override);
    }
  }

  const existing = master
    .getAllProperties('exdate')
    .flatMap((property) => property.getValues())
    .map((value) => (value as ICAL.Time).toString());

  const exdate = new ICAL.Property('exdate', master);
  const value = at.allDay
    ? ICAL.Time.fromData({
        year: at.instant.getUTCFullYear(),
        month: at.instant.getUTCMonth() + 1,
        day: at.instant.getUTCDate(),
        isDate: true,
      })
    : ICAL.Time.fromJSDate(at.instant, true);
  if (existing.includes(value.toString())) return;
  exdate.setValue(value);
  master.addProperty(exdate);

  await context.api.put(url, serialize(root), { ifMatch: resource.etag });
}

/** The ATTENDEE line matching one of the addresses this account answers as. */
function findSelfAttendee(
  component: ICAL.Component,
  addresses: readonly string[]
): ICAL.Property | undefined {
  const wanted = new Set(addresses.map((address) => address.toLowerCase()));
  const matches = component.getAllProperties('attendee').filter((property) => {
    const value = String(property.getFirstValue() ?? '');
    return wanted.has(value.replace(/^mailto:/i, '').toLowerCase());
  });
  // Exactly one, or none. Two attendee lines for the same person is a broken
  // entry, and picking one of them would be a guess.
  return matches.length === 1 ? matches[0] : undefined;
}
