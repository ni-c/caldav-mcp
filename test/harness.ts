import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { expect, vi } from 'vitest';

import type { Config } from '../src/config.js';
import { createServer } from '../src/server.js';

/**
 * A CalDAV server small enough to keep in a variable.
 *
 * The unit suites need a backend that answers real multistatus XML, because the
 * parser, the discovery walk and the ETag handling are most of what there is to
 * get wrong. Stubbing `fetch` per test with hand-written responses would mean
 * writing that XML dozens of times and getting it subtly different each time;
 * this answers it once, from state, the way a server does.
 *
 * What it is **not** is a replacement for the integration suite. It agrees with
 * this server's understanding of CalDAV by construction — the three defects the
 * first integration run found were all cases where that understanding was wrong,
 * and no fake could have caught them. It exists so the *other* thousand paths —
 * argument validation, shaping, budgets, refusals — can be tested without Docker.
 */

export const ORIGIN = 'https://dav.example.net';
export const USER = 'tester';

/** One stored resource. */
interface Stored {
  ics: string;
  etag: string;
}

export interface FakeCalendar {
  name: string;
  displayName?: string;
  components?: string[];
  readOnly?: boolean;
  resources?: Record<string, string>;
}

export interface FakeOptions {
  calendars?: FakeCalendar[];
  /** Answer `calendar-user-address-set` with a mailto:, as sabre/dav does. */
  addresses?: string[];
  /** Emit sabre/dav's lowercase prefixes instead of Radicale's default namespace. */
  prefixes?: 'radicale' | 'sabre';
  /** Refuse a text-match query, as some builds do without a collation. */
  refuseCollation?: boolean;
  /** Refuse a free-busy query, so the computed fallback is exercised. */
  refuseFreeBusy?: boolean;
}

export class FakeCalDav {
  readonly calendars = new Map<
    string,
    { entry: FakeCalendar; resources: Map<string, Stored> }
  >();
  readonly requests: { method: string; url: string; body?: string }[] = [];
  private sequence = 0;
  private readonly options: FakeOptions;

  constructor(options: FakeOptions = {}) {
    this.options = options;
    for (const calendar of options.calendars ?? [
      { name: 'work', displayName: 'Work' },
      { name: 'private', displayName: 'Private' },
    ]) {
      const resources = new Map<string, Stored>();
      for (const [name, ics] of Object.entries(calendar.resources ?? {})) {
        resources.set(name, { ics, etag: this.nextEtag() });
      }
      this.calendars.set(`/${USER}/${calendar.name}/`, {
        entry: calendar,
        resources,
      });
    }
  }

  private nextEtag(): string {
    this.sequence += 1;
    return `"etag-${this.sequence}"`;
  }

  /** Puts a resource in place without going through the server under test. */
  seed(calendar: string, name: string, ics: string): void {
    const store = this.calendars.get(`/${USER}/${calendar}/`);
    if (store === undefined) throw new Error(`no calendar ${calendar}`);
    store.resources.set(name, { ics, etag: this.nextEtag() });
  }

  /** Reads a resource back as stored. */
  stored(calendar: string, name: string): string | undefined {
    return this.calendars.get(`/${USER}/${calendar}/`)?.resources.get(name)
      ?.ics;
  }

  /** Every resource name in a calendar. */
  names(calendar: string): string[] {
    return [
      ...(this.calendars.get(`/${USER}/${calendar}/`)?.resources.keys() ?? []),
    ];
  }

  /** Installs this fake as the global `fetch`. */
  install(): void {
    vi.stubGlobal('fetch', (input: string | URL, init?: RequestInit) =>
      this.handle(String(input), init ?? {})
    );
  }

  private tag(local: string): string {
    return this.options.prefixes === 'sabre'
      ? local.replace(/^D:/, 'd:').replace(/^C:/, 'cal:')
      : local.replace(/^D:/, '');
  }

  private envelope(inner: string): string {
    const attrs =
      this.options.prefixes === 'sabre'
        ? 'xmlns:d="DAV:" xmlns:cal="urn:ietf:params:xml:ns:caldav" xmlns:cs="http://calendarserver.org/ns/"'
        : 'xmlns="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav" xmlns:CS="http://calendarserver.org/ns/"';
    const open = this.tag('D:multistatus');
    return `<?xml version="1.0" encoding="utf-8"?>\n<${open} ${attrs}>${inner}</${open}>`;
  }

