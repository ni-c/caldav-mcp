import { CalDavApiError, type CalDavApi } from './api.js';
import {
  CalendarRegistry,
  normalisePath,
  type CalendarEntry,
} from './calendars.js';
import { AllowlistError } from './errors.js';
import {
  hrefsOf,
  privileges,
  resourceTypeHas,
  supportedComponents,
  textOf,
  type PropName,
} from './dav-xml.js';

/**
 * Walking from a URL somebody typed to the calendars behind it.
 *
 * Nothing else in this server has a discovery phase, and it earns its own module
 * because it is a state machine with several legitimate shapes rather than one
 * request. The three that actually occur in the wild:
 *
 * - `https://dav.example.net` — a server root. Principal, then home set, then
 *   the collections underneath.
 * - `https://example.net/dav.php/` — Baikal, where the CalDAV endpoint sits
 *   under a path and the well-known route is only present when the vhost was
 *   configured for it. Its absence is normal, not a fault.
 * - `https://dav.example.net/calendars/willi/work/` — a collection URL, pasted
 *   out of a calendar client's settings. Which is what most people actually do,
 *   so it is detected first rather than treated as a mistake.
 */

const HOME_PROPS: readonly PropName[] = [
  'D:resourcetype',
  'D:current-user-principal',
  'C:calendar-home-set',
];

const PRINCIPAL_PROPS: readonly PropName[] = [
  'C:calendar-home-set',
  'C:calendar-user-address-set',
];

const COLLECTION_PROPS: readonly PropName[] = [
  'D:resourcetype',
  'D:displayname',
  'C:calendar-description',
  'C:supported-calendar-component-set',
  'CS:getctag',
  'IC:calendar-color',
  'D:current-user-privilege-set',
];

/** How long a calendar list is reused before it is fetched again. */
const CALENDAR_TTL_MS = 300_000;

/** What discovery established about the account, once per process. */
export interface Principal {
  /** Absolute URL of the principal, when one was found. */
  url: string | undefined;
  /** Absolute URLs of the calendar home sets. */
  homes: readonly string[];
  /**
   * The addresses the user is known by, from `calendar-user-address-set`.
   *
   * Only `mailto:` entries are kept. Radicale answers this property with the
   * principal *path* rather than an address, which is legal and useless here —
   * `respond_to_event` needs something that can match an `ATTENDEE` line, and a
   * path never will. Where this ends up empty, `CALDAV_USER_EMAIL` is the only
   * way that tool can identify the user.
   */
  addresses: readonly string[];
  /** Set when CALDAV_URL turned out to be a calendar collection itself. */
  singleCalendar: boolean;
  /** Anything worth telling the operator about how discovery went. */
  notes: readonly string[];
}

export class Discovery {
  private readonly api: CalDavApi;
  private readonly allowlist: readonly string[];
  private principalPromise: Promise<Principal> | undefined;
  private calendars: { at: number; registry: CalendarRegistry } | undefined;
  private inFlight: Promise<CalendarRegistry> | undefined;
  private warnedUnmatched = false;

  constructor(api: CalDavApi, allowlist: readonly string[]) {
    this.api = api;
    this.allowlist = allowlist;
  }

  /**
   * The principal and its home sets, resolved once per process.
   *
   * Memoised as a promise rather than as a value so that four tool calls
   * arriving together produce one discovery instead of four. Nothing about a
   * principal changes without a reconfiguration, so there is no TTL.
   */
  async principal(): Promise<Principal> {
    this.principalPromise ??= this.discoverPrincipal();
    return this.principalPromise;
  }

  /**
   * The calendar registry.
   *
   * Held for {@link CALENDAR_TTL_MS} because a calendar can be created in
   * another client mid-session, and refetching one Depth:1 PROPFIND is cheap
   * next to answering out of a stale list. `list_calendars` passes
   * `force: true` — being current is that tool's entire job.
   */
  async registry(force = false): Promise<CalendarRegistry> {
    const cached = this.calendars;
    if (
      !force &&
      cached !== undefined &&
      Date.now() - cached.at < CALENDAR_TTL_MS
    ) {
      return cached.registry;
    }
    this.inFlight ??= this.discoverCalendars().finally(() => {
      this.inFlight = undefined;
    });
    return this.inFlight;
  }

