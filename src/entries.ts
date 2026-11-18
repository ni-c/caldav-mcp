import { quoted, sanitizeText } from './analyze.js';
import {
  CalDavApiError,
  ResponseTooLargeError,
  type CalDavApi,
} from './api.js';
import type { CalendarEntry } from './calendars.js';
import type { Config } from './config.js';
import {
  calendarQueryBody,
  textMatchBody,
  undatedTaskQueryBody,
  textOf,
  type SearchField,
  type TimeRange,
} from './dav-xml.js';
import type { Discovery } from './discovery.js';
import { ToolInputError } from './errors.js';
import {
  eachBounded,
  hardLimits,
  HardLimitExceeded,
  MAX_OVERRUNS,
  newOverruns,
  type Overruns,
  withHardLimit,
} from './hard-limit.js';
import { guarded } from './ical-guard.js';
import {
  COMPONENT_OF,
  componentsOf,
  parseCalendar,
  readText,
  type ICAL,
  type Kind,
} from './ical.js';
import {
  expandSeries,
  hasUnanchoredRule,
  undatedOccurrence,
  WINDOW_SLACK_MS,
  type Occurrence,
  type UndatedOccurrence,
} from './recurrence.js';
import {
  isCompleted,
  newShapeCache,
  occurrenceKey,
  placeholderEntry,
  shapeEntry,
} from './shape.js';
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
  let resolved: URL;
  try {
    resolved = new URL(api.resolveHref(href, calendar.url));
  } catch {
    return '';
  }
  // A query or a fragment ends the path, so `/cal/work/a?b.ics` has the
  // pathname `/cal/work/a` — it sits in the right collection and would have
  // been filed as the resource `a`, an id addressing something the href never
  // named. `resourceUrl` refuses these on the writing end; this is the same
  // refusal on the reading end, where the id is minted.
  if (resolved.search !== '' || resolved.hash !== '') return '';
  const path = resolved.pathname;
  // The same two conditions `resourceUrl` asserts, because the two functions
  // answer the same question from opposite ends: the name sits directly inside
  // the collection, and it is not the collection itself. An href equal to the
  // collection used to pass the first check and file the collection's own
  // name as a resource.
  // `lastIndexOf`, not `replace(/[^/]*$/, '')`: the regex is quadratic on a
  // long last segment followed by a slash, and the href is the server's.
  const parent = path.slice(0, path.lastIndexOf('/') + 1);
  if (parent !== calendar.path || path === calendar.path) return '';
  return path.slice(parent.length);
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
      // Through `textOf` like every other property, so it is entity-decoded
      // and never carries what an attribute-shaped value could smuggle. Nothing
      // reads it for `If-Match` today — the write path takes its validator
      // from the response header — but the day something does, it has to be a
      // value and not raw markup.
      etag: textOf(response.props.getetag),
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

/**
 * True when one calendar refused in a way that says nothing about the others.
 *
 * A listing asks every calendar in turn, and one that answers 403, 404 or 501,
 * or answers more than can be read, used to fail the call for all of them. Any
 * status but 401 (the account) and 429 (the server) is about that collection,
 * so the others are still listed and the answer says which one refused.
 */
export function isCalendarRefusal(
  error: unknown
): error is CalDavApiError | ResponseTooLargeError {
  return (
    error instanceof ResponseTooLargeError ||
    (error instanceof CalDavApiError &&
      error.status !== 401 &&
      error.status !== 429)
  );
}

/** One calendar left out of an answer because it refused. */
export interface Refusal {
  calendar: CalendarEntry;
  error: CalDavApiError | ResponseTooLargeError;
}

/**
 * The notes for the calendars that refused. When every calendar asked refused,
 * that is the answer, so the first refusal is thrown rather than reported as an
 * empty listing — which would read exactly like "nothing there".
 *
 * `sizeAdvice` follows the sentence about an answer that was too large; it is
 * empty where no narrower request exists.
 */
export function refusalNotes(
  refusals: readonly Refusal[],
  asked: number,
  sizeAdvice: string
): string[] {
  const first = refusals[0];
  if (first === undefined) return [];
  if (refusals.length >= asked) throw first.error;
  const unnamed = refusals.length - MAX_NAMED_REFUSALS;
  return [
    ...refusals
      .slice(0, MAX_NAMED_REFUSALS)
      .map(({ calendar, error }) =>
        error instanceof ResponseTooLargeError
          ? `"${quoted(calendar.path)}" answered with more than ${error.maxBytes} ` +
            `bytes, so its entries are not listed.${sizeAdvice}`
          : `"${quoted(calendar.path)}" refused the request with HTTP ` +
            `${error.status}, so its entries are not listed.`
      ),
    ...(unnamed > 0
      ? [
          `${unnamed} more calendar${unnamed === 1 ? '' : 's'} refused ` +
            'the request or answered with too much, so ' +
            `${unnamed === 1 ? 'its' : 'their'} entries are not listed either.`,
        ]
      : []),
    `${asked - refusals.length} of ${asked} calendars answered.`,
  ];
}

