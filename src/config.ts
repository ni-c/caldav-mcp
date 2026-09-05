import { internalHostKind } from 'mcp-internal-hosts';

import { redactUrlCredentials } from './redact.js';

/** Default number of entries a listing returns when the caller does not say. */
export const DEFAULT_MAX_ENTRIES = 100;

/**
 * Hard ceiling on `CALDAV_MAX_EVENTS`, and on the `limit` any listing accepts.
 *
 * Expanding a recurrence is work this server does, not the server it talks to, so
 * this is a bound on this process rather than a politeness towards the backend.
 */
export const MAX_MAX_ENTRIES = 500;

export interface Config {
  /**
   * Root of the CalDAV server, e.g. `https://dav.example.net` — discovery walks
   * from here to the principal and the calendar home set. A collection URL is
   * accepted too and short-circuits discovery to that one calendar.
   *
   * May be undefined together with the credentials: the server still starts and
   * lists its tools, and every call then fails with {@link missingConfigMessage}.
   */
  url: string | undefined;
  username: string | undefined;
  password: string | undefined;
  /**
   * Bearer token, as an alternative to username/password. Mutually exclusive
   * with them — a configuration carrying both is refused at startup rather than
   * silently preferring one, because which one was meant is not knowable and the
   * wrong guess authenticates as somebody else.
   */
  token: string | undefined;
  /**
   * The address the user is known by in an `ATTENDEE` line, for `respond_to_event`.
   *
   * Optional, and the fallback is the principal's `calendar-user-address-set` —
   * but that fallback does not always yield an address: Radicale answers it with
   * the principal *path*, not a `mailto:` URI. Where neither produces exactly one
   * matching attendee, `respond_to_event` refuses rather than guessing which of
   * several people the operator is.
   */
  userEmail: string | undefined;
  /**
   * Calendars this server may touch at all, as URLs, absolute paths or final
   * path segments. Empty array means "every calendar the credentials can see".
   *
   * Display names are deliberately NOT accepted: on a shared calendar the name is
   * chosen by whoever shared it, it is not unique, and it changes. An allowlist
   * keyed on a mutable, externally-controlled string is not an allowlist.
   */
  calendars: readonly string[];
  /**
   * IANA zone used for an input that names no offset and no zone, and for
   * rendering a floating time. Validated at startup — a typo here silently shifts
   * every timestamp the server writes, which is invisible until somebody misses a
   * meeting.
   */
  timezone: string;
  /** Entries a listing returns when the caller passes no `limit`. */
  maxEntries: number;
  insecureTls: boolean;
  readOnly: boolean;
  /**
   * Whether a client that *can* show a dialog is asked before a guarded tool
   * acts. `ELICITATION=false` turns the dialog off — the guard stays and falls
   * back to the two-call token, so there is no setting in which a guarded call
   * goes unannounced.
   */
  elicitation: boolean;
  /**
   * Raw value of `CALDAV_ALLOW_TOOLS` — comma-separated tool names, a prefix with
   * one trailing `*`, or `essential`. Kept unparsed on purpose: this file mirrors
   * the environment, and the names can only be checked against the tool
   * catalogue, which `buildToolFilter` does.
   */
  allowTools: string | undefined;
  /** Raw value of `CALDAV_DENY_TOOLS`, same shape, subtracted from the above. */
  denyTools: string | undefined;
}

/** Shown when the configuration is incomplete — at startup and on every call. */
export function missingConfigMessage(missing: string[]): string {
  return (
    `missing required environment variable(s): ${missing.join(', ')}\n` +
    'Required: CALDAV_URL (e.g. https://dav.example.net), and either ' +
    'CALDAV_USERNAME + CALDAV_PASSWORD or CALDAV_TOKEN.\n' +
    'CALDAV_URL is the root of the CalDAV server, not a single calendar — the ' +
    'principal and the calendar home set are discovered from it. A calendar ' +
    'collection URL works too and limits the server to that one calendar.\n' +
    'Most hosted services want an app-specific password rather than the account ' +
    'password: Nextcloud, Fastmail and iCloud all issue one per application.\n' +
    'Optional: CALDAV_CALENDARS to fence the server to named calendars, ' +
    'CALDAV_TIMEZONE for inputs that carry no zone, CALDAV_USER_EMAIL so ' +
    'respond_to_event can find your own attendee line, CALDAV_MAX_EVENTS, ' +
    'CALDAV_READ_ONLY=true to expose only the read tools, ' +
    'CALDAV_ALLOW_TOOLS / CALDAV_DENY_TOOLS to narrow the tool list, ' +
    'CALDAV_INSECURE_TLS=true to accept self-signed certificates, ' +
    'CALDAV_ALLOW_PLAINTEXT=true to allow a plain http:// URL to a host that ' +
    'is not loopback'
  );
}