  /**
   * A PROPFIND that is allowed to come back with nothing.
   *
   * Each numbered step below is a *guess* about where the DAV endpoint is, and
   * a guess that turns out to be wrong must not end the walk. Pointing
   * CALDAV_URL at `https://example.net` when Baikal serves DAV from
   * `/dav.php/` is the case: the origin answers a PROPFIND with its ordinary
   * HTML page, the DOCTYPE guard refuses it — correctly, that is not a DAV
   * document — and the exception used to escape before the well-known route,
   * which is *precisely* the route RFC 6764 defines for this situation, had
   * been tried. The result was a server that could not find an endpoint it was
   * one redirect away from, and an error message about XML.
   *
   * Only the parse and the status are softened. A network failure, a refused
   * connection or a 401 still throws, because those are not "the endpoint is
   * somewhere else" — they are the answer.
   */
  private async probe(
    url: string
  ): Promise<Awaited<ReturnType<CalDavApi['propfind']>>> {
    try {
      return await this.api.propfind(url, 0, HOME_PROPS);
    } catch (error) {
      if (error instanceof CalDavApiError) throw error;
      return [];
    }
  }

  private async discoverPrincipal(): Promise<Principal> {
    const notes: string[] = [];
    const root = `${this.api.url}/`;

    // 1. Ask the configured URL about itself. This answers the collection case
    //    outright and, on most servers, hands over the principal in the same
    //    round trip.
    const first = await this.probe(root);
    const self = first[0];
    if (
      self !== undefined &&
      resourceTypeHas(self.props.resourcetype, 'calendar')
    ) {
      return {
        url: undefined,
        homes: [],
        addresses: [],
        singleCalendar: true,
        notes: [
          'CALDAV_URL is a calendar collection, so this server sees exactly ' +
            'that one calendar. Point it at the server root to see all of them.',
        ],
      };
    }

    let principalHref = firstHref(self?.props['current-user-principal']);

    // 2. RFC 6764's well-known route, which is defined *as* a redirect. Only
    //    tried when the configured URL did not already answer.
    if (principalHref === undefined) {
      const probe = await this.api.probeWellKnown();
      if (probe.refusedOrigin !== undefined) {
        notes.push(
          `The well-known route redirected to ${probe.refusedOrigin}, which is ` +
            'not the configured server, so it was not followed. If that is ' +
            'the right calendar host, set CALDAV_URL to it.'
        );
      }
      if (probe.url !== undefined) {
        const viaWellKnown = await this.probe(probe.url);
        principalHref = firstHref(
          viaWellKnown[0]?.props['current-user-principal']
        );
      }
    }

    // 3. Some servers answer this property only at the origin root.
    if (principalHref === undefined) {
      const originRoot = `${this.api.origin}/`;
      if (originRoot !== root) {
        const viaOrigin = await this.probe(originRoot);
        principalHref = firstHref(
          viaOrigin[0]?.props['current-user-principal']
        );
      }
    }

    if (principalHref === undefined) {
      notes.push(
        'This server did not report a principal, so CALDAV_URL is being ' +
          'treated as the calendar home set directly.'
      );
      return {
        url: undefined,
        homes: [root],
        addresses: [],
        singleCalendar: false,
        notes,
      };
    }

    const principalUrl = this.api.resolveHref(principalHref, root);

    // 4. The home set, and the addresses the user answers invitations as.
    const onPrincipal = await this.api.propfind(
      principalUrl,
      0,
      PRINCIPAL_PROPS
    );
    const props = onPrincipal[0]?.props ?? {};
    const homes = hrefsOf(props['calendar-home-set']).map((href) =>
      this.api.resolveHref(href, principalUrl)
    );
    const addresses = hrefsOf(props['calendar-user-address-set'])
      .filter((entry) => /^mailto:/i.test(entry))
      .map((entry) => entry.replace(/^mailto:/i, '').toLowerCase());

    if (homes.length === 0) {
      notes.push(
        'The principal named no calendar home set, so CALDAV_URL is being ' +
          'used as the home set.'
      );
    }

    return {
      url: principalUrl,
      homes: homes.length > 0 ? homes : [root],
      addresses,
      singleCalendar: false,
      notes,
    };
  }