/**
 * At most this many refusing calendars are named. A server can expose 256, each
 * path a few hundred characters it chose, and the notes are paid for out of
 * the same size budget as the entries.
 */
export const MAX_NAMED_REFUSALS = 20;

const WINDOW_SIZE_ADVICE = ' A shorter time range would make it smaller.';

export interface ListOptions {
  kind: Kind;
  calendars: readonly CalendarEntry[];
  from: Date;
  to: Date;
  /** Most entries to return. Already clamped by the caller. */
  limit: number;
  /** A cursor from a previous truncated answer. */
  after?: string | undefined;
  /**
   * For tasks: `false` leaves completed ones out *before* the page is cut, so a
   * page is never short because done tasks took its slots. Ignored for other
   * kinds.
   */
  includeCompleted?: boolean | undefined;
  /**
   * The expansion budget to spend. get_free_busy lists each calendar on its
   * own and passes one budget for the whole call.
   */
  expansion?: ExpansionBudget;
  /** Entries that ran over their hard limit, counted across one call. */
  overruns?: Overruns;
}

/** One page of a listing, as a tool answers it. */
export interface Page {
  entries: Record<string, unknown>[];
  notes: string[];
  truncated?: Record<string, unknown>;
}

/**
 * A page, and the same page cut to its first `kept` entries.
 *
 * The answer is fitted to the size ceiling *before* it is counted: `cut` gives
 * the page that survives, with `returned`, the remaining count and the cursor
 * describing exactly that page. Counting first and letting the budget drop
 * entries afterwards paged past the dropped ones for good (checklist 3.13).
 */
export interface Listing extends Page {
  cut(kept: number): Page;
  /**
   * In a windowed task listing: how many tasks without a start or due date the
   * server returned and the window could not place (RFC 4791 9.9 matches them
   * through CREATED or COMPLETED, or always). Counted, never listed.
   */
  undatedTasks?: number;
}

/**
 * How long one listing or search may spend asking the server, as a whole.
 *
 * The 30-second timeout in `api.ts` bounds one request. A listing issues one
 * per calendar and a search one per calendar per field, over every calendar
 * the credentials can see when the caller names none — so an account with a
 * few hundred collections, or a server that answers each one slowly, turned
 * one call into an hour with no way to say so. The budget is checked before
 * each request, so a call ends at most one request after it runs out, and the
 * answer says how far it got.
 */
export const CALL_BUDGET_MS = 30_000;

/**
 * Occurrences a call collects before it stops asking further calendars.
 *
 * Each document is capped at `limit` by `expandOne`, but the number of
 * documents is bounded only by the 16 MiB multistatus ceiling — per calendar.
 * Ten times the largest page is room for any listing that will be read, and
 * a bound on what is sorted and shaped before the page is cut.
 */
export const MAX_COLLECTED = 5_000;

/** Why a call stopped asking calendars before it had asked them all. */
type Stop = 'time' | 'ceiling';

/** The sentence a truncated answer carries about an early stop. */
function stoppedReason(
  stop: Stop,
  asked: number,
  total: number,
  collected = 'occurrences'
): string {
  const why =
    stop === 'time'
      ? `the call's ${CALL_BUDGET_MS / 1000}-second budget ran out`
      : `${MAX_COLLECTED} ${collected} had been collected`;
  return `Stopped after ${asked} of ${total} calendars: ${why}.`;
}

interface Collected {
  occurrence: Occurrence;
  document: ResourceDocument;
}

function byStart(left: Collected, right: Collected): number {
  return (
    left.occurrence.start.instant.getTime() -
      right.occurrence.start.instant.getTime() ||
    left.document.resourceName.localeCompare(right.document.resourceName)
  );
}

/**
 * The earliest {@link MAX_COLLECTED} occurrences of a call, in whatever order
 * the server sent the entries.
 *
 * The ceiling used to fill in arrival order: one minutely series early in a
 * multistatus took all of it, every entry after it — and every calendar after
 * that — was never looked at, and the answer read as complete. Now every
 * entry is expanded, but once the ceiling is full only up to the latest
 * occurrence still kept, so later entries cost little.
 */
class Earliest {
  private items: Collected[] = [];
  private horizon: Date | undefined;
  private full = false;

  /** The end to expand the next entry to. */
  until(to: Date): Date {
    if (this.horizon === undefined) return to;
    const bound = new Date(this.horizon.getTime() + 1);
    return bound < to ? bound : to;
  }

  /** A series reached the ceiling on its own. */
  overflowed(): void {
    this.full = true;
  }

  add(items: readonly Collected[]): void {
    this.items.push(...items);
    // Compacted at twice the ceiling, so sorting stays linear in what arrives.
    if (this.items.length >= 2 * MAX_COLLECTED) this.compact();
  }

