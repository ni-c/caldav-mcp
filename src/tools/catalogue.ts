/**
 * The tools this server can register, declared rather than discovered.
 *
 * Declared, because the tool filter has to answer "is this a name you have?"
 * *before* anything is registered — and under `CALDAV_READ_ONLY` the write tools
 * are never registered at all. Deriving the catalogue from what actually reached
 * `registerTool` would make `CALDAV_ALLOW_TOOLS=delete_event` report "unknown
 * tool" in read-only mode, which is the one answer that is wrong: the tool
 * exists, and read-only is suppressing it.
 *
 * This is also the full tool surface, hard-coded on purpose. A tool that appears
 * or disappears by accident is a change to this server's contract, and it has to
 * be a deliberate edit here. `test/tool-filter.test.ts` asserts that these lists
 * and the tools the server really registers are the same set — which is also why
 * that test file must not keep a second copy of the names.
 */

/** Registered always. Every one carries `readOnlyHint: true`. */
export const READ_TOOLS = [
  'get_event',
  'get_free_busy',
  'get_journal',
  'get_server_info',
  'get_task',
  'list_calendars',
  'list_events',
  'list_journals',
  'list_tasks',
  'search_events',
] as const;

/** Registered unless `CALDAV_READ_ONLY` is set. */
export const WRITE_TOOLS = [
  'complete_task',
  'create_event',
  'create_journal',
  'create_task',
  'delete_event',
  'delete_journal',
  'delete_task',
  'move_event',
  'respond_to_event',
  'update_event',
  'update_journal',
  'update_task',
] as const;

/** Every tool, read-only mode aside. */
export const ALL_TOOLS: readonly string[] = [...READ_TOOLS, ...WRITE_TOOLS];

/**
 * What `CALDAV_ALLOW_TOOLS=essential` selects: see the calendar, find the gaps,
 * put something in.
 *
 * Seven of twenty-two. Left out on purpose: everything irreversible (the three
 * deletes, moving an entry between calendars), replying to an invitation —
 * which sends mail on a scheduling server — and tasks and journals, which are a
 * different job from keeping a calendar. `get_server_info` is a diagnostic and
 * belongs in the full set rather than in the one a model reaches for first.
 *
 * "The read tools" is already `CALDAV_READ_ONLY` and would add nothing.
 */
export const ESSENTIAL_TOOLS: readonly string[] = [
  'list_calendars',
  'list_events',
  'get_event',
  'search_events',
  'get_free_busy',
  'create_event',
  'update_event',
];