  private async discoverCalendars(): Promise<CalendarRegistry> {
    const principal = await this.principal();
    const found: CalendarEntry[] = [];

    if (principal.singleCalendar) {
      const url = `${this.api.url}/`;
      const responses = await this.api.propfind(url, 0, COLLECTION_PROPS);
      const entry = this.toEntry(responses[0], url);
      if (entry !== undefined) found.push(entry);
    } else {
      for (const home of principal.homes) {
        const responses = await this.api.propfind(home, 1, COLLECTION_PROPS);
        for (const response of responses) {
          const entry = this.toEntry(response, home);
          if (entry !== undefined) found.push(entry);
        }
      }
    }

    // Stable order, so two runs of the same listing agree.
    found.sort((left, right) => left.path.localeCompare(right.path));
    const registry = new CalendarRegistry(dedupe(found), this.allowlist);

    // The allowlist is checked here because here is the first moment it can be:
    // its entries are matched against calendars that do not exist until this
    // method has run.
    //
    // An ambiguous entry is refused rather than resolved. Only a bare final
    // segment can be ambiguous, and `work` standing for two different
    // collections is not something to settle by picking one — either choice
    // silently grants access to a collection the operator may not have meant,
    // and the failure would be invisible because the server would carry on
    // working. Refusing costs a startup error; guessing costs a fence.
    const ambiguous = registry.ambiguous();
    if (ambiguous.length > 0) {
      throw new AllowlistError(
        `caldav-mcp: CALDAV_CALENDARS cannot be applied as written. ` +
          ambiguous
            .map(
              ({ entry, paths }) =>
                `"${entry}" matches ${paths.length} calendars (${paths.join(', ')})`
            )
            .join('; ') +
          '. Name those calendars by full path instead of by their last segment.'
      );
    }

    // An entry matching nothing is a warning, not an error: it is usually a
    // typo, but it is also what a calendar that was deleted upstream looks
    // like, and refusing to start over a stale name would be worse than saying
    // so. Once per process — the registry is rebuilt whenever the cache
    // expires, and the same warning on a loop teaches people to ignore it.
    if (!this.warnedUnmatched) {
      const unmatched = registry.unmatched();
      if (unmatched.length > 0) {
        this.warnedUnmatched = true;
        console.error(
          `caldav-mcp: CALDAV_CALENDARS names ${unmatched.length} entr` +
            `${unmatched.length === 1 ? 'y' : 'ies'} matching no calendar on ` +
            `this account: ${unmatched.join(', ')}. Check the spelling — an ` +
            `entry that matches nothing grants nothing.`
        );
      }
    }

    this.calendars = { at: Date.now(), registry };
    return registry;
  }

  /**
   * Turns one multistatus response into a calendar, or into nothing.
   *
   * The filter is where the collections that are *not* calendars get dropped:
   * the home collection itself, an addressbook on a server that hosts both, and
   * the scheduling inbox and outbox. The last two are a deliberate omission with
   * a visible consequence — an invitation sitting unprocessed in the inbox is
   * invisible to this server — and it is written down in the README under
   * "Not exposed, on purpose" rather than left for someone to discover.
   */
  private toEntry(
    response: { href: string; props: Record<string, unknown> } | undefined,
    relativeTo: string
  ): CalendarEntry | undefined {
    if (response === undefined) return undefined;
    const type = response.props.resourcetype;
    if (!resourceTypeHas(type, 'calendar')) return undefined;
    if (
      resourceTypeHas(type, 'schedule-inbox') ||
      resourceTypeHas(type, 'schedule-outbox') ||
      resourceTypeHas(type, 'addressbook') ||
      resourceTypeHas(type, 'notification')
    ) {
      return undefined;
    }

    let url: string;
    try {
      url = this.api.resolveHref(response.href, relativeTo);
    } catch {
      // A cross-origin href in a listing is not worth failing the whole
      // discovery over; the calendar is simply not reachable from here.
      return undefined;
    }
    const path = normalisePath(new URL(url).pathname);
    const granted = privileges(response.props['current-user-privilege-set']);
    return {
      url: `${url.replace(/\/+$/, '')}/`,
      path,
      displayName: textOf(response.props.displayname),
      description: textOf(response.props['calendar-description']),
      components: supportedComponents(
        response.props['supported-calendar-component-set']
      ),
      ctag: textOf(response.props.getctag),
      color: textOf(response.props['calendar-color']),
      // Absent privileges mean the server did not say, which is not the same as
      // "no write" — assuming read-only there would refuse every write on a
      // server that simply does not report the property.
      readOnly:
        granted.length > 0 &&
        !granted.some((privilege) =>
          ['write', 'write-content', 'all', 'bind'].includes(privilege)
        ),
    };
  }
}

function firstHref(prop: unknown): string | undefined {
  return hrefsOf(prop)[0];
}

/**
 * One entry per path.
 *
 * Where a server reports the same collection twice with different privilege
 * sets, the *stricter* answer wins: `readOnly` is a guard on this side, and a
 * guard decided by document order is a guard the server chooses. A write to a
 * collection that is in fact writable is refused with a sentence; a write to
 * one that is not would have been refused by the server anyway.
 */
function dedupe(entries: readonly CalendarEntry[]): CalendarEntry[] {
  const byPath = new Map<string, CalendarEntry>();
  for (const entry of entries) {
    const existing = byPath.get(entry.path);
    if (existing === undefined) {
      byPath.set(entry.path, entry);
    } else if (entry.readOnly && !existing.readOnly) {
      byPath.set(entry.path, { ...existing, readOnly: true });
    }
  }
  return [...byPath.values()];
}