  /**
   * What was kept, sorted, and the instant from which nothing is listed when
   * anything had to be dropped. Occurrences at that instant are dropped as a
   * group, so "nothing from X on" holds exactly — unless that would leave
   * nothing at all.
   */
  finish(): {
    items: Collected[];
    cutoff: string | undefined;
    crowded: string | undefined;
  } {
    this.compact();
    const none = { items: this.items, cutoff: undefined, crowded: undefined };
    if (!this.full) return none;
    const last = this.items[this.items.length - 1];
    if (last === undefined) return none;
    const instant = last.occurrence.start.instant;
    const at = instant.toISOString().replace('.000Z', 'Z');
    const before = this.items.filter(
      (item) => item.occurrence.start.instant.getTime() < instant.getTime()
    );
    // Everything kept starts at one instant: "nothing from X on" would be
    // false, and calling again from X answers the same page.
    if (before.length === 0) return { ...none, crowded: at };
    return { items: before, cutoff: at, crowded: undefined };
  }

  private compact(): void {
    // Sorted into a new list and stored once: a hard limit can stop the
    // sort, and an in-place sort stopped half-way leaves the list in an order
    // nobody chose.
    const sorted = this.items.toSorted(byStart);
    if (sorted.length > MAX_COLLECTED) {
      sorted.length = MAX_COLLECTED;
      this.full = true;
    }
    this.items = sorted;
    if (this.full) {
      this.horizon = sorted[sorted.length - 1]?.occurrence.start.instant;
    }
  }
}

const STOPPED_FOLLOW_UP =
  'Name fewer calendars in `calendars`, or use a narrower window.';

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
  const expansion = options.expansion ?? new ExpansionBudget();
  const overruns = options.overruns ?? newOverruns();
  const abandoned: number[] = [];
  const boundedSeries: string[] = [];
  const earliest = new Earliest();

  const range = requestRange(options.from, options.to);
  const component = COMPONENT_OF[options.kind];
  const calendars = options.calendars.filter((calendar) =>
    accepts(calendar, component)
  );
  const started = Date.now();
  let asked = 0;
  let stop: Stop | undefined;
  const refusals: Refusal[] = [];
  let undatedTasks = 0;

  for (const calendar of calendars) {
    if (Date.now() - started > CALL_BUDGET_MS) {
      stop = 'time';
      break;
    }
    asked += 1;
    let documents: ResourceDocument[];
    try {
      documents = await queryCalendar(
        context.api,
        calendar,
        calendarQueryBody(component, range)
      );
    } catch (error) {
      if (!isCalendarRefusal(error)) throw error;
      refusals.push({ calendar, error });
      continue;
    }
    eachBounded(
      documents,
      overruns,
      (document) => {
        const local: string[] = [];
        const result = expandOne(
          document,
          { ...options, to: earliest.until(options.to) },
          expansion,
          context.config.timezone,
          local
        );
        const kept = (result?.occurrences ?? [])
          .filter((occurrence) => !leftOut(occurrence.component, options))
          .map((occurrence) => ({ occurrence, document }));
        return () => {
          notes.push(...local);
          if (result === undefined) return;
          notes.push(...result.notes);
          // A series cut at the ceiling skips its moved overrides, so one moved to
          // before the cutoff could be missing: it is named like a bounded one.
          if (
            (result.bounded || (result.truncated && result.overrides)) &&
            result.uid !== undefined
          ) {
            boundedSeries.push(result.uid);
          }
          if (
            result.undated !== undefined &&
            !leftOut(result.undated.component, options)
          ) {
            undatedTasks += 1;
          }
          // Only what is kept can fill the ceiling: a completed recurring task
          // left out of the listing must not cut the open ones short.
          if (result.truncated && kept.length > 0) earliest.overflowed();
          earliest.add(kept);
        };
      },
      (document) => {
        expansion.spend(hardLimits.entry);
        notes.push(skippedNote(document, new HardLimitExceeded()));
      },
      (count) => abandoned.push(count)
    );
  }

  const callNotes = [
    ...abandonedNotes(abandoned),
    ...refusalNotes(refusals, asked, WINDOW_SIZE_ADVICE),
  ];
  const { items: collected, cutoff, crowded } = earliest.finish();

  const principal = await context.discovery.principal();
  const selfAddresses = selfAddressesOf(context.config, principal.addresses);

  const keyed = uniqueCursors(
    collected.map((item) => keyedOf(item, options.kind, context))
  );
  const afterIndex =
    options.after === undefined ? 0 : cursorIndex(keyed, options.after);
  const page = shapedPage(
    keyed.slice(afterIndex, afterIndex + options.limit),
    options.kind,
    context,
    selfAddresses
  );
  const allNotes = [...callNotes, ...boundedNotes(dedupe(notes))];
  const series = dedupe(boundedSeries).slice(0, MAX_NAMED_SERIES);

  const pageOf = (kept: number): Page => {
    const shown = page.slice(0, kept);
    const consumed = kept + steppedPast(page.length, kept);
    const remaining = keyed.length - (afterIndex + consumed);
    const result: Page = {
      entries: shown.map((item) => item.entry),
      notes: allNotes,
    };
    if (
      remaining > 0 ||
      series.length > 0 ||
      stop !== undefined ||
      cutoff !== undefined ||
      crowded !== undefined ||
      kept < page.length
    ) {
      const last = shown[shown.length - 1];
      const next = keyed[afterIndex + consumed];
      result.truncated = {
        reason: sentences(
          stop === undefined
            ? undefined
            : stoppedReason(stop, asked, calendars.length),
          cutoff === undefined
            ? undefined
            : `More than ${MAX_COLLECTED} occurrences fall in this window, so ` +
                `only the earliest were collected; nothing from ${cutoff} on ` +
                'is listed.',
          crowded === undefined
            ? undefined
            : `More than ${MAX_COLLECTED} occurrences start at ${crowded}; ` +
                `only ${MAX_COLLECTED} of them are listed.`,
          remaining > 0
            ? `${remaining} more entr${remaining === 1 ? 'y' : 'ies'} in this window.`
            : undefined,
          series.length > 0
            ? 'At least one recurring entry generated more occurrences than could be walked.'
            : undefined,
          fitReason(page, kept)
        ),
        returned: kept,
        ...(last === undefined ? {} : { window_covered_until: last.start }),
        ...(next === undefined ? {} : { next_cursor: next.cursor }),
        ...(series.length > 0 ? { bounded_series: series } : {}),
        follow_up: sentences(
          next === undefined
            ? cutoff === undefined
              ? undefined
              : `Call again with \`from\` set to ${cutoff} for the rest of the window.`
            : 'Call again with `after` set to next_cursor.',
          stop === undefined && crowded === undefined
            ? undefined
            : STOPPED_FOLLOW_UP,
          series.length > 0
            ? 'The entries named in bounded_series are the expensive ones; a narrower window walks them further.'
            : undefined,
          next === undefined &&
            cutoff === undefined &&
            crowded === undefined &&
            stop === undefined &&
            series.length === 0
            ? 'Read the entry named in the reason on its own with its get tool.'
            : undefined
        ),
      };
    }
    return result;
  };

  return {
    ...pageOf(page.length),
    cut: pageOf,
    ...(options.kind === 'vtodo' ? { undatedTasks } : {}),
  };
}

