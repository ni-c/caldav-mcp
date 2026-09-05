import { CalendarNotAllowedError, ToolInputError } from './errors.js';
import type { CalendarLookup } from './entity-id.js';

/**
 * The calendar registry, and every line of `CALDAV_CALENDARS` enforcement.
 *
 * One file and one test file, because this is a security boundary. The rule the
 * whole server depends on is that there is **no single resolver a tool could
 * forget to call**: a tool either takes an id, in which case `parseEntityId`
 * performs the check while decoding, or it takes calendars, in which case it
 * calls {@link CalendarRegistry.resolveMany} — which, given nothing, returns the
 * *allowed* calendars and never the raw discovery result.
 *
 * `list_calendars` and `get_server_info` take neither and are guarded by
 * filtering what they print, with a count of what was withheld.
 */

/** One calendar collection, as discovery found it. */
export interface CalendarEntry {
  /** Absolute URL on the configured origin, with a trailing slash. */
  url: string;
  /** The URL's pathname — what the allowlist and every id are keyed on. */
  path: string;
  displayName: string | undefined;
  description: string | undefined;
  /**
   * Components the collection accepts. Empty means the server did not say,
   * which per RFC 4791 means every component is allowed — not that none is.
   */
  components: readonly string[];
  ctag: string | undefined;
  color: string | undefined;
  /** True when `current-user-privilege-set` grants no form of write. */
  readOnly: boolean;
}

/** Normalises a collection path for comparison: exactly one trailing slash. */
export function normalisePath(path: string): string {
  const trimmed = path.replace(/\/+$/, '');
  return `${trimmed}/`;
}

/**
 * How an allowlist entry is matched against a calendar.
 *
 * Three accepted spellings, in the order a person is likely to reach for them:
 * a full URL, an absolute path, or the collection's final path segment. What is
 * **not** accepted is a display name, and that is a decision rather than an
 * omission — on a shared calendar the display name is chosen by whoever shared
 * it, it is not unique across a principal, and it changes without notice. An
 * allowlist keyed on a mutable, externally-controlled string is not an
 * allowlist.
 */
function matches(entry: string, calendar: CalendarEntry): boolean {
  const candidate = entry.trim();
  if (candidate.length === 0) return false;

  if (/^https?:\/\//i.test(candidate)) {
    try {
      return normalisePath(new URL(candidate).pathname) === calendar.path;
    } catch {
      return false;
    }
  }
  if (candidate.startsWith('/')) {
    return normalisePath(candidate) === calendar.path;
  }
  return finalSegment(calendar.path) === candidate.replace(/\/+$/, '');
}

function finalSegment(path: string): string {
  const parts = path.split('/').filter((part) => part.length > 0);
  return parts[parts.length - 1] ?? '';
}

/**
 * Builds the URL of a resource inside a calendar, and proves it stayed inside.
 *
 * The one place a collection URL and a resource name are joined. It exists
 * because checking the *name* is not the same as checking the *path*, and the
 * difference was a real hole: `entity-id.ts` rejected a literal `/` and a
 * leading `.`, and both a percent-encoded dot segment and a backslash walked
 * straight past it —
 *
 * ```
 * new URL('https://h/cal/work/' + '%2E%2E')      -> https://h/cal/
 * new URL('https://h/cal/work/' + '\\..\\x.ics')  -> https://h/cal/x.ics
 * ```
 *
 * — because the WHATWG URL parser normalises percent-encoded dot segments and
 * treats a backslash as a separator, long after any string check has passed. A
 * forged id could therefore name an allowed calendar, satisfy the allowlist,
 * and then address a resource in a different one; `delete_event` would have
 * removed another principal's collection.
 *
 * So the assertion is on the resolved path rather than on the input: whatever
 * encoding trick comes next, the result still has to sit directly inside this
 * collection.
 */
export function resourceUrl(
  calendar: Pick<CalendarEntry, 'url' | 'path'>,
  resourceName: string
): string {
  const url = new URL(`${calendar.url}${resourceName}`);
  const parent = url.pathname.replace(/[^/]*$/, '');
  if (parent !== calendar.path || url.pathname === calendar.path) {
    throw new ToolInputError(
      'caldav-mcp: that id does not name an entry inside the calendar it ' +
        'claims to be in. Ids come from the listing tools and are not meant ' +
        'to be composed by hand.'
    );
  }
  return url.toString();
}

export class CalendarRegistry implements CalendarLookup {
  private readonly all: readonly CalendarEntry[];
  private readonly permitted: readonly CalendarEntry[];
  private readonly allowlist: readonly string[];

  constructor(all: readonly CalendarEntry[], allowlist: readonly string[]) {
    this.all = all;
    this.allowlist = allowlist;
    this.permitted =
      allowlist.length === 0
        ? all
        : all.filter((calendar) =>
            allowlist.some((entry) => matches(entry, calendar))
          );
  }