/** Names of the required environment variables that are unset in `config`. */
export function missingConfigKeys(config: Config): string[] {
  const missing: string[] = [];
  if (!config.url) missing.push('CALDAV_URL');
  if (!config.token && !(config.username && config.password)) {
    missing.push('CALDAV_USERNAME + CALDAV_PASSWORD (or CALDAV_TOKEN)');
  }
  return missing;
}

/**
 * Reads `ELICITATION` — deliberately unprefixed, and deliberately fatal on
 * anything it does not recognise.
 *
 * Unprefixed: environment variables are process-wide, so this is one switch for
 * every server in the same environment. That is also its risk, which is why a
 * server started with it off says so on its startup line.
 *
 * Fatal: this is the one variable of the family that defaults to *on*. The others
 * fail open on a typo, which is the safe direction for them. Here a typo would
 * leave the dialog running while the operator believes it is off — and an
 * operator who believes that has no way to find out.
 */
export function parseElicitation(raw: string | undefined): boolean {
  const value = raw?.trim().toLowerCase();
  if (value === undefined || value === '' || value === 'true') return true;
  if (value === 'false') return false;
  console.error(
    `caldav-mcp: ELICITATION must be "true" or "false" — got "${raw}". ` +
      'Refusing to start rather than guess.'
  );
  process.exit(1);
}

/**
 * Reads a switch that turns a protection *on*, and reads it tolerantly.
 *
 * `CALDAV_READ_ONLY=1` in a Docker Compose file, `=yes` from a shell script,
 * `=TRUE` from a Windows environment, a trailing space from a copied `.env` line:
 * an `=== 'true'` comparison answers all four with a server that quietly exposes
 * every write tool. The operator asked for the guard and does not find out that
 * they did not get it — exactly the failure a protection switch must not have.
 *
 * The direction decides the strictness, not the variable. A switch that *lifts* a
 * protection is compared strictly, so a typo leaves the protection in place; see
 * `CALDAV_INSECURE_TLS` below.
 */
function isEnabled(raw: string | undefined): boolean {
  return /^(1|true|yes)$/i.test(raw?.trim() ?? '');
}

/**
 * Splits a comma-separated list, dropping empty entries.
 *
 * An empty-but-set `CALDAV_CALENDARS` is caught by the caller rather than here:
 * "set to nothing" is a plausible way to mean "no calendars at all", and a server
 * that answers that by opening every calendar is the one outcome nobody wants.
 */
function splitList(raw: string | undefined): string[] {
  return (raw ?? '')
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

/**
 * Refuses a zone name Node cannot resolve.
 *
 * `Intl.DateTimeFormat` throws a RangeError for an unknown IANA id, which is the
 * only check available without shipping a zone database. It is worth making
 * fatal: an unrecognised zone would otherwise be treated as floating time and
 * every timestamp this server writes would land in the wrong hour, silently.
 */
function assertKnownTimezone(zone: string): void {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: zone });
  } catch {
    console.error(
      `caldav-mcp: CALDAV_TIMEZONE is not an IANA time zone name: "${zone}". ` +
        'Expected something like "Europe/Berlin" or "UTC".'
    );
    process.exit(1);
  }
}

function parseMaxEntries(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === '') return DEFAULT_MAX_ENTRIES;
  const value = Number(raw.trim());
  if (!Number.isInteger(value) || value < 1 || value > MAX_MAX_ENTRIES) {
    console.error(
      `caldav-mcp: CALDAV_MAX_EVENTS must be an integer between 1 and ` +
        `${MAX_MAX_ENTRIES} — got "${raw}".`
    );
    process.exit(1);
  }
  return value;
}