export interface UndatedListOptions {
  calendars: readonly CalendarEntry[];
  includeCompleted: boolean;
  /** Most tasks to return. Already clamped by the caller. */
  limit: number;
  /** A cursor from a previous truncated answer. */
  after?: string | undefined;
}

/**
 * Lists the tasks that carry no date at all: no DTSTART and no DUE.
 *
 * A server does return such a task to a windowed query — RFC 4791 9.9 matches
 * it through CREATED or COMPLETED, or always — but no window can place it, so
 * the windowed listing leaves it out and only counts it. This asks the server
 * for exactly these with `is-not-defined`, and every task is checked here too.
 *
 * Sorted by calendar and file name, since there is no time to sort by. The
 * cursor is the entry's id alone.
 */
export async function listUndatedTasks(
  context: ToolContext,
  options: UndatedListOptions
): Promise<Listing> {
  const notes: string[] = [];
  const collected: {
    occurrence: UndatedOccurrence;
    document: ResourceDocument;
  }[] = [];
  const component = COMPONENT_OF.vtodo;
  const calendars = options.calendars.filter((calendar) =>
    accepts(calendar, component)
  );
  const started = Date.now();
  let asked = 0;
  let stop: Stop | undefined;
  const refusals: Refusal[] = [];
  let unfiltered = 0;
  const overruns = newOverruns();
  const undatedBudget = new ExpansionBudget();
  const abandoned: number[] = [];

  for (const calendar of calendars) {
    if (Date.now() - started > CALL_BUDGET_MS) {
      stop = 'time';
      break;
    }
    if (collected.length >= MAX_COLLECTED) {
      stop = 'ceiling';
      break;
    }
    asked += 1;
    let documents: ResourceDocument[];
    try {
      documents = await queryCalendar(
        context.api,
        calendar,
        undatedTaskQueryBody()
      ).catch(async (error: unknown) => {
        if (!isFilterRefusal(error)) throw error;
        unfiltered += 1;
        return queryCalendar(
          context.api,
          calendar,
          calendarQueryBody(component)
        );
      });
    } catch (error) {
      if (!isCalendarRefusal(error)) throw error;
      refusals.push({ calendar, error });
      continue;
    }
    eachBounded(
      documents,
      overruns,
      (document) => {
        const begun = Date.now();
        try {
          // Under the call's expansion budget like a windowed listing: a
          // task's start can sit in a zone the entry defines.
          const occurrence = guarded(undatedBudget.deadline(), () =>
            undatedOccurrence(
              componentsOf(
                parseCalendar(document.ics, 'the stored entry'),
                'vtodo'
              ),
              context.config.timezone
            )
          );
          undatedBudget.spend(Date.now() - begun);
          if (
            occurrence === undefined ||
            (!options.includeCompleted && isCompleted(occurrence.component))
          ) {
            return undefined;
          }
          const unanchored = hasUnanchoredRule(occurrence.component);
          return () => {
            collected.push({ occurrence, document });
            if (unanchored) {
              notes.push(
                `"${quoted(document.resourceName)}" in ` +
                  `"${quoted(document.calendar.path)}" has a recurrence rule but ` +
                  'no start or due date to anchor it, so the rule is ignored and ' +
                  'the task is listed as one without a date.'
              );
            }
          };
        } catch (error) {
          undatedBudget.spend(Date.now() - begun);
          return () => notes.push(skippedNote(document, error));
        }
      },
      (document) => notes.push(skippedNote(document, new HardLimitExceeded())),
      (count) => abandoned.push(count)
    );
  }

  const callNotes = [
    ...abandonedNotes(abandoned),
    ...refusalNotes(refusals, asked, ''),
  ];
  if (unfiltered > 0) {
    callNotes.push(
      `The server refused the filter for tasks without a date in ${unfiltered} ` +
        `calendar${unfiltered === 1 ? '' : 's'}, so every task there was read ` +
        'and the ones without a date were kept here.'
    );
  }

  collected.sort(
    (left, right) =>
      left.document.calendar.path.localeCompare(right.document.calendar.path) ||
      left.document.resourceName.localeCompare(right.document.resourceName)
  );

  const principal = await context.discovery.principal();
  const selfAddresses = selfAddressesOf(context.config, principal.addresses);

  const keyed = uniqueCursors(
    collected.map((item) => keyedOf(item, 'vtodo', context))
  );
  const afterIndex =
    options.after === undefined ? 0 : cursorIndex(keyed, options.after, 'call');
  const page = shapedPage(
    keyed.slice(afterIndex, afterIndex + options.limit),
    'vtodo',
    context,
    selfAddresses
  );
  const allNotes = [...callNotes, ...boundedNotes(dedupe(notes))];

  const pageOf = (kept: number): Page => {
    const shown = page.slice(0, kept);
    const consumed = kept + steppedPast(page.length, kept);
    const remaining = keyed.length - (afterIndex + consumed);
    const result: Page = {
      entries: shown.map((item) => item.entry),
      notes: allNotes,
    };
    if (remaining > 0 || stop !== undefined || kept < page.length) {
      const next = keyed[afterIndex + consumed];
      result.truncated = {
        reason: sentences(
          stop === undefined
            ? undefined
            : stoppedReason(stop, asked, calendars.length, 'tasks'),
          remaining > 0
            ? `${remaining} more task${remaining === 1 ? '' : 's'} with no date.`
            : undefined,
          fitReason(page, kept)
        ),
        returned: kept,
        ...(next === undefined ? {} : { next_cursor: next.cursor }),
        follow_up: sentences(
          next === undefined
            ? undefined
            : 'Call again with `after` set to next_cursor.',
          stop === undefined
            ? undefined
            : 'Name fewer calendars in `calendars`.',
          next === undefined && stop === undefined
            ? 'Read the task named in the reason on its own with get_task.'
            : undefined
        ),
      };
    }
    return result;
  };

  return { ...pageOf(page.length), cut: pageOf };
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
  const calendars = options.calendars.filter((calendar) =>
    accepts(calendar, component)
  );
  const started = Date.now();
  let asked = 0;
  let stop: Stop | undefined;
  const refusals: Refusal[] = [];
  for (const calendar of calendars) {
    if (Date.now() - started > CALL_BUDGET_MS) {
      stop = 'time';
      break;
    }
    if (documents.length >= MAX_COLLECTED) {
      stop = 'ceiling';
      break;
    }
    asked += 1;
    const seen = new Set<string>();
    const found: ResourceDocument[] = [];
    try {
      // One REPORT per field, unioned by resource: RFC 4791 combines sibling
      // prop-filters with AND, so a single body asking for SUMMARY *and*
      // DESCRIPTION matches only entries carrying the term in both.
      for (const field of options.fields) {
        if (Date.now() - started > CALL_BUDGET_MS) {
          stop = 'time';
          break;
        }
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
          found.push(document);
        }
      }
    } catch (error) {
      if (!isCalendarRefusal(error)) throw error;
      refusals.push({ calendar, error });
      continue;
    }
    documents.push(...found);
  }
  const callNotes = refusalNotes(
    refusals,
    asked,
    ' A narrower query or a shorter time range would make it smaller.'
  );

  if (collation !== undefined) {
    callNotes.push(
      'This server refused the default text collation, so the search ran with ' +
        'i;ascii-casemap. Matching outside ASCII may differ from what a ' +
        'calendar client shows.'
    );
  }

  const expansion = options.expansion ?? new ExpansionBudget();
  const overruns = options.overruns ?? newOverruns();
  const abandoned: number[] = [];
  const earliest = new Earliest();
  eachBounded(
    documents,
    overruns,
    (document) => {
      const local: string[] = [];
      const result = expandOne(
        document,
        { ...options, to: earliest.until(options.to) },
        expansion,
        context.config.timezone,
        local
      );
      return () => {
        notes.push(...local);
        if (result === undefined) return;
        notes.push(...result.notes);
        if (result.truncated && result.occurrences.length > 0) {
          earliest.overflowed();
        }
        earliest.add(
          result.occurrences.map((occurrence) => ({ occurrence, document }))
        );
      };
    },
    (document) => {
      expansion.spend(hardLimits.entry);
      notes.push(skippedNote(document, new HardLimitExceeded()));
    },
    (count) => abandoned.push(count)
  );
  callNotes.unshift(...abandonedNotes(abandoned));
  const { items: collected, cutoff, crowded } = earliest.finish();

  const principal = await context.discovery.principal();
  const selfAddresses = selfAddressesOf(context.config, principal.addresses);
  const page = shapedPage(
    collected.slice(0, options.limit),
    options.kind,
    context,
    selfAddresses
  );
  const allNotes = [...callNotes, ...boundedNotes(dedupe(notes))];

  // No cursor here: a search answers its first `limit` matches and says how
  // many more there are, so a match that does not fit is counted, not paged.
  const pageOf = (kept: number): Page => {
    const more = collected.length - kept;
    const result: Page = {
      entries: page.slice(0, kept).map((item) => item.entry),
      notes: allNotes,
    };
    if (
      more > 0 ||
      stop !== undefined ||
      cutoff !== undefined ||
      crowded !== undefined
    ) {
      result.truncated = {
        reason: sentences(
          stop === undefined
            ? undefined
            : stoppedReason(stop, asked, calendars.length, 'matching entries'),
          cutoff === undefined
            ? undefined
            : `More than ${MAX_COLLECTED} occurrences matched, so only the ` +
                `earliest were collected; nothing from ${cutoff} on is listed.`,
          crowded === undefined
            ? undefined
            : `More than ${MAX_COLLECTED} matching occurrences start at ` +
                `${crowded}; only ${MAX_COLLECTED} of them were collected.`,
          more > 0 ? `${more} more matches.` : undefined,
          fitReason(page, kept, 'counted')
        ),
        returned: kept,
        follow_up:
          stop === undefined
            ? 'Narrow the query or the time range.'
            : STOPPED_FOLLOW_UP,
      };
    }
    return result;
  };

  return {
    ...pageOf(page.length),
    cut: pageOf,
    ...(collation === undefined ? {} : { collation }),
  };
}

