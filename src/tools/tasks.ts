import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/server';
import {
  setResourceKey,
  type Approver,
  type ConfirmationStore,
} from 'mcp-approval';

import { escapeInvisible } from '../analyze.js';
import { listEntries, type ToolContext } from '../entries.js';
import { buildSeriesId, parseEntityId } from '../entity-id.js';
import { ToolInputError } from '../errors.js';
import { ICAL, readText, writeTime } from '../ical.js';
import {
  notes,
  shapedTask,
  truncated,
  untrustedFields,
} from '../output-schema.js';
import {
  errorResult,
  fencedUntrustedResult,
  ownWordsResult,
  run,
  untrustedResult,
} from '../result.js';
import {
  afterParam,
  alarmsParam,
  calendarRefParam,
  calendarsParam,
  categoriesParam,
  confirmTokenParam,
  entityIdParam,
  instantParam,
  limitParam,
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
} from '../write.js';
import {
  CREATE,
  DELETE,
  READ_ONLY,
  REPLACE,
  SET_STATE,
} from './annotations.js';
import { loadEntry, resolveWindow } from './common.js';

/**
 * VTODO: tasks.
 *
 * Kept as its own tool set rather than folded into the event tools with a
 * `component` parameter. A task is a different shape — it has a due date and a
 * completion state where an event has a start and an end — and a schema that
 * has to describe both ends up with every field optional, which tells a model
 * nothing about what it may send.
 */