/**
 * Reads the configuration from environment variables.
 *
 * Missing credentials are only a warning, not a fatal error: the server must be
 * able to complete the MCP handshake and answer `tools/list` without them, so
 * registries and sandbox inspectors can introspect it. A malformed URL still
 * exits — that one could send the credentials to the wrong host.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const url = env.CALDAV_URL;
  const username = env.CALDAV_USERNAME;
  const password = env.CALDAV_PASSWORD;
  const token = env.CALDAV_TOKEN;
  const userEmail = env.CALDAV_USER_EMAIL?.trim() || undefined;
  const rawCalendars = env.CALDAV_CALENDARS;
  const timezone = env.CALDAV_TIMEZONE?.trim() || 'UTC';
  const rawMaxEntries = env.CALDAV_MAX_EVENTS;
  // Strict, and right to be: this one *removes* a protection, so anything the
  // operator did not spell exactly has to leave certificate checking on.
  const insecureTls = env.CALDAV_INSECURE_TLS === 'true';
  const readOnly = isEnabled(env.CALDAV_READ_ONLY);
  const allowTools = env.CALDAV_ALLOW_TOOLS;
  const denyTools = env.CALDAV_DENY_TOOLS;

  const missing: string[] = [];
  if (!url) missing.push('CALDAV_URL');
  if (!token && !(username && password)) {
    missing.push('CALDAV_USERNAME + CALDAV_PASSWORD (or CALDAV_TOKEN)');
  }
  if (missing.length > 0) {
    console.error(`caldav-mcp: ${missingConfigMessage(missing)}`);
  }

  // Don't keep the credentials in the environment for the process lifetime —
  // they are visible to child processes and in /proc/<pid>/environ. Before
  // every branch that can exit or return, deliberately: an exit above this
  // line would leave them there for whatever runs next.
  //
  // The username goes with them. It is half of a credential rather than a
  // secret in its own right, and leaving it behind is the kind of asymmetry
  // that reads as "this one was judged harmless" when it was really just
  // forgotten. Nothing reads it again: it has been copied into the config.
  delete env.CALDAV_PASSWORD;
  delete env.CALDAV_TOKEN;
  delete env.CALDAV_USERNAME;

  const elicitation = parseElicitation(env.ELICITATION);

  if (token && (username || password)) {
    console.error(
      'caldav-mcp: set either CALDAV_TOKEN or CALDAV_USERNAME + CALDAV_PASSWORD, ' +
        'not both. Which one was meant is not knowable from here, and the wrong ' +
        'guess authenticates as somebody else.'
    );
    process.exit(1);
  }

  // Set but empty is a refusal, not an omission. Whoever wrote
  // `CALDAV_CALENDARS=` in a compose file meant to restrict something, and
  // answering that by exposing every calendar is the one wrong outcome.
  if (rawCalendars !== undefined && rawCalendars.trim() === '') {
    console.error(
      'caldav-mcp: CALDAV_CALENDARS is set but empty. Remove the variable to ' +
        'allow every calendar, or name the calendars to allow.'
    );
    process.exit(1);
  }
  const calendars = splitList(rawCalendars);

  assertKnownTimezone(timezone);
  const maxEntries = parseMaxEntries(rawMaxEntries);

  const base: Omit<Config, 'url'> = {
    username,
    password,
    token,
    userEmail,
    calendars,
    timezone,
    maxEntries,
    insecureTls,
    readOnly,
    elicitation,
    allowTools,
    denyTools,
  };

  if (!url) return { url: undefined, ...base };

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    // Redacted, and deliberately so: the userinfo check below only runs once the
    // URL parses, so a value that does not parse at all but still carries
    // credentials — "https://admin:s3cret@host:99999", an out-of-range port —
    // would otherwise print the password into the MCP client's log file.
    console.error(
      `caldav-mcp: CALDAV_URL is not a valid URL: ${redactUrlCredentials(url)}`
    );
    process.exit(1);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    console.error(
      `caldav-mcp: CALDAV_URL must use http:// or https:// (got ${parsed.protocol})`
    );
    process.exit(1);
  }
  // Credentials embedded in the URL would end up in logs and error messages.
  if (parsed.username || parsed.password) {
    console.error(
      'caldav-mcp: CALDAV_URL must not contain credentials — use ' +
        'CALDAV_USERNAME and CALDAV_PASSWORD, or CALDAV_TOKEN'
    );
    process.exit(1);
  }
  // Plain http to anything but loopback puts the password on the wire in
  // clear on every request. That used to be a warning on stderr, which in a
  // stdio deployment is a line nobody reads. It is now a refusal, lifted by a
  // switch that is read strictly like every other switch that removes a
  // protection — the same shape as CALDAV_INSECURE_TLS, for the same reason.
  if (parsed.protocol === 'http:' && !isLoopbackHost(parsed.hostname)) {
    if (env.CALDAV_ALLOW_PLAINTEXT !== 'true') {
      console.error(
        'caldav-mcp: CALDAV_URL uses plain http to a non-local host, so the ' +
          'credentials would be sent unencrypted on every request. Use ' +
          'https://, or set CALDAV_ALLOW_PLAINTEXT=true if this network is ' +
          'trusted end to end. Refusing to start.'
      );
      process.exit(1);
    }
    console.error(
      'caldav-mcp: WARNING: CALDAV_URL uses plain http to a non-local host — ' +
        'the credentials are sent unencrypted (CALDAV_ALLOW_PLAINTEXT=true).'
    );
  }

  // A query or a fragment on the root URL has no meaning to discovery and a
  // real cost: relative hrefs are resolved against the URL, and `?x=1/`
  // spliced onto the end of it turns `/dav?x=1/work/` into `/work/` — every
  // request then lands on the wrong path of the right host.
  if (parsed.search !== '' || parsed.hash !== '') {
    console.error(
      'caldav-mcp: CALDAV_URL must not carry a query string or a fragment. ' +
        'Give the root of the CalDAV server, e.g. https://dav.example.net or ' +
        'https://host/dav.php.'
    );
    process.exit(1);
  }

  warnAboutUnencodedPaths(calendars);

  // Keep the path, drop only trailing slashes: a CALDAV_URL of
  // https://host/dav.php is a real and common shape (Baikal), and stripping the
  // path would send discovery to a root that answers 404.
  return { url: url.replace(/\/+$/, ''), ...base };
}

/**
 * An allowlist entry written as an absolute path is compared against the
 * collection's *pathname*, which is percent-encoded. `/cal/a b/` therefore
 * matches nothing, and the only symptom is the "matches no calendar" warning
 * at discovery, which points at a typo that is not there. Said once, here,
 * where the entry is read.
 */