/**
 * Parses and expands one resource, or skips it with a note.
 *
 * One resource is isolated from the rest of the listing on purpose. Every
 * entry in a calendar was written by somebody — on a scheduling server, by
 * anybody who knows the address — and a document that does not parse, or a
 * rule that ical.js cannot walk, used to throw out of here and fail the whole
 * call for every calendar in it. Worse, the message read as if the *caller*
 * had got something wrong. Now the entry is left out, the answer says which
 * one and why, and the other entries are still reported: a listing that says
 * "one entry could not be read" is honest, one that says nothing at all is not.
 */
function expandOne(
  document: ResourceDocument,
  options: { kind: Kind; from: Date; to: Date },
  budget: ExpansionBudget,
  fallbackZone: string,
  notes: string[]
) {
  const started = Date.now();
  try {
    // Everything here under the call's deadline, not only the walk: a
    // timezone in the entry is expanded by ical.js whenever a time in it is
    // read, and once the budget is spent that must cost nothing more.
    return guarded(budget.deadline(), () => {
      const root = parseCalendar(document.ics, 'the stored entry');
      const components = componentsOf(root, options.kind);
      const expansion = expandSeries(components, {
        from: options.from,
        to: options.to,
        // The call's ceiling, not the page size: a series capped at `limit`
        // lost every later occurrence on every page, because the next page
        // expands the series again from the start of the window.
        cap: MAX_COLLECTED,
        fallbackZone,
        deadline: budget.deadline(),
      });
      return {
        ...expansion,
        uid: cleanedUid(components),
        overrides: components.length > 1,
        undated:
          options.kind === 'vtodo' && expansion.occurrences.length === 0
            ? undatedOccurrence(components, fallbackZone)
            : undefined,
      };
    });
  } catch (error) {
    notes.push(skippedNote(document, error));
    return undefined;
  } finally {
    budget.spend(Date.now() - started);
  }
}