export function registerTaskReadTools(
  server: McpServer,
  context: ToolContext
): void {
  server.registerTool(
    'list_tasks',
    {
      title: 'List tasks',
      description:
        'Tasks with a start or due date inside a time range. Tasks with no ' +
        'date at all are not returned by a time-range query — the CalDAV ' +
        'specification defines the filter against the dates, and a task with ' +
        'none of them matches no window.',
      inputSchema: z.object({
        from: instantParam.optional(),
        to: instantParam.optional(),
        timezone: timezoneParam,
        calendars: calendarsParam,
        include_completed: z
          .boolean()
          .optional()
          .describe('Defaults to false, which leaves completed tasks out.'),
        limit: limitParam,
        after: afterParam,
      }),
      annotations: READ_ONLY,
      outputSchema: z.object({
        ...untrustedFields,
        tasks: z.array(shapedTask),
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
          kind: 'vtodo',
          calendars: registry.resolveMany(args.calendars),
          from: window.from,
          to: window.to,
          limit: args.limit ?? context.config.maxEntries,
          after: args.after,
        });
        const entries =
          args.include_completed === true
            ? listing.entries
            : listing.entries.filter(
                (entry) =>
                  String(entry.status ?? '').toUpperCase() !== 'COMPLETED'
              );
        return untrustedResult({
          tasks: entries,
          count: entries.length,
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
    'get_task',
    {
      title: 'Read one task in full',
      description:
        'The complete task behind an id from list_tasks, with its untruncated ' +
        'description and every reminder.',
      inputSchema: z.object({ id: entityIdParam }),
      annotations: READ_ONLY,
      outputSchema: z.object({
        ...untrustedFields,
        task: shapedTask,
        notes,
      }),
    },
    async ({ id }) =>
      run(async () => {
        const registry = await context.discovery.registry();
        const entity = parseEntityId(id, 'vtodo', registry);
        const loaded = await loadEntry(context, entity, registry);
        return fencedUntrustedResult(
          {
            task: loaded.shaped.entry,
            ...(loaded.notes.length > 0 ? { notes: loaded.notes } : {}),
          },
          loaded.shaped.fenced,
          loaded.shaped.warnings
        );
      })
  );
}

export function registerTaskWriteTools(
  server: McpServer,
  context: ToolContext,
  confirmations: ConfirmationStore,
  approval: Approver
): void {
  server.registerTool(
    'create_task',
    {
      title: 'Create a task',
      description:
        'Adds a task to a calendar that accepts them. list_calendars reports ' +
        'which do — a collection created for events only will refuse a task, ' +
        'and this server checks before writing rather than passing the ' +
        'server’s refusal back.',
      inputSchema: z.object({
        calendar_id: calendarRefParam,
        summary: z.string().trim().min(1).max(1000),
        due: instantParam.optional().describe('When it is due.'),
        start: instantParam.optional().describe('When work on it can begin.'),
        timezone: timezoneParam,
        description: textParam('Longer text.'),
        priority: z
          .number()
          .int()
          .min(0)
          .max(9)
          .optional()
          .describe(
            '1 is highest, 9 lowest, 0 undefined — as RFC 5545 has it.'
          ),
        categories: categoriesParam,
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
        const created = await createEntry(
          context,
          calendar,
          'vtodo',
          (component) => {
            if (args.start !== undefined) {
              const start = parseInstant(
                args.start,
                'start',
                context.config.timezone,
                args.timezone
              );
              writeTime(component, 'dtstart', {
                instant: start.instant,
                zone: start.allDay ? undefined : start.zone,
                allDay: start.allDay,
              });
            }
            if (args.due !== undefined) {
              const due = parseInstant(
                args.due,
                'due',
                context.config.timezone,
                args.timezone
              );
              writeTime(component, 'due', {
                instant: due.instant,
                zone: due.allDay ? undefined : due.zone,
                allDay: due.allDay,
              });
            }
            applyCommonFields(component, {
              summary: args.summary,
              description: args.description,
              categories: args.categories,
            });
            if (args.priority !== undefined) {
              component.updatePropertyWithValue('priority', args.priority);
            }
            applyAlarms(component, args.alarms, context.config.timezone);
          }
        );
        return ownWordsResult({
          created: true,
          id: buildSeriesId('vtodo', calendar.path, created.resourceName),
          uid: created.uid,
          calendar: calendar.path,
          ...(created.etag === undefined ? {} : { etag: created.etag }),
        });
      })
  );

  server.registerTool(
    'update_task',
    {
      title: 'Change a task',
      description:
        'Changes the fields named and leaves everything else as it was. Pass ' +
        'null to clear a field. Guarded by the entry’s ETag. To mark a task ' +
        'done use complete_task, which records the completion time as well.',
      inputSchema: z.object({
        id: entityIdParam,
        summary: z.string().trim().min(1).max(1000).optional(),
        due: instantParam.optional(),
        start: instantParam.optional(),
        timezone: timezoneParam,
        description: textParam('Longer text.'),
        priority: z.number().int().min(0).max(9).optional(),
        percent_complete: z.number().int().min(0).max(100).optional(),
        categories: categoriesParam,
        alarms: alarmsParam,
      }),
      annotations: REPLACE,
      outputSchema: z.object({
        ...untrustedFields,
        written: z.literal(true),
        id: z.string(),
        etag: z.string().optional(),
        alarms_preserved: z.number().int().optional(),
        task: shapedTask,
        notes,
      }),
    },
    async (args) =>
      run(async () => {
        const registry = await context.discovery.registry();
        const entity = parseEntityId(args.id, 'vtodo', registry);
        const loaded = await loadForWrite(context, entity, 'entire_series');
        const target = loaded.target;

        if (args.start !== undefined) {
          const start = parseInstant(
            args.start,
            'start',
            context.config.timezone,
            args.timezone
          );
          writeTime(target, 'dtstart', {
            instant: start.instant,
            zone: start.allDay ? undefined : start.zone,
            allDay: start.allDay,
          });
        }
        if (args.due !== undefined) {
          const due = parseInstant(
            args.due,
            'due',
            context.config.timezone,
            args.timezone
          );
          writeTime(target, 'due', {
            instant: due.instant,
            zone: due.allDay ? undefined : due.zone,
            allDay: due.allDay,
          });
        }
        applyCommonFields(target, {
          summary: args.summary,
          description: args.description,
          categories: args.categories,
        });
        if (args.priority !== undefined) {
          target.updatePropertyWithValue('priority', args.priority);
        }
        if (args.percent_complete !== undefined) {
          target.updatePropertyWithValue(
            'percent-complete',
            args.percent_complete
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
          ...(result.etag === undefined ? {} : { etag: result.etag }),
          ...(preserved > 0 ? { alarms_preserved: preserved } : {}),
          task: fresh.shaped.entry,
          ...(fresh.notes.length > 0 ? { notes: fresh.notes } : {}),
        });
      })
  );

  server.registerTool(
    'complete_task',
    {
      title: 'Mark a task done, or reopen it',
      description:
        'Sets the task’s status. Marking it done records the completion time ' +
        'and sets it to 100 %; reopening clears both. The previous state is ' +
        'written down in the entry, so this is reversible — which is why it ' +
        'does not ask first.',
      inputSchema: z.object({
        id: entityIdParam,
        done: z
          .boolean()
          .optional()
          .describe('Defaults to true. Pass false to reopen a completed task.'),
      }),
      annotations: SET_STATE,
      outputSchema: z.object({
        ...untrustedFields,
        id: z.string(),
        status: z.string(),
        completed: z.string().optional().describe('ISO 8601.'),
        task: shapedTask,
      }),
    },
    async (args) =>
      run(async () => {
        const registry = await context.discovery.registry();
        const entity = parseEntityId(args.id, 'vtodo', registry);
        const loaded = await loadForWrite(context, entity, 'entire_series');
        const target = loaded.target;
        const done = args.done ?? true;

        if (done) {
          const now = new Date();
          target.updatePropertyWithValue('status', 'COMPLETED');
          target.updatePropertyWithValue('percent-complete', 100);
          target.updatePropertyWithValue(
            'completed',
            ICAL.Time.fromJSDate(now, true)
          );
        } else {
          target.updatePropertyWithValue('status', 'NEEDS-ACTION');
          target.removeAllProperties('completed');
          target.updatePropertyWithValue('percent-complete', 0);
        }

        await commit(context, loaded, (component) => ({
          summary: readText(component, 'summary') ?? '(no title)',
        }));
        const fresh = await loadEntry(context, entity, registry);
        return untrustedResult({
          id: args.id,
          status: done ? 'COMPLETED' : 'NEEDS-ACTION',
          ...(done ? { completed: new Date().toISOString() } : {}),
          task: fresh.shaped.entry,
        });
      })
  );

  server.registerTool(
    'delete_task',
    {
      title: 'Delete a task',
      description:
        'Removes a task. A CalDAV server keeps no history: this cannot be ' +
        'undone. To mark a task done instead, use complete_task.',
      inputSchema: z.object({
        id: entityIdParam,
        confirm_token: confirmTokenParam,
      }),
      annotations: DELETE,
      outputSchema: z.object({ deleted: z.literal(true), id: z.string() }),
    },
    async (args, mcp) =>
      run(async () => {
        const registry = await context.discovery.registry();
        const entity = parseEntityId(args.id, 'vtodo', registry);

        const outcome = await approval.requestApproval(
          server,
          mcp,
          confirmations,
          {
            what: 'delete a task',
            consequence:
              'A CalDAV server keeps no version history. Once it is gone ' +
              'there is nothing to restore it from. If the task is finished ' +
              'rather than unwanted, complete_task keeps it and marks it done.',
            resourceKey: setResourceKey('delete_task', [
              entity.calendarPath,
              entity.resourceName,
            ]),
            token: args.confirm_token,
            toolName: 'delete_task',
            title: 'Delete this task?',
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
          return errorResult('The user declined. delete_task deleted nothing.');
        }
        if (outcome.decision === 'pending') return outcome.result;

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
              'task, so the deletion cannot be protected against a ' +
              'simultaneous change. Nothing was deleted.'
          );
        }
        await context.api.del(url, resource.etag);
        return ownWordsResult({ deleted: true, id: args.id });
      })
  );
}