  private response(href: string, ok: string, notFound = ''): string {
    const r = this.tag('D:response');
    const h = this.tag('D:href');
    const ps = this.tag('D:propstat');
    const pr = this.tag('D:prop');
    const st = this.tag('D:status');
    const missing =
      notFound === ''
        ? ''
        : `<${ps}><${pr}>${notFound}</${pr}><${st}>HTTP/1.1 404 Not Found</${st}></${ps}>`;
    return (
      `<${r}><${h}>${href}</${h}>` +
      `<${ps}><${pr}>${ok}</${pr}><${st}>HTTP/1.1 200 OK</${st}></${ps}>` +
      `${missing}</${r}>`
    );
  }

  private reply(
    status: number,
    body = '',
    headers: Record<string, string> = {}
  ) {
    // 204/205/304 are null-body statuses: `new Response('')` throws for them,
    // and an empty string is not null.
    const payload = [204, 205, 304].includes(status) ? null : body;
    return new Response(payload, {
      status,
      headers: {
        'content-type': body.startsWith('<?xml')
          ? 'application/xml; charset=utf-8'
          : 'text/plain',
        ...headers,
      },
    });
  }

  private async handle(url: string, init: RequestInit): Promise<Response> {
    const method = (init.method ?? 'GET').toUpperCase();
    const body = typeof init.body === 'string' ? init.body : undefined;
    const path = new URL(url).pathname;
    this.requests.push({
      method,
      url,
      ...(body === undefined ? {} : { body }),
    });

    if (new URL(url).origin !== ORIGIN) {
      throw new Error(`the fake was asked for ${url}, which is another origin`);
    }

    if (method === 'OPTIONS') {
      return this.reply(200, '', {
        dav: '1, 2, 3, calendar-access',
        allow: 'GET, PUT, DELETE, PROPFIND, REPORT, OPTIONS',
      });
    }

    if (method === 'PROPFIND') return this.propfind(path, init, body ?? '');
    if (method === 'REPORT') return this.report(path, body ?? '');
    if (method === 'GET') return this.get(path);
    if (method === 'PUT') return this.put(path, init, body ?? '');
    if (method === 'DELETE') return this.del(path, init);
    return this.reply(405, 'method not allowed');
  }

  private propfind(path: string, init: RequestInit, body: string): Response {
    const depth = String(
      (init.headers as Record<string, string> | undefined)?.Depth ?? '0'
    );

    if (path === '/.well-known/caldav') {
      return this.reply(301, '', { location: '/' });
    }
    if (path === '/' && body.includes('current-user-principal')) {
      const cup = this.tag('D:current-user-principal');
      const h = this.tag('D:href');
      return this.reply(
        207,
        this.envelope(
          this.response('/', `<${cup}><${h}>/${USER}/</${h}></${cup}>`)
        )
      );
    }
    if (path === `/${USER}/` && body.includes('calendar-home-set')) {
      const home =
        this.options.prefixes === 'sabre'
          ? 'cal:calendar-home-set'
          : 'C:calendar-home-set';
      const addr =
        this.options.prefixes === 'sabre'
          ? 'cal:calendar-user-address-set'
          : 'C:calendar-user-address-set';
      const h = this.tag('D:href');
      const addresses = (this.options.addresses ?? [])
        .map((a) => `<${h}>mailto:${a}</${h}>`)
        .join('');
      return this.reply(
        207,
        this.envelope(
          this.response(
            `/${USER}/`,
            `<${home}><${h}>/${USER}/</${h}></${home}>` +
              `<${addr}>${addresses}</${addr}>`
          )
        )
      );
    }
    if (path === `/${USER}/` && depth === '1') {
      const parts = [
        this.response(
          `/${USER}/`,
          `<${this.tag('D:resourcetype')}><${this.tag('D:collection')}/></${this.tag('D:resourcetype')}>`
        ),
      ];
      for (const [calendarPath, store] of this.calendars) {
        parts.push(this.calendarResponse(calendarPath, store.entry));
      }
      return this.reply(207, this.envelope(parts.join('')));
    }
    if (this.calendars.has(path) && depth === '0') {
      const store = this.calendars.get(path);
      if (store !== undefined) {
        return this.reply(
          207,
          this.envelope(this.calendarResponse(path, store.entry))
        );
      }
    }
    return this.reply(404, 'not found');
  }