/**
 * Five seconds of expansion per call, counted while expanding.
 *
 * It was a wall-clock deadline set when the call began, so it also ran out
 * while the server answered: after five seconds of slow REPORTs every series
 * stopped at its first step and was reported as one that could not be walked.
 */
export class ExpansionBudget {
  private left = 5_000;

  /**
   * Already past once the budget is spent, so a series stops at its first step
   * rather than getting another slice of 256 for free: the deadline used to be
   * "now", and a check for "later than now" in the same millisecond passes.
   */
  deadline(): number {
    return this.left > 0 ? Date.now() + this.left : 0;
  }

  spend(ms: number): void {
    this.left -= ms;
  }
}

/** The note for the entries a call stopped evaluating, if there were any. */
function abandonedNotes(abandoned: readonly number[]): string[] {
  const count = abandoned.reduce((sum, value) => sum + value, 0);
  if (count === 0) return [];
  return [
    `${count} more stored entr${count === 1 ? 'y was' : 'ies were'} not ` +
      `evaluated: ${MAX_OVERRUNS} entries in this call took longer than this ` +
      'server allows, so it stopped reading any more. Name fewer calendars ' +
      'or a shorter time range.',
  ];
}

/**
 * The note for one stored entry a listing had to leave out.
 *
 * The name is a path segment the server chose, so it is quoted once, here, cut
 * and escaped. Callers give the parser a fixed context rather than the name: a
 * name in that context came back uncut through the parser's own message.
 */
