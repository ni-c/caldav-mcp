import { quoted } from './analyze.js';
import { CalendarNotAllowedError, ToolInputError } from './errors.js';
import type { Kind } from './ical.js';

/**
 * The addressing scheme, and the place the calendar allowlist is enforced.
 *
 * ```
 * e1.<calendar>.<resource>              a VEVENT series, or a one-off event
 * e1.<calendar>.<resource>.<recurrence> one occurrence of that series
 * t1.…  VTODO      j1.…  VJOURNAL
 * ```
 *
 * Each part is base64url of a UTF-8 string, and `.` is outside the base64url
 * alphabet, so the whole thing is one unambiguous URL-safe token needing no
 * quoting anywhere.
 *
 * Three properties are worth stating, because they are the reasons for the
 * shape rather than consequences of it:
 *
 * - **The origin is never in the id.** Only a path is, and the origin is
 *   recomposed from `CALDAV_URL` on every decode. So the worst a forged or
 *   hand-edited id can do is name a path on the configured server; it can never
 *   redirect this server at another host.
 * - **It decodes without a round trip**, so it survives a restart and needs no
 *   server-side table — and therefore no cache lifetime, every choice of which
 *   would be wrong in one direction or the other.
 * - **{@link parseEntityId} takes the calendar registry as a required
 *   argument**, and refuses an id naming a calendar outside it. There is no path
 *   from an id to a URL that does not pass through here, which is what makes
 *   "the allowlist is checked per tool" structural instead of a habit.
 */

/** The version-and-kind tag that opens every id. */
const TAG: Record<Kind, string> = {
  vevent: 'e1',
  vtodo: 't1',
  vjournal: 'j1',
};

const KIND_OF: Record<string, Kind> = {
  e1: 'vevent',
  t1: 'vtodo',
  j1: 'vjournal',
};

/** What a tool calls the thing, for an error a person can act on. */
const NOUN: Record<Kind, string> = {
  vevent: 'event',
  vtodo: 'task',
  vjournal: 'journal entry',
};

/** The minimum this module needs to know about the calendar registry. */
export interface CalendarLookup {
  /** Whether a calendar path is inside `CALDAV_CALENDARS`. */
  allows(path: string): boolean;
  /** Whether the path names a calendar that was discovered at all. */
  knows(path: string): boolean;
}

/** A decoded id. `recurrenceId` is present only for an occurrence. */
export interface EntityId {
  kind: Kind;
  /** The calendar collection's path, with its trailing slash. */
  calendarPath: string;
  /** The resource's name inside the collection, e.g. `a1b2c3.ics`. */
  resourceName: string;
  /** The RECURRENCE-ID exactly as iCalendar spells it, when this is one occurrence. */
  recurrenceId: string | undefined;
}

function encode(value: string): string {
  return Buffer.from(value, 'utf8').toString('base64url');
}

/**
 * Decodes one part, rejecting anything that is not exactly base64url of UTF-8.
 *
 * `Buffer.from(…, 'base64url')` is lenient: it ignores characters outside the
 * alphabet and accepts a truncated group, so two different ids can decode to the
 * same value. Re-encoding and comparing is what makes the mapping one-to-one,
 * which matters because these strings are compared against an allowlist.
 */
function decode(part: string, id: string): string {
  if (!/^[A-Za-z0-9_-]+$/.test(part)) {
    throw badId(id);
  }
  const decoded = Buffer.from(part, 'base64url').toString('utf8');
  if (encode(decoded) !== part) throw badId(id);
  // A NUL in a decoded path is not a path; it is the classic attempt to end
  // a string early somewhere further down. Nothing this server issues can
  // contain one.
  if (decoded.includes('\0')) throw badId(id);
  return decoded;
}

function badId(id: string): ToolInputError {
  return new ToolInputError(
    `caldav-mcp: "${quoted(id)}" is not an id this server issued. Ids come ` +
      'from the listing tools — list_events, list_tasks, list_journals — and ' +
      'are not meant to be composed by hand.'
  );
}

/**
 * Whether a resource name contains a character the URL layer would not carry
 * faithfully: a C0 control or DEL, which the parser strips or encodes, or a
 * `?` or `#`, which end the path. Written as a code-point walk rather than a
 * regex so the file carries no control characters, escaped or otherwise.
 */