  private calendarResponse(path: string, entry: FakeCalendar): string {
    const rt = this.tag('D:resourcetype');
    const coll = this.tag('D:collection');
    const cal =
      this.options.prefixes === 'sabre' ? 'cal:calendar' : 'C:calendar';
    const dn = this.tag('D:displayname');
    const comps =
      this.options.prefixes === 'sabre'
        ? 'cal:supported-calendar-component-set'
        : 'C:supported-calendar-component-set';
    const comp = this.options.prefixes === 'sabre' ? 'cal:comp' : 'C:comp';
    const privset = this.tag('D:current-user-privilege-set');
    const priv = this.tag('D:privilege');
    const components = entry.components ?? ['VEVENT', 'VTODO', 'VJOURNAL'];
    const privileges =
      entry.readOnly === true
        ? `<${priv}><${this.tag('D:read')}/></${priv}>`
        : `<${priv}><${this.tag('D:read')}/></${priv}><${priv}><${this.tag('D:write')}/></${priv}>`;
    return this.response(
      path,
      `<${rt}><${coll}/><${cal}/></${rt}>` +
        `<${dn}>${entry.displayName ?? entry.name}</${dn}>` +
        `<${comps}>${components.map((c) => `<${comp} name="${c}"/>`).join('')}</${comps}>` +
        `<${privset}>${privileges}</${privset}>`
    );
  }

  private report(path: string, body: string): Response {
    const store = this.calendars.get(path);
    if (store === undefined) return this.reply(404, 'not found');

    if (body.includes('free-busy-query')) {
      if (this.options.refuseFreeBusy === true) {
        return this.reply(
          403,
          '<?xml version="1.0"?><D:error xmlns:D="DAV:"><D:supported-report/></D:error>'
        );
      }
      const periods = [...store.resources.values()]
        .flatMap((resource) => [
          ...resource.ics.matchAll(/^DTSTART[^:]*:(\d{8}T\d{6}Z)/gm),
        ])
        .map((match) => match[1] ?? '');
      const blocks = periods
        .map(
          (start) =>
            `BEGIN:VFREEBUSY\r\nDTSTART:${start}\r\nDTEND:${start}\r\nFBTYPE:BUSY\r\nEND:VFREEBUSY`
        )
        .join('\r\n');
      return this.reply(
        200,
        `BEGIN:VCALENDAR\r\nVERSION:2.0\r\n${blocks}\r\nEND:VCALENDAR\r\n`,
        { 'content-type': 'text/calendar; charset=utf-8' }
      );
    }

    const match = /<C:text-match[^>]*>([\s\S]*?)<\/C:text-match>/.exec(body);
    if (
      match !== null &&
      this.options.refuseCollation === true &&
      !body.includes('collation=')
    ) {
      return this.reply(
        403,
        '<?xml version="1.0"?><D:error xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav"><C:supported-collation/></D:error>'
      );
    }
    const term = match?.[1]?.toLowerCase();
    const componentMatch = /<C:comp-filter name="(VEVENT|VTODO|VJOURNAL)"/.exec(
      body
    );
    const component = componentMatch?.[1] ?? 'VEVENT';

    const parts: string[] = [];
    for (const [name, resource] of store.resources) {
      if (!resource.ics.includes(`BEGIN:${component}`)) continue;
      if (term !== undefined && !resource.ics.toLowerCase().includes(term))
        continue;
      const etag = this.tag('D:getetag');
      const cdata =
        this.options.prefixes === 'sabre'
          ? 'cal:calendar-data'
          : 'C:calendar-data';
      parts.push(
        this.response(
          `${path}${name}`,
          `<${etag}>${resource.etag}</${etag}>` +
            `<${cdata}>${escapeXml(resource.ics)}</${cdata}>`
        )
      );
    }
    return this.reply(207, this.envelope(parts.join('')));
  }

  private find(
    path: string
  ): { store: Map<string, Stored>; name: string } | undefined {
    for (const [calendarPath, store] of this.calendars) {
      if (path.startsWith(calendarPath)) {
        return {
          store: store.resources,
          name: path.slice(calendarPath.length),
        };
      }
    }
    return undefined;
  }

  private get(path: string): Response {
    const found = this.find(path);
    const resource = found?.store.get(found.name);
    if (resource === undefined) return this.reply(404, 'not found');
    return this.reply(200, resource.ics, {
      etag: resource.etag,
      'content-type': 'text/calendar; charset=utf-8',
    });
  }