function warnAboutUnencodedPaths(entries: readonly string[]): void {
  const suspect = entries.filter(
    (entry) => entry.startsWith('/') && /[\s"<>`{|}]|[^\x20-\x7e]/.test(entry)
  );
  if (suspect.length === 0) return;
  console.error(
    `caldav-mcp: CALDAV_CALENDARS entr${suspect.length === 1 ? 'y' : 'ies'} ` +
      `${suspect.map((entry) => `"${entry}"`).join(', ')} contain${
        suspect.length === 1 ? 's' : ''
      } characters that appear percent-encoded in a calendar path, so ` +
      'the entry will match nothing as written. Write the path the way ' +
      'list_calendars prints it (e.g. %20 for a space), or use the final ' +
      'path segment instead.'
  );
}

/**
 * There is no `src/hosts.ts` in this server, on purpose.
 *
 * The fleet's SSRF guard exists where a tool hands the backend a URL that the
 * backend then fetches. Nothing here does: an event's `ATTACH` URL is reported as
 * metadata and never retrieved, and every URL this server requests came out of
 * its own discovery and is pinned to the configured origin in `api.ts`. The
 * classifier is still a dependency, for exactly the one use below.
 */
function isLoopbackHost(hostname: string): boolean {
  // Same classifier the fleet's SSRF guard uses, so a loopback URL written as
  // http://[::1]:5232 or http://[::ffff:127.0.0.1]:5232 is recognised here too
  // and the plain-http warning does not fire on it.
  return internalHostKind(hostname) === 'loopback';
}
