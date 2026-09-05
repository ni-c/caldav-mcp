import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/server';
import {
  setResourceKey,
  type Approver,
  type ConfirmationStore,
} from 'mcp-approval';

import { escapeInvisible } from '../analyze.js';
import { resourceUrl } from '../calendars.js';
import { listEntries, type ToolContext } from '../entries.js';
import { buildSeriesId, parseEntityId } from '../entity-id.js';
import { ToolInputError } from '../errors.js';
import { readText, writeTime } from '../ical.js';
import {
  notes,
  shapedJournal,
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
  applyCommonFields,
  commit,
  createEntry,
  loadForWrite,
} from '../write.js';
import { CREATE, DELETE, READ_ONLY, REPLACE } from './annotations.js';
import { loadEntry, resolveWindow } from './common.js';

/**
 * VJOURNAL: dated notes.
 *
 * A journal entry is almost nothing *but* free text somebody wrote, which makes
 * it the clearest destructive case in this server: `update_journal` replaces a
 * piece of writing that has no version behind it. There are no reminders here —
 * a note has no time to be reminded about — and no end time.
 */
export function registerJournalReadTools(
  server: McpServer,
  context: ToolContext
): void {
  server.registerTool(
    'list_journals',
    {
      title: 'List journal entries',
      description:
        'Dated notes in a calendar, inside a time range. Most calendar ' +
        'clients hide these; a CalDAV server stores them alongside events and ' +
        'tasks, and some workflows use them as a diary.',
      inputSchema: z.object({
        from: instantParam.optional(),
        to: instantParam.optional(),
        timezone: timezoneParam,
        calendars: calendarsParam,
        limit: limitParam,
        after: afterParam,
      }),
      annotations: READ_ONLY,
      outputSchema: z.object({
        ...untrustedFields,
        journals: z.array(shapedJournal),
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
          kind: 'vjournal',
          calendars: registry.resolveMany(args.calendars),
          from: window.from,
          to: window.to,
          limit: args.limit ?? context.config.maxEntries,
          after: args.after,
        });
        return untrustedResult({
          journals: listing.entries,
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
    'get_journal',
    {
      title: 'Read one journal entry in full',
      description:
        'The complete note behind an id from list_journals, untruncated. This ' +
        'is the longest piece of somebody else’s prose this server hands over, ' +
        'so the text channel carries it inside an explicit untrusted fence.',
      inputSchema: z.object({ id: entityIdParam }),
      annotations: READ_ONLY,
      outputSchema: z.object({
        ...untrustedFields,
        journal: shapedJournal,
        notes,
      }),
    },
    async ({ id }) =>
      run(async () => {
        const registry = await context.discovery.registry();
        const entity = parseEntityId(id, 'vjournal', registry);
        const loaded = await loadEntry(context, entity, registry);
        return fencedUntrustedResult(
          {
            journal: loaded.shaped.entry,
            ...(loaded.notes.length > 0 ? { notes: loaded.notes } : {}),
          },
          loaded.shaped.fenced,
          loaded.shaped.warnings
        );
      })
  );
}

export function registerJournalWriteTools(
  server: McpServer,
  context: ToolContext,
  confirmations: ConfirmationStore,
  approval: Approver
): void {
  server.registerTool(
    'create_journal',
    {
      title: 'Create a journal entry',
      description:
        'Adds a dated note to a calendar that accepts journal entries. ' +
        'list_calendars reports which do.',
      inputSchema: z.object({
        calendar_id: calendarRefParam,
        summary: z.string().trim().min(1).max(1000).describe('The heading.'),
        date: instantParam.describe('The date the note belongs to.'),
        timezone: timezoneParam,
        description: textParam('The note itself.', 100_000),
        categories: categoriesParam,
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
        const at = parseInstant(
          args.date,
          'date',
          context.config.timezone,
          args.timezone
        );
        const created = await createEntry(
          context,
          calendar,
          'vjournal',
          (component) => {
            writeTime(component, 'dtstart', {
              instant: at.instant,
              zone: at.zone,
              allDay: at.allDay,
            });
            applyCommonFields(component, {
              summary: args.summary,
              description: args.description,
              categories: args.categories,
            });
          }
        );
        return ownWordsResult({
          created: true,
          id: buildSeriesId('vjournal', calendar.path, created.resourceName),
          uid: created.uid,
          calendar: calendar.path,
          ...(created.etag === undefined ? {} : { etag: created.etag }),
        });
      })
  );

  server.registerTool(
    'update_journal',
    {
      title: 'Change a journal entry',
      description:
        'Replaces the fields named. A CalDAV server keeps no version history, ' +
        'so the previous text of a note is gone once this succeeds — pass only ' +
        'the fields to change, and pass null to clear one. Guarded by the ' +
        'entry’s ETag, so a note changed elsewhere in the meantime is not ' +
        'silently overwritten.',
      inputSchema: z.object({
        id: entityIdParam,
        summary: z.string().trim().min(1).max(1000).optional(),
        date: instantParam.optional(),
        timezone: timezoneParam,
        description: textParam('The note itself.', 100_000),
        categories: categoriesParam,
      }),
      annotations: REPLACE,
      outputSchema: z.object({
        ...untrustedFields,
        written: z.literal(true),
        id: z.string(),
        etag: z.string().optional(),
        journal: shapedJournal,
        notes,
      }),
    },
    async (args) =>
      run(async () => {
        const registry = await context.discovery.registry();
        const entity = parseEntityId(args.id, 'vjournal', registry);
        if (
          args.summary === undefined &&
          args.date === undefined &&
          args.description === undefined &&
          args.categories === undefined
        ) {
          throw new ToolInputError(
            'caldav-mcp: nothing to change — pass at least one field.'
          );
        }
        const loaded = await loadForWrite(context, entity, 'entire_series');
        if (args.date !== undefined) {
          const at = parseInstant(
            args.date,
            'date',
            context.config.timezone,
            args.timezone
          );
          writeTime(loaded.target, 'dtstart', {
            instant: at.instant,
            zone: at.zone,
            allDay: at.allDay,
          });
        }
        applyCommonFields(loaded.target, {
          summary: args.summary,
          description: args.description,
          categories: args.categories,
        });

        const result = await commit(context, loaded, (component) => ({
          summary: readText(component, 'summary') ?? '(no heading)',
        }));
        const fresh = await loadEntry(context, entity, registry);
        return untrustedResult({
          written: true,
          id: args.id,
          ...(result.etag === undefined ? {} : { etag: result.etag }),
          journal: fresh.shaped.entry,
          ...(fresh.notes.length > 0 ? { notes: fresh.notes } : {}),
        });
      })
  );

  server.registerTool(
    'delete_journal',
    {
      title: 'Delete a journal entry',
      description:
        'Removes a dated note. A CalDAV server keeps no history, and a note is ' +
        'somebody’s writing: this cannot be undone.',
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
        const entity = parseEntityId(args.id, 'vjournal', registry);

        const outcome = await approval.requestApproval(
          server,
          mcp,
          confirmations,
          {
            what: 'delete a journal entry',
            consequence:
              'A journal entry is a piece of writing, and a CalDAV server ' +
              'keeps no version history. There is nothing to restore it from.',
            resourceKey: setResourceKey('delete_journal', [
              entity.calendarPath,
              entity.resourceName,
            ]),
            token: args.confirm_token,
            toolName: 'delete_journal',
            title: 'Delete this note?',
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
            'The user declined. delete_journal deleted nothing.'
          );
        }
        if (outcome.decision === 'pending') return outcome.result;

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
              'note, so the deletion cannot be protected against a ' +
              'simultaneous change. Nothing was deleted.'
          );
        }
        await context.api.del(url, resource.etag);
        return ownWordsResult({ deleted: true, id: args.id });
      })
  );
}