  private put(path: string, init: RequestInit, body: string): Response {
    const found = this.find(path);
    if (found === undefined) return this.reply(409, 'no such collection');
    const headers = (init.headers ?? {}) as Record<string, string>;
    const existing = found.store.get(found.name);

    if (headers['If-None-Match'] === '*' && existing !== undefined) {
      return this.reply(412, 'exists');
    }
    if (headers['If-Match'] !== undefined) {
      if (existing === undefined) return this.reply(404, 'not found');
      if (headers['If-Match'] !== existing.etag)
        return this.reply(412, 'stale');
    }
    const etag = this.nextEtag();
    found.store.set(found.name, { ics: body, etag });
    return this.reply(existing === undefined ? 201 : 204, '', { etag });
  }

  private del(path: string, init: RequestInit): Response {
    const found = this.find(path);
    const existing = found?.store.get(found.name);
    if (found === undefined || existing === undefined) {
      return this.reply(404, 'not found');
    }
    const headers = (init.headers ?? {}) as Record<string, string>;
    if (
      headers['If-Match'] !== undefined &&
      headers['If-Match'] !== existing.etag
    ) {
      return this.reply(412, 'stale');
    }
    found.store.delete(found.name);
    return this.reply(204);
  }
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/** A complete configuration, overridable field by field. */
export function testConfig(overrides: Partial<Config> = {}): Config {
  return {
    url: ORIGIN,
    username: USER,
    password: 'not-a-secret',
    token: undefined,
    userEmail: undefined,
    calendars: [],
    timezone: 'Europe/Berlin',
    maxEntries: 100,
    insecureTls: false,
    readOnly: false,
    elicitation: true,
    allowTools: undefined,
    denyTools: undefined,
    ...overrides,
  };
}

export interface Connected {
  client: Client;
  /** Every dialog the server put in front of the user. */
  prompts: string[];
  close(): Promise<void>;
}

/**
 * Links a client to a server over an in-memory transport.
 *
 * `elicit` decides whether the client declares the capability at all, which is
 * what makes a guarded tool choose between the dialog and the two-call token.
 * Both have to be exercised: a server that quietly stopped asking would keep
 * every token test green.
 */
export async function connect(
  config: Partial<Config> = {},
  elicit?: 'accept' | 'decline' | 'cancel'
): Promise<Connected> {
  const server = createServer(testConfig(config));
  const prompts: string[] = [];
  const client = new Client(
    { name: 'test', version: '0.0.0' },
    elicit === undefined ? {} : { capabilities: { elicitation: {} } }
  );

  if (elicit !== undefined) {
    client.setRequestHandler('elicitation/create', (request) => {
      const params = request.params as { message?: string };
      prompts.push(params.message ?? '');
      if (elicit === 'cancel') return { action: 'cancel' };
      if (elicit === 'decline') return { action: 'decline' };
      return { action: 'accept', content: { confirm: true } };
    });
  }

  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  await Promise.all([
    client.connect(clientTransport),
    server.connect(serverTransport),
  ]);

  return {
    client,
    prompts,
    close: async () => {
      await client.close();
      await server.close();
    },
  };
}

/** The text of the first text block of a tool result. */
export function textOf(result: unknown): string {
  const content = (result as { content?: { type: string; text?: string }[] })
    .content;
  return (content ?? [])
    .filter((part) => part.type === 'text')
    .map((part) => part.text ?? '')
    .join('\n');
}

/**
 * The structured half of a tool result, checked against the text block.
 *
 * Comparing the two channels here turns every assertion in every suite into a
 * check that they agree — hundreds of them, for one edit. Where a tool fences
 * its text (the `get_*` tools), the JSON is the last text block.
 */
export function dataOf(result: unknown): Record<string, unknown> {
  const structured = (result as { structuredContent?: unknown })
    .structuredContent;
  expect(structured, 'result carried no structuredContent').toBeDefined();
  const content = (result as { content?: { type: string; text?: string }[] })
    .content;
  const blocks = (content ?? []).filter((part) => part.type === 'text');
  const last = blocks[blocks.length - 1]?.text ?? '';
  expect(
    JSON.parse(last),
    'the JSON text block and structuredContent disagree'
  ).toEqual(structured);
  return structured as Record<string, unknown>;
}
