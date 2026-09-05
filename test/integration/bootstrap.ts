import { assertLoopback, waitForHttp } from 'mcp-integration-harness';

/**
 * From an empty container to a usable CalDAV account.
 *
 * The bootstrap is allowed to do what the server is not: it creates the
 * calendars with MKCALENDAR over the wire. That asymmetry is deliberate —
 * caldav-mcp has no `mkcalendar` verb at all, so the suite cannot lean on a
 * capability the server is documented not to have.
 */

export const USER = 'integration';
export const PASSWORD = 'integration-not-a-secret';
export const EMAIL = 'integration@example.net';

/** Two are allowed, one is not: the withheld path stays live for every test. */
export const ALLOWED_CALENDARS = ['work', 'private'] as const;
export const FORBIDDEN_CALENDAR = 'shared';

const AUTH = `Basic ${Buffer.from(`${USER}:${PASSWORD}`).toString('base64')}`;

export interface Sandbox {
  url: string;
  /** The environment for the server under test. Nothing else is inherited. */
  env: Record<string, string>;
  /** Path of each calendar, keyed by its short name. */
  paths: Record<string, string>;
}

async function dav(
  url: string,
  method: string,
  options: { body?: string; headers?: Record<string, string> } = {}
): Promise<Response> {
  return fetch(url, {
    method,
    headers: {
      Authorization: AUTH,
      ...(options.body === undefined
        ? {}
        : { 'Content-Type': 'application/xml; charset=utf-8' }),
      ...options.headers,
    },
    ...(options.body === undefined ? {} : { body: options.body }),
    redirect: 'manual',
    signal: AbortSignal.timeout(20_000),
  });
}

function mkcalendarBody(name: string): string {
  return `<?xml version="1.0" encoding="utf-8"?>
<C:mkcalendar xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav">
  <D:set><D:prop>
    <D:displayname>${name}</D:displayname>
    <C:supported-calendar-component-set>
      <C:comp name="VEVENT"/><C:comp name="VTODO"/><C:comp name="VJOURNAL"/>
    </C:supported-calendar-component-set>
  </D:prop></D:set>
</C:mkcalendar>`;
}

/**
 * Brings the Radicale sandbox to a usable state.
 *
 * `assertLoopback` throws rather than skipping. A skipped test reads as
 * "nothing to do here" at precisely the moment the reason is "this was pointed
 * at something real", and this suite calls every delete the server has.
 */
export async function bootstrapRadicale(
  url = 'http://127.0.0.1:5232'
): Promise<Sandbox> {
  assertLoopback(url);
  await waitForHttp(url, { timeoutSeconds: 120 });

  const home = `${url}/${USER}/`;
  const paths: Record<string, string> = {};

  for (const name of [...ALLOWED_CALENDARS, FORBIDDEN_CALENDAR]) {
    const collection = `${home}${name}/`;
    const response = await dav(collection, 'MKCALENDAR', {
      body: mkcalendarBody(name),
    });
    // 405 means it is already there, which is fine on a re-run against a stack
    // somebody forgot to tear down. Anything else is a real failure and worth
    // reporting with the body, since Radicale explains itself.
    if (![201, 405].includes(response.status)) {
      throw new Error(
        `MKCALENDAR ${collection} answered ${response.status}: ${(
          await response.text()
        ).slice(0, 500)}`
      );
    }
    paths[name] = `/${USER}/${name}/`;
  }

  return {
    url,
    paths,
    env: {
      CALDAV_URL: url,
      CALDAV_USERNAME: USER,
      CALDAV_PASSWORD: PASSWORD,
      // Radicale answers calendar-user-address-set with the principal *path*
      // rather than a mailto: URI, so respond_to_event has nothing to match an
      // attendee against without this. Verified against 3.8.0.0.
      CALDAV_USER_EMAIL: EMAIL,
      CALDAV_CALENDARS: ALLOWED_CALENDARS.join(','),
      CALDAV_TIMEZONE: 'Europe/Berlin',
      CALDAV_READ_ONLY: 'false',
    },
  };
}

/**
 * Puts an entry into a calendar without going through the server under test.
 *
 * Used to seed fixtures the tools then read, and — more importantly — to read a
 * resource back afterwards. An assertion that goes through this server's own
 * shaping only proves the server agrees with itself; reading the raw `.ics` is
 * what proves an RRULE, an alarm or an attendee really survived a write.
 */
export async function putRaw(
  sandbox: Sandbox,
  calendar: string,
  name: string,
  ics: string
): Promise<void> {
  const url = `${sandbox.url}${sandbox.paths[calendar] ?? ''}${name}`;
  const response = await dav(url, 'PUT', {
    body: ics,
    headers: { 'Content-Type': 'text/calendar; charset=utf-8' },
  });
  if (response.status >= 400) {
    throw new Error(
      `PUT ${url} answered ${response.status}: ${(await response.text()).slice(0, 500)}`
    );
  }
}

/** Reads a resource back as stored, bypassing the server under test. */
export async function getRaw(
  sandbox: Sandbox,
  calendar: string,
  name: string
): Promise<{ status: number; ics: string }> {
  const url = `${sandbox.url}${sandbox.paths[calendar] ?? ''}${name}`;
  const response = await dav(url, 'GET');
  return { status: response.status, ics: await response.text() };
}

/** Every resource name in a calendar, straight from the server. */
export async function listRaw(
  sandbox: Sandbox,
  calendar: string
): Promise<string[]> {
  const url = `${sandbox.url}${sandbox.paths[calendar] ?? ''}`;
  const response = await dav(url, 'PROPFIND', {
    headers: { Depth: '1' },
    body:
      '<?xml version="1.0" encoding="utf-8"?>' +
      '<D:propfind xmlns:D="DAV:"><D:prop><D:getetag/></D:prop></D:propfind>',
  });
  const body = await response.text();
  return [...body.matchAll(/<[a-z]*:?href>([^<]+)<\/[a-z]*:?href>/gi)]
    .map((match) => (match[1] ?? '').split('/').filter(Boolean).pop() ?? '')
    .filter((name) => name.endsWith('.ics'));
}