function skippedNote(document: ResourceDocument, error: unknown): string {
  const reason =
    error instanceof ToolInputError
      ? error.message
          .replace(/^caldav-mcp: /, '')
          .replace(
            / This is the stored entry, not the arguments of this call\.$/,
            ''
          )
      : 'it could not be expanded.';
  return (
    `Skipped "${quoted(document.resourceName)}" in ` +
    `"${quoted(document.calendar.path)}": ` +
    `${reason} This is a problem with that stored entry, not with the ` +
    'arguments of this call; the other entries are reported as usual.'
  );
}

/** A completed task, in a task listing that asked to leave those out. */
function leftOut(
  component: ICAL.Component,
  options: { kind: Kind; includeCompleted?: boolean | undefined }
): boolean {
  return (
    options.kind === 'vtodo' &&
    options.includeCompleted === false &&
    isCompleted(component)
  );
}

/** At most this many series are named in `bounded_series`. */
const MAX_NAMED_SERIES = 20;

/**
 * 1 when the first entry of a page did not fit even on its own: it is stepped
 * past, so the next call does not answer the same empty page forever.
 */
function steppedPast(pageLength: number, kept: number): number {
  return kept === 0 && pageLength > 0 ? 1 : 0;
}

/** Why a page holds fewer entries than it could have, or nothing. */
function fitReason(
  page: readonly { entry: Record<string, unknown> }[],
  kept: number,
  paging: 'stepped' | 'counted' = 'stepped'
): string | undefined {
  if (kept >= page.length) return undefined;
  if (kept === 0) {
    // A search has no cursor, so nothing is stepped past there: the entry is
    // counted with the other matches that were not returned.
    return (
      `The entry "${quoted(String(page[0]?.entry.id ?? ''))}" does not fit ` +
      'under the size ceiling even on its own' +
      (paging === 'stepped' ? ', so it was stepped past' : '') +
      '; read it on its own with its get tool.'
    );
  }
  return `Only ${kept} of ${page.length} entries fitted under the size ceiling.`;
}

/** The non-empty parts, as one paragraph. */
function sentences(...parts: (string | undefined)[]): string {
  return parts.filter((part) => part !== undefined && part !== '').join(' ');
}

function accepts(calendar: CalendarEntry, component: string): boolean {
  return (
    calendar.components.length === 0 || calendar.components.includes(component)
  );
}

/**
 * The UID a truncated answer names, cleaned like every other field.
 *
 * It used to be cut out of the raw text with a regex, so whatever an invitation
 * put on its UID line — invisible characters, an instruction, kilobytes of it —
 * reached the model unfiltered in `bounded_series`.
 */
function cleanedUid(components: readonly ICAL.Component[]): string | undefined {
  const first = components[0];
  const uid = first === undefined ? undefined : readText(first, 'uid');
  return uid === undefined ? undefined : sanitizeText(uid, 200);
}

interface Keyed<O extends Occurrence | UndatedOccurrence> {
  occurrence: O;
  document: ResourceDocument;
  /** The start as reported; empty for a task with no date. */
  start: string;
  /**
   * The cursor for the next page: a start time and an id.
   *
   * Not an offset. An offset into an expansion is not stable between two calls
   * — a new entry created in between shifts everything after it — and two
   * occurrences sharing a start time would be dropped or duplicated at the
   * page boundary if the id half were left out.
   */
  cursor: string;
}

function keyedOf<O extends Occurrence | UndatedOccurrence>(
  item: { occurrence: O; document: ResourceDocument },
  kind: Kind,
  context: ToolContext
): Keyed<O> {
  const key = occurrenceKey(item.occurrence, {
    kind,
    calendar: item.document.calendar,
    resourceName: item.document.resourceName,
    fallbackZone: context.config.timezone,
  });
  return { ...item, start: key.start, cursor: `${key.start}|${key.id}` };
}

