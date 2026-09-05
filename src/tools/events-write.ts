import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/server';
import {
  setResourceKey,
  type Approver,
  type ConfirmationStore,
} from 'mcp-approval';

import { escapeInvisible, quoted } from '../analyze.js';
import { resourceUrl, type CalendarRegistry } from '../calendars.js';
import type { ToolContext } from '../entries.js';
import { buildSeriesId, parseEntityId, type EntityId } from '../entity-id.js';
import { ToolInputError } from '../errors.js';
import {
  ICAL,
  componentsOf,
  parseCalendar,
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
import {
  expandSeries,
  instantOfProperty,
  instantsOfProperty,
  parseRecurrenceId,
} from '../recurrence.js';
import {
  alarmsParam,
  calendarRefParam,
  categoriesParam,
  confirmTokenParam,
  entityIdParam,
  instantParam,
  scopeParam,
  summaryParam,
  textParam,
  timezoneParam,
} from '../schema.js';
import { formatDateInZone, parseInstant } from '../time.js';
import {
  applyAlarms,
  applyCommonFields,
  commit,
  createEntry,
  loadForWrite,
  type LoadedEntry,
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
 *   entry** — whichever id was passed. Gating every edit is how an operator
 *   ends up switching `ELICITATION` off altogether, and then nothing asks at
 *   all. The ETag is what guards the ordinary edit; the dialog is for the one
 *   edit that reaches beyond a single instance. Whether the entry recurs is
 *   read from the stored resource, not inferred from the shape of the id: a
 *   listing hands out the series id next to every occurrence id, and a change
 *   made through it touches every occurrence just the same.
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
        summary: summaryParam,
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

        // No cache to drop here, and that is worth stating rather than
        // leaving as an absence. The discovery cache holds the *list of
        // calendars*, and writing an entry does not change it — the tool that
        // reports the list asks for a fresh one anyway. An `invalidate()` call
        // sat here doing nothing, which is worse than none: it reads as a
        // freshness guarantee that the other eleven write tools are missing.
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
        summary: summaryParam.optional(),
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

        // Read before asking: whether this edit reaches every occurrence is a
        // fact about the stored entry, not about the id. The GET is not the
        // destructive act, and the ETag it returns guards the write below
        // against anything that changes while the person is deciding.
        const loaded = await loadForWrite(context, entity, scope);

        // Only the edit that reaches past a single instance asks. See the
        // note at the top of this file.
        if (scope === 'entire_series' && recurs(loaded)) {
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
              // The change itself is part of the key. An approval is a person
              // saying yes to *this* edit of *this* series; without the fields
              // in the key, one yes would cover any other edit of the same
              // series for as long as the approval lives. A retry with the
              // same arguments — after a 412, say — still matches.
              resourceKey: setResourceKey('update_event:series', [
                entity.calendarPath,
                entity.resourceName,
                changeDigest(args),
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

        const result = await commit(context, loaded);

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

        // Read before asking. A GET is not the destructive act, and the
        // sentence a person is deciding on has to describe the actual entry:
        // "a whole recurring event and every one of its occurrences" about a
        // single lunch is worse than saying nothing, because it reads as a
        // description and is not one. The counts are server-side facts, which
        // is the only kind of detail that belongs in this text.
        const shape = await describeTarget(
          context,
          entity,
          registry,
          Date.now() + 5_000
        );

        const outcome = await approval.requestApproval(
          server,
          mcp,
          confirmations,
          {
            what: deletionSentence(scope, shape),
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
          const url = resourceUrl(calendar, entity.resourceName);
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

        // The checks `createEntry` makes for a new entry, made here for the
        // copy — and made *before* the dialog, which is the whole point of
        // making them at all. A destination the account cannot write to, or
        // one that takes no events, is answered with a sentence instead of
        // asking somebody to approve a move that was never going to happen
        // and then spending their approval on the server's 403.
        if (destination.readOnly) {
          throw new ToolInputError(
            `caldav-mcp: the account can read ${destination.path} but not ` +
              'write to it, so the event cannot be moved there.'
          );
        }
        if (!registry.accepts(destination, 'VEVENT')) {
          throw new ToolInputError(
            `caldav-mcp: ${destination.path} does not accept VEVENT entries. ` +
              `It takes: ${destination.components.join(', ')}.`
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
        const sourceUrl = resourceUrl(source, entity.resourceName);
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
        const targetUrl = resourceUrl(destination, entity.resourceName);
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

        // As an attendee, not as the organiser: the SEQUENCE stays where the
        // organiser put it. See `touch` in src/ical.ts.
        await commit(context, loaded, { bumpSequence: false });

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

/** What the target actually is, for a sentence a person can act on. */
interface TargetShape {
  recurring: boolean;
  occurrences: number | undefined;
  /** True when the entry could not be read, so nothing above is known. */
  unreadable: boolean;
}

/**
 * Looks at the entry a deletion would remove.
 *
 * Deliberately tolerant: if the read fails the dialog still happens. But it
 * happens with wording that *says* the entry could not be read, not with the
 * wording for a single event — a 500-occurrence series behind a broken read
 * must not be described as "an event" to the person deciding. The read uses
 * the write-path ceiling, since the deletion is a write and an entry too large
 * to read under the smaller ceiling would otherwise always take this path.
 */
async function describeTarget(
  context: ToolContext,
  entity: EntityId,
  registry: CalendarRegistry,
  deadline: number
): Promise<TargetShape> {
  const unknown: TargetShape = {
    recurring: false,
    occurrences: undefined,
    unreadable: true,
  };
  try {
    const calendar = registry.byPath(entity.calendarPath);
    if (calendar === undefined) return unknown;
    const resource = await context.api.get(
      resourceUrl(calendar, entity.resourceName),
      true
    );
    const root = parseCalendar(resource.ics, 'the entry');
    const components = componentsOf(root, entity.kind);
    const { master, overrides } = splitSeries(components);
    // Two shapes hold more than one occurrence, and the dialog has to name
    // both. The obvious one is a master carrying a rule. The other is a
    // resource made *only* of detached occurrences, which is what a client
    // writes after a "this and following" split and what `expandSeries`
    // already handles in its standalone branch — there is no master at all,
    // so reading the rule off `master` reported "an event" and then deleted a
    // file holding N of them. Same contradiction as the series/occurrence
    // one, one shape further out.
    const recurring =
      master === undefined
        ? overrides.length > 1
        : master.getFirstProperty('rrule') !== null ||
          master.getFirstProperty('rdate') !== null;
    if (!recurring) {
      return { recurring: false, occurrences: undefined, unreadable: false };
    }
    const expansion = expandSeries(components, {
      from: new Date(-8_640_000_000_000),
      to: new Date(8_640_000_000_000),
      cap: 500,
      fallbackZone: context.config.timezone,
      // Shared with the rest of the call rather than minted here. Without it
      // this expansion starts its own full wall-clock budget, so describing
      // the target for the dialog could cost as much time again as the work
      // it describes — twice over on the two-call fallback path, on an entry
      // somebody else wrote. A count for a dialog is worth a second, not a
      // second budget.
      deadline,
    });
    return {
      recurring: true,
      occurrences: expansion.truncated
        ? undefined
        : expansion.occurrences.length,
      unreadable: false,
    };
  } catch {
    return unknown;
  }
}

/** The sentence the dialog leads with, describing what is really there. */
function deletionSentence(scope: Scope, shape: TargetShape): string {
  if (shape.unreadable) {
    return (
      'delete an entry this server could not read to describe — it may be ' +
      'a single event or a whole recurring series'
    );
  }
  if (!shape.recurring) return 'delete an event';
  if (scope === 'this_occurrence') {
    return 'delete one occurrence of a recurring event, leaving the rest of the series';
  }
  return shape.occurrences === undefined
    ? 'delete a recurring event and every one of its occurrences'
    : `delete a recurring event and all ${shape.occurrences} of its occurrences`;
}

/**
 * Which part of a recurring entry a write applies to.
 *
 * A series id names the stored entry as a whole; only an occurrence id can
 * name one instance. `this_occurrence` on a series id is therefore refused
 * rather than passed through — it used to be, and `delete_event` then showed
 * a dialog reading "delete one occurrence, leaving the rest of the series"
 * and removed the entire resource. The two arguments contradict each other,
 * and the answer to a contradiction is a refusal, not a guess.
 */
function resolveScope(entity: EntityId, requested: Scope | undefined): Scope {
  if (entity.recurrenceId === undefined) {
    if (requested === 'this_occurrence') {
      throw new ToolInputError(
        'caldav-mcp: scope "this_occurrence" needs the id of one occurrence, ' +
          'and this id names the whole series. list_events returns an id ' +
          'for each occurrence next to the series id.'
      );
    }
    return 'entire_series';
  }
  return requested ?? 'this_occurrence';
}

/** Whether the stored entry recurs, read from the master component. */
function recurs(loaded: LoadedEntry): boolean {
  const series = loaded.master ?? loaded.target;
  return (
    series.getFirstProperty('rrule') !== null ||
    series.getFirstProperty('rdate') !== null
  );
}

/** The change an `update_event` call asks for, as a stable string. */
function changeDigest(args: Record<string, unknown>): string {
  const fields = [
    'scope',
    'summary',
    'start',
    'end',
    'timezone',
    'description',
    'location',
    'categories',
    'status',
    'transparent',
    'alarms',
  ];
  // `absent` and `null` are opposite instructions, so they must not digest to
  // the same thing. The schema says it outright — "pass null to remove it,
  // leave it out to keep it" — and mapping a missing field onto `null` made
  // "change the summary" and "change the summary AND clear the description,
  // the location and every category" produce one key. An approval for the
  // first then executed the second: a yes to a small edit spending itself on
  // a strictly larger one, against a server that keeps no history.
  return JSON.stringify(
    fields.map((field) =>
      args[field] === undefined
        ? [field, 'absent']
        : [field, 'set', args[field]]
    )
  );
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

/**
 * Sets an RRULE from its raw text, refusing anything that is not one.
 *
 * The `freq` check is not belt and braces. `ICAL.Recur.fromString` is lenient:
 * handed prose it does not throw, it returns a rule whose frequency is null and
 * serialises as `FREQ=null` — which this server would then write into a real
 * calendar, where every other client has to deal with it. Only a rule naming a
 * frequency is a rule.
 */
function setRecurrence(component: ICAL.Component, rule: string): void {
  const text = rule.trim().replace(/^RRULE:/i, '');
  let recur: ICAL.Recur;
  try {
    recur = ICAL.Recur.fromString(text);
  } catch {
    throw new ToolInputError(
      `caldav-mcp: "${quoted(rule)}" is not a recurrence rule this server can ` +
        'read. Expected an RFC 5545 RRULE value, e.g. ' +
        '"FREQ=WEEKLY;BYDAY=MO;COUNT=10".'
    );
  }
  if (
    recur.freq === null ||
    recur.freq === undefined ||
    String(recur.freq).length === 0
  ) {
    throw new ToolInputError(
      `caldav-mcp: "${quoted(rule)}" names no frequency, so it is not a recurrence ` +
        'rule. Expected an RFC 5545 RRULE value beginning with FREQ=, ' +
        'e.g. "FREQ=WEEKLY;BYDAY=MO;COUNT=10".'
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
 *
 * Every comparison in here is on the **instant**, through the same resolver
 * the expansion uses, and never on `toJSDate()` or on a serialised spelling.
 * Both of those were tried and both were wrong in a way that reported success:
 * `toJSDate()` applies the host's zone to a TZID-only RECURRENCE-ID, so on a
 * container in UTC the override was never matched, left behind, and re-emitted
 * by the next listing as the occurrence that had just been "deleted"; and a
 * string comparison of EXDATE values missed an existing exception written in
 * another zone. The all-day EXDATE is likewise written from the calendar date
 * the occurrence id names, in the configured zone — reading UTC fields off a
 * midnight-in-Berlin instant put the exception on the previous day.
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
  const url = resourceUrl(calendar, entity.resourceName);
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
  const zone = context.config.timezone;
  const at = parseRecurrenceId(entity.recurrenceId ?? '', zone);
  const wanted = at.instant.getTime();

  // An override for this instance is removed as well, or the exception would
  // leave a component behind that still claims the occurrence exists.
  let removedOverride = false;
  for (const override of overrides) {
    const property = override.getFirstProperty('recurrence-id');
    if (property === null) continue;
    const instant = instantOfProperty(property, zone).instant.getTime();
    if (Math.abs(instant - wanted) < 1000) {
      root.removeSubcomponent(override);
      removedOverride = true;
    }
  }

  const alreadyExcluded = master
    .getAllProperties('exdate')
    .flatMap((property) => instantsOfProperty(property, zone))
    .some((time) => Math.abs(time.instant.getTime() - wanted) < 1000);

  if (alreadyExcluded && !removedOverride) {
    // Nothing to write: the exception is there and no override contradicts it.
    return;
  }

  if (!alreadyExcluded) {
    const exdate = new ICAL.Property('exdate', master);
    let value: ICAL.Time;
    if (at.allDay) {
      const [year, month, day] = formatDateInZone(at.instant, zone).split('-');
      value = ICAL.Time.fromData({
        year: Number(year),
        month: Number(month),
        day: Number(day),
        isDate: true,
      });
    } else {
      value = ICAL.Time.fromJSDate(at.instant, true);
    }
    exdate.setValue(value);
    master.addProperty(exdate);
  }

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