function hasUnaddressableCharacter(name: string): boolean {
  for (const character of name) {
    const code = character.codePointAt(0) ?? 0;
    if (code < 0x20 || code === 0x7f) return true;
    if (character === '?' || character === '#') return true;
  }
  return false;
}

/** The id of a whole series, or of an entry that does not recur. */
export function buildSeriesId(
  kind: Kind,
  calendarPath: string,
  resourceName: string
): string {
  return `${TAG[kind]}.${encode(calendarPath)}.${encode(resourceName)}`;
}

/** The id of one occurrence of a series. */
export function buildOccurrenceId(
  kind: Kind,
  calendarPath: string,
  resourceName: string,
  recurrenceId: string
): string {
  return `${buildSeriesId(kind, calendarPath, resourceName)}.${encode(recurrenceId)}`;
}

/**
 * Decodes an id, checking everything about it that can be checked here.
 *
 * `expectedKind` is what the calling tool handles. A mismatch is answered by
 * naming the right tool rather than with a 404: an id that decodes perfectly and
 * belongs to a task is a different situation from one that names nothing, and
 * telling them apart saves the reader from hunting a typo that is not there.
 */
export function parseEntityId(
  id: string,
  expectedKind: Kind,
  calendars: CalendarLookup
): EntityId {
  const parts = id.trim().split('.');
  if (parts.length < 3 || parts.length > 4) throw badId(id);

  const [tag, rawCalendar, rawResource, rawRecurrence] = parts as [
    string,
    string,
    string,
    string | undefined,
  ];
  const kind = KIND_OF[tag];
  if (kind === undefined) throw badId(id);
  if (kind !== expectedKind) {
    throw new ToolInputError(
      `caldav-mcp: that is the id of a ${NOUN[kind]}, and this tool works on ` +
        `${NOUN[expectedKind]}s. Use the ${NOUN[kind]} tools instead.`
    );
  }

  const calendarPath = decode(rawCalendar, id);
  const resourceName = decode(rawResource, id);

  // A calendar path is an absolute collection path. No dot segments, because a
  // path this server assembles never contains one and a path that does was not
  // assembled by this server.
  if (
    !calendarPath.startsWith('/') ||
    calendarPath
      .split('/')
      .some((segment) => segment === '.' || segment === '..')
  ) {
    throw badId(id);
  }

  // Every CalDAV server stores resources directly inside the collection, so a
  // name is one path segment.
  //
  // A literal `/` and a leading `.` are not enough, and believing they were is
  // what made this a real hole: the WHATWG URL parser normalises a
  // percent-encoded dot segment and treats a backslash as a separator, so
  // `%2E%2E` and `\..\x` both survived this check and then walked out of the
  // collection at the moment the URL was built. Backslashes and encoded dots
  // are refused here, and `resourceUrl` asserts the *resolved* path
  // independently — a string check cannot anticipate the next encoding, and a
  // path check does not have to.
  //
  // `?`, `#` and control characters are refused for a different reason: they
  // do not leave the collection, they change what the request addresses
  // without the id saying so. `resourceUrl` catches those too, by requiring
  // the resolved path to equal the name; this check exists so the error names
  // the id rather than the URL.
  if (
    resourceName.length === 0 ||
    resourceName.includes('/') ||
    resourceName.includes('\\') ||
    resourceName.startsWith('.') ||
    /%2e/i.test(resourceName) ||
    hasUnaddressableCharacter(resourceName)
  ) {
    throw badId(id);
  }

  if (!calendars.allows(calendarPath)) {
    throw new CalendarNotAllowedError(
      calendars.knows(calendarPath)
        ? 'caldav-mcp: that entry is in a calendar this server was not given ' +
            'access to. CALDAV_CALENDARS names the calendars it may touch; ' +
            'list_calendars shows which those are.'
        : 'caldav-mcp: that entry is in a calendar this server cannot see. It ' +
            'may have been removed, or the id may be from a different ' +
            'configuration. Call list_calendars to see what is available.'
    );
  }

  return {
    kind,
    calendarPath,
    resourceName,
    recurrenceId:
      rawRecurrence === undefined ? undefined : decode(rawRecurrence, id),
  };
}

/** True when the id addresses one occurrence rather than a whole series. */
export function isOccurrenceId(id: EntityId): boolean {
  return id.recurrenceId !== undefined;
}

/** The series id for an entity id, dropping the occurrence part. */
export function seriesIdOf(id: EntityId): string {
  return buildSeriesId(id.kind, id.calendarPath, id.resourceName);
}