  /** Every calendar this server may touch. The only list any tool may print. */
  allowed(): readonly CalendarEntry[] {
    return this.permitted;
  }

  /**
   * How many calendars the allowlist is keeping out of sight.
   *
   * Reported by `list_calendars` rather than hidden, because a listing that
   * silently omits entries teaches the reader that the calendars do not exist —
   * and then a perfectly correct id from another source looks like a bug.
   */
  withheld(): number {
    return this.all.length - this.permitted.length;
  }

  allows(path: string): boolean {
    const wanted = normalisePath(path);
    return this.permitted.some((calendar) => calendar.path === wanted);
  }

  knows(path: string): boolean {
    const wanted = normalisePath(path);
    return this.all.some((calendar) => calendar.path === wanted);
  }

  /**
   * Allowlist entries that matched no calendar.
   *
   * A typo here would otherwise fence the server off from everything in
   * silence, which is the failure mode a scope allowlist must not have. The
   * caller prints these on the startup line.
   */
  unmatched(): string[] {
    return this.allowlist.filter(
      (entry) => !this.all.some((calendar) => matches(entry, calendar))
    );
  }

  /**
   * Allowlist entries matching more than one calendar.
   *
   * Only possible for a bare final segment, and it is a startup error rather
   * than a silent widening: `work` meaning two different collections is not
   * something to resolve by picking one.
   */
  ambiguous(): { entry: string; paths: string[] }[] {
    return this.allowlist
      .map((entry) => ({
        entry,
        paths: this.all
          .filter((calendar) => matches(entry, calendar))
          .map((calendar) => calendar.path),
      }))
      .filter((result) => result.paths.length > 1);
  }

  /**
   * Resolves one calendar a caller named, refusing anything outside the fence.
   *
   * A calendar the operator fenced off is answered with a refusal, not with
   * "not found": telling the two apart is what stops somebody hunting a typo in
   * a name that is spelled correctly and simply not permitted.
   */
  resolve(reference: string): CalendarEntry {
    const wanted = reference.trim();
    if (wanted.length === 0) {
      throw new ToolInputError(
        'caldav-mcp: a calendar was named as an empty string. Pass an id from ' +
          'list_calendars, or leave the argument out to use every calendar.'
      );
    }
    const permitted = this.permitted.filter((calendar) =>
      matches(wanted, calendar)
    );
    if (permitted.length === 1) return permitted[0] as CalendarEntry;
    if (permitted.length > 1) {
      throw new ToolInputError(
        `caldav-mcp: "${reference}" matches ${permitted.length} calendars ` +
          `(${permitted.map((calendar) => calendar.path).join(', ')}). ` +
          'Name it by its full path, which list_calendars prints.'
      );
    }
    if (this.all.some((calendar) => matches(wanted, calendar))) {
      throw new CalendarNotAllowedError(
        `caldav-mcp: "${reference}" is a calendar this server was not given ` +
          'access to. CALDAV_CALENDARS names the calendars it may touch; ' +
          'list_calendars shows which those are.'
      );
    }
    throw new ToolInputError(
      `caldav-mcp: no calendar called "${reference}". Call list_calendars to ` +
        'see what is available.'
    );
  }

  /**
   * Resolves the calendars a tool should act on.
   *
   * With no argument this returns the **allowed** calendars — never `all`. That
   * is the whole reason this method exists rather than each tool reaching for a
   * list: the default case is the one most likely to be written without thinking
   * about the fence, so the fence is what the default returns.
   */
  resolveMany(references?: readonly string[]): readonly CalendarEntry[] {
    if (references === undefined || references.length === 0) {
      if (this.permitted.length === 0) {
        throw new ToolInputError(
          this.all.length === 0
            ? 'caldav-mcp: the account has no calendars, or none that this ' +
                'server could discover. get_server_info reports what it found.'
            : 'caldav-mcp: CALDAV_CALENDARS allows none of the calendars this ' +
                'account has, so there is nothing to read.'
        );
      }
      return this.permitted;
    }
    const resolved = references.map((reference) => this.resolve(reference));
    // De-duplicate: two spellings of one calendar must not make it answer twice.
    const seen = new Set<string>();
    return resolved.filter((calendar) => {
      if (seen.has(calendar.path)) return false;
      seen.add(calendar.path);
      return true;
    });
  }

  /** The calendar a decoded id points at. Assumes the id was already checked. */
  byPath(path: string): CalendarEntry | undefined {
    const wanted = normalisePath(path);
    return this.permitted.find((calendar) => calendar.path === wanted);
  }

  /**
   * Whether a calendar accepts a component kind.
   *
   * An empty `components` means the server declared nothing, which RFC 4791
   * reads as "everything". Answering `false` there would refuse writes on every
   * Radicale collection created without an explicit set.
   */
  accepts(calendar: CalendarEntry, component: string): boolean {
    return (
      calendar.components.length === 0 ||
      calendar.components.includes(component.toUpperCase())
    );
  }
}