/**
 * Shapes the entries of one page, and only those.
 *
 * Sorting and paging need the key alone; shaping everything collected — up to
 * the call's ceiling — before cutting out a page of one cost seconds for one
 * long series. Occurrences of one series share their cleaned fields.
 */
function shapedPage<
  T extends {
    occurrence: Occurrence | UndatedOccurrence;
    document: ResourceDocument;
  },
>(
  items: readonly T[],
  kind: Kind,
  context: ToolContext,
  selfAddresses: readonly string[]
): (T & { entry: Record<string, unknown> })[] {
  const cache = newShapeCache();
  const shape = (item: T): Record<string, unknown> =>
    shapeEntry(item.occurrence, {
      kind,
      calendar: item.document.calendar,
      resourceName: item.document.resourceName,
      fallbackZone: context.config.timezone,
      detailed: false,
      selfAddresses,
      cache,
    }).entry;
  // Shaping evaluates no stored zone any more, so the whole page under one
  // limit is a backstop. Should it trip, each entry gets a limit of its own,
  // and one that still runs over is reported by its id and times alone
  // rather than taking the page down with it.
  try {
    return withHardLimit(hardLimits.singleEntry, () =>
      items.map((item) => ({ ...item, entry: shape(item) }))
    );
  } catch (error) {
    if (!(error instanceof HardLimitExceeded)) throw error;
  }
  return items.map((item) => {
    try {
      return {
        ...item,
        entry: withHardLimit(hardLimits.entry, () => shape(item)),
      };
    } catch (error) {
      if (!(error instanceof HardLimitExceeded)) throw error;
      return {
        ...item,
        entry: placeholderEntry(item.occurrence, {
          kind,
          calendar: item.document.calendar,
          resourceName: item.document.resourceName,
          fallbackZone: context.config.timezone,
        }),
      };
    }
  });
}

/**
 * Two occurrences can share a start and an id — a document of overrides with
 * the same RECURRENCE-ID twice — and then the cursor named the first of them
 * for ever. A repeat gets a counter.
 */
function uniqueCursors<T extends { cursor: string }>(items: readonly T[]): T[] {
  const seen = new Map<string, number>();
  return items.map((item) => {
    const count = seen.get(item.cursor) ?? 0;
    seen.set(item.cursor, count + 1);
    return count === 0 ? item : { ...item, cursor: `${item.cursor}#${count}` };
  });
}

function cursorIndex(
  keyed: readonly { cursor: string }[],
  cursor: string,
  scope: 'window' | 'call' = 'window'
): number {
  const index = keyed.findIndex((item) => item.cursor === cursor);
  if (index === -1) {
    throw new ToolInputError(
      scope === 'window'
        ? 'caldav-mcp: that cursor does not match anything in this window. It ' +
            'comes from the `truncated.next_cursor` of a previous call, and the ' +
            'window has to be the same one.'
        : 'caldav-mcp: that cursor does not match anything in this listing. It ' +
            'comes from the `truncated.next_cursor` of a previous call, and the ' +
            'arguments have to be the same ones.'
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
  // Lower case throughout, because the comparison is against a lower-cased
  // ATTENDEE value. This used to be the one place that lower-cased the
  // configured address, while three other tools built the same list by hand
  // without — so `is_self` was true in a listing and absent in get_event for
  // the same entry and the same CALDAV_USER_EMAIL=Me@Example.COM.
  const configured = config.userEmail?.toLowerCase();
  return dedupe(
    (configured === undefined
      ? [...discovered]
      : [configured, ...discovered]
    ).map((address) => address.toLowerCase())
  );
}

/** At most this many notes about individual entries in one answer. */
export const MAX_ENTRY_NOTES = 20;

/**
 * The notes about individual entries, capped.
 *
 * Every broken entry earns a note of a few hundred characters, and a calendar
 * someone else writes to can hold thousands. Uncapped, they crowded the
 * entries out of the size budget. Notes about the call itself — a calendar
 * that refused, a filter the server would not apply — come first and are never
 * cut, which is why the caller passes only the per-entry ones here.
 */
function boundedNotes(notes: readonly string[]): string[] {
  if (notes.length <= MAX_ENTRY_NOTES) return [...notes];
  const left = notes.length - MAX_ENTRY_NOTES;
  return [
    ...notes.slice(0, MAX_ENTRY_NOTES),
    `${left} more note${left === 1 ? '' : 's'} about individual entries ` +
      `${left === 1 ? 'was' : 'were'} left out.`,
  ];
}

function dedupe(values: readonly string[]): string[] {
  return [...new Set(values)];
}

/**
 * True when a server refused the `is-not-defined` filter itself.
 *
 * RFC 4791 answers an unsupported filter with 403 and `supported-filter`; some
 * servers answer 400 or 501 instead. The caller then asks without it.
 */
function isFilterRefusal(error: unknown): boolean {
  return (
    error instanceof CalDavApiError &&
    (error.status === 400 ||
      error.status === 501 ||
      (error.status === 403 &&
        String(error.precondition ?? '').includes('supported-filter')))
  );
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
