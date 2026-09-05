import {
  Agent,
  fetch as undiciFetch,
  type RequestInit as UndiciRequestInit,
} from 'undici';

import {
  missingConfigKeys,
  missingConfigMessage,
  type Config,
} from './config.js';
import {
  parseDavError,
  parseMultiStatus,
  propfindBody,
  type DavResponse,
  type PropName,
} from './dav-xml.js';

const REQUEST_TIMEOUT_MS = 30_000;

/**
 * Ceiling on a multistatus document.
 *
 * A `calendar-query` over a wide window is legitimately large — a busy calendar
 * answering with several hundred events at twenty kilobytes each reaches
 * megabytes before anything unusual has happened. The ceiling is not raised to
 * fit a request; a window that does not fit is narrowed by the caller, which is
 * what the 366-day limit and the result cap are for.
 */
const MAX_MULTISTATUS_BYTES = 16 * 1024 * 1024;

/** Ceiling on a single calendar resource on the **read** path. */
const MAX_RESOURCE_BYTES = 1 * 1024 * 1024;

/**
 * Ceiling on a single calendar resource on the **write** path.
 *
 * Deliberately larger than the read ceiling, and the difference matters. A write
 * is a read-modify-write over the whole resource, so a resource this server
 * cannot read in full is one it must not write at all — a PUT built from a
 * truncated read would silently destroy an inline attachment. Above this the
 * write tools refuse instead of truncating.
 */
const MAX_ROUNDTRIP_BYTES = 8 * 1024 * 1024;

/** Ceiling on a free-busy answer, which is a small VFREEBUSY document. */
const MAX_FREEBUSY_BYTES = 1 * 1024 * 1024;

export class CalDavApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly body: string,
    method: string,
    url: string,
    /** The DAV precondition element name, where the server named one. */
    public readonly precondition?: string
  ) {
    super(`CalDAV ${method} ${redactPath(url)} failed with HTTP ${status}`);
    this.name = 'CalDavApiError';
  }
}

/** A calendar resource as fetched, with the validator needed to write it back. */
export interface Resource {
  ics: string;
  etag: string | undefined;
}

interface SendOptions {
  depth?: 0 | 1;
  body?: string;
  contentType?: string;
  headers?: Record<string, string>;
  accept?: string;
  /**
   * Only the well-known probe may set this. Every other request refuses a
   * redirect outright — following one would resend the credentials to whatever
   * host the upstream named.
   */
  redirect?: 'error' | 'manual';
}

/**
 * The WebDAV verbs this server speaks, and no others.
 *
 * There is deliberately no `mkcalendar` and no `move` on this class. "Not
 * implemented" is a stronger guarantee than "not exposed": it means no future
 * tool can reach one by accident, and a reader auditing what this server can do
 * to a calendar collection has one short list to check.
 */
export class CalDavApi {
  private readonly config: Config;
  private readonly baseUrl: string;
  private readonly authHeader: string | undefined;
  /**
   * Only set when `CALDAV_INSECURE_TLS` is enabled. Scopes the relaxed
   * certificate validation to requests against the configured origin instead of
   * disabling it process-wide via NODE_TLS_REJECT_UNAUTHORIZED.
   */
  private readonly insecureDispatcher: Agent | undefined;

  constructor(config: Config) {
    this.config = config;
    this.baseUrl = config.url ?? '';
    if (config.token) {
      this.authHeader = `Bearer ${config.token}`;
    } else if (config.username && config.password) {
      this.authHeader = `Basic ${Buffer.from(
        `${config.username}:${config.password}`
      ).toString('base64')}`;
    } else {
      this.authHeader = undefined;
    }
    this.insecureDispatcher = config.insecureTls
      ? new Agent({ connect: { rejectUnauthorized: false } })
      : undefined;
  }

  /** The configured root, without a trailing slash. Empty when unconfigured. */
  get url(): string {
    return this.baseUrl;
  }

  /** The origin every request and every server-supplied href is pinned to. */
  get origin(): string {
    try {
      return new URL(this.baseUrl).origin;
    } catch {
      return '';
    }
  }

  /**
   * Turns a server-supplied href into an absolute URL on the configured origin.
   *
   * This is the choke point every href from a multistatus passes through, and
   * the origin assertion is the reason it exists: a hostile or misconfigured
   * `<D:href>https://elsewhere.example/</D:href>` would otherwise receive this
   * server's credentials — and, with `CALDAV_INSECURE_TLS` on, its relaxed
   * certificate checking too.
   *
   * Percent-encoding is preserved exactly as received. Decoding and re-encoding
   * would not round-trip: a `%2F` inside a path segment is not the same as a `/`
   * between two.
   */
  resolveHref(href: string, relativeTo: string = this.baseUrl): string {
    let resolved: URL;
    try {
      resolved = new URL(href, relativeTo);
    } catch {
      throw new Error(
        `the CalDAV server returned a link this server cannot read: ${redactPath(href)}`
      );
    }
    if (resolved.origin !== this.origin) {
      throw new Error(
        `the CalDAV server pointed at ${resolved.origin}, which is not the ` +
          `configured server (${this.origin}). caldav-mcp does not follow a ` +
          'link to another host, because that would send your credentials there.'
      );
    }
    return resolved.toString();
  }

  private async send(
    method: string,
    url: string,
    options: SendOptions = {}
  ): Promise<{
    status: number;
    ok: boolean;
    headers: Headers;
    response: Response;
  }> {
    // Credentials are only required here, not at startup, so the server can be
    // started and introspected without them.
    const missing = missingConfigKeys(this.config);
    if (missing.length > 0) throw new Error(missingConfigMessage(missing));

    const headers: Record<string, string> = {
      'User-Agent': 'caldav-mcp',
      ...(options.accept === undefined ? {} : { Accept: options.accept }),
      ...options.headers,
    };
    if (this.authHeader !== undefined) headers.Authorization = this.authHeader;
    if (options.depth !== undefined) headers.Depth = String(options.depth);
    if (options.body !== undefined) {
      headers['Content-Type'] =
        options.contentType ?? 'application/xml; charset=utf-8';
    }

    const init: RequestInit = {
      method,
      headers,
      ...(options.body === undefined ? {} : { body: options.body }),
      redirect: options.redirect ?? 'error',
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    };

    // The insecure dispatcher requires undici's own fetch; the default path uses
    // the (stubbable) global fetch. Only requests that actually go to the
    // configured origin may use the relaxed dispatcher.
    const useInsecure =
      this.insecureDispatcher !== undefined && this.isConfiguredOrigin(url);
    const response = useInsecure
      ? ((await undiciFetch(url, {
          ...init,
          dispatcher: this.insecureDispatcher,
        } as UndiciRequestInit)) as unknown as Response)
      : await fetch(url, init);

    return {
      status: response.status,
      ok: response.ok,
      headers: response.headers,
      response,
    };
  }

  /** `OPTIONS`: the `DAV:` compliance tokens and the allowed methods. */
  async options(url: string): Promise<{ dav: string[]; allow: string[] }> {
    const { ok, status, headers, response } = await this.send('OPTIONS', url);
    const body = (
      await readBoundedBody(response, url, MAX_FREEBUSY_BYTES)
    ).toString('utf8');
    if (!ok) throw await apiError(status, body, 'OPTIONS', url);
    const split = (value: string | null): string[] =>
      (value ?? '')
        .split(',')
        .map((entry) => entry.trim().toLowerCase())
        .filter((entry) => entry.length > 0);
    return {
      dav: split(headers.get('dav')),
      allow: split(headers.get('allow')),
    };
  }

  /** `PROPFIND` for a fixed set of properties. */
  async propfind(
    url: string,
    depth: 0 | 1,
    props: readonly PropName[]
  ): Promise<DavResponse[]> {
    return this.multiStatus('PROPFIND', url, depth, propfindBody(props));
  }

  /** `REPORT` answering a multistatus: `calendar-query` and its siblings. */
  async report(
    url: string,
    depth: 0 | 1,
    body: string
  ): Promise<DavResponse[]> {
    return this.multiStatus('REPORT', url, depth, body);
  }

  private async multiStatus(
    method: 'PROPFIND' | 'REPORT',
    url: string,
    depth: 0 | 1,
    body: string
  ): Promise<DavResponse[]> {
    const { ok, status, response } = await this.send(method, url, {
      depth,
      body,
      accept: 'application/xml, text/xml',
    });
    const bytes = await readBoundedBody(response, url, MAX_MULTISTATUS_BYTES);
    const text = bytes.toString('utf8');
    if (!ok) throw await apiError(status, text, method, url);
    return parseMultiStatus(text, `CalDAV ${method} ${redactPath(url)}`);
  }

  /**
   * `REPORT free-busy-query`, which is the one REPORT that does not answer 207.
   *
   * RFC 4791 §7.10 defines the response as a `text/calendar` VFREEBUSY document
   * with a plain 200. A caller expecting a multistatus here gets a parse error
   * that says nothing about the real shape, which is why this has its own method
   * rather than a flag on `report`.
   */
  async freeBusy(url: string, body: string): Promise<string> {
    const { ok, status, response } = await this.send('REPORT', url, {
      depth: 1,
      body,
      accept: 'text/calendar',
    });
    const bytes = await readBoundedBody(response, url, MAX_FREEBUSY_BYTES);
    const text = bytes.toString('utf8');
    if (!ok) throw await apiError(status, text, 'REPORT', url);
    return text;
  }

  /** `GET` a calendar resource. `forWrite` raises the ceiling — see the constant. */
  async get(url: string, forWrite = false): Promise<Resource> {
    const { ok, status, headers, response } = await this.send('GET', url, {
      accept: 'text/calendar',
    });
    const bytes = await readBoundedBody(
      response,
      url,
      forWrite ? MAX_ROUNDTRIP_BYTES : MAX_RESOURCE_BYTES
    );
    const text = bytes.toString('utf8');
    if (!ok) throw await apiError(status, text, 'GET', url);
    return { ics: text, etag: normaliseEtag(headers.get('etag')) };
  }

  /**
   * `PUT` a calendar resource.
   *
   * Exactly one of the two guards is always sent. `If-None-Match: *` creates and
   * refuses to overwrite; `If-Match: <etag>` replaces and refuses if anything
   * changed since the read. There is no unguarded PUT and no `If-Match: *` — the
   * latter is the absence of the guard wearing its clothes.
   */
  async put(
    url: string,
    ics: string,
    guard: { ifMatch: string } | { create: true }
  ): Promise<{ etag: string | undefined; status: number }> {
    const headers =
      'create' in guard
        ? { 'If-None-Match': '*' }
        : { 'If-Match': guard.ifMatch };
    const {
      ok,
      status,
      headers: got,
      response,
    } = await this.send('PUT', url, {
      body: ics,
      contentType: 'text/calendar; charset=utf-8',
      headers,
    });
    const text = (
      await readBoundedBody(response, url, MAX_FREEBUSY_BYTES)
    ).toString('utf8');
    if (!ok) throw await apiError(status, text, 'PUT', url);
    return { etag: normaliseEtag(got.get('etag')), status };
  }

  /** `DELETE` a calendar resource, guarded by the ETag read in the same call. */
  async del(url: string, ifMatch: string): Promise<number> {
    const { ok, status, response } = await this.send('DELETE', url, {
      headers: { 'If-Match': ifMatch },
    });
    const text = (
      await readBoundedBody(response, url, MAX_FREEBUSY_BYTES)
    ).toString('utf8');
    if (!ok) throw await apiError(status, text, 'DELETE', url);
    return status;
  }

  /**
   * The `/.well-known/caldav` probe — the one request allowed to see a redirect.
   *
   * RFC 6764 §6 defines this endpoint *as* a redirect, so refusing one here
   * would refuse the mechanism itself. `redirect: 'manual'` keeps the decision
   * in this process: the `Location` is read, run through {@link resolveHref}
   * (which pins it to the configured origin) and returned. undici never follows
   * anything.
   *
   * This is the only method that passes `redirect` to `send` at all; the six
   * verbs above never do, so `redirect: 'error'` holds for every authenticated
   * request without depending on anyone remembering. `discovery.ts` is the only
   * caller, and a test asserts every other verb throws on a 3xx.
   */
  async probeWellKnown(): Promise<string | undefined> {
    const url = new URL('/.well-known/caldav', this.baseUrl).toString();
    let result;
    try {
      result = await this.send('PROPFIND', url, {
        depth: 0,
        body: propfindBody(['D:current-user-principal']),
        redirect: 'manual',
      });
    } catch {
      // A server without the well-known route is the normal case, not a fault:
      // Baikal only ships it when the vhost is configured for it.
      return undefined;
    }
    const location = result.headers.get('location');
    if (result.status >= 300 && result.status < 400 && location) {
      return this.resolveHref(location, url);
    }
    if (result.status === 207) return url;
    return undefined;
  }

  private isConfiguredOrigin(url: string): boolean {
    try {
      return new URL(url).origin === this.origin;
    } catch {
      return false;
    }
  }
}

/**
 * Builds the error, extracting a DAV precondition where the server sent one.
 *
 * A DAV error document is genuinely useful — `<C:no-uid-conflict/>` says exactly
 * what went wrong where "HTTP 403" says nothing — so it is read before the body
 * is treated as opaque text.
 */
async function apiError(
  status: number,
  body: string,
  method: string,
  url: string
): Promise<CalDavApiError> {
  const parsed = /^\s*<\?xml|^\s*<[a-z0-9]*:?(error|multistatus)/i.test(body)
    ? parseDavError(body)
    : undefined;
  return new CalDavApiError(
    status,
    body,
    method,
    url,
    parsed?.precondition ?? undefined
  );
}

/**
 * Strips an ETag down to the value, refusing a weak one.
 *
 * A weak validator cannot protect a write (RFC 9110 §8.8.1: `If-Match` requires
 * strong comparison), and a proxy is allowed to weaken a strong ETag the origin
 * issued. Returning `undefined` rather than the weak value is what makes the
 * write tools refuse with an explanation instead of quietly dropping `If-Match`
 * and racing.
 */
function normaliseEtag(raw: string | null): string | undefined {
  if (raw === null) return undefined;
  const value = raw.trim();
  if (value === '' || value.startsWith('W/')) return undefined;
  return value;
}

/** Keeps a URL's query and userinfo out of an error message. */
function redactPath(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    return url.replace(/\?.*$/, '');
  }
}

/** Minimal shape of a response body we can read incrementally. */
interface StreamingBody {
  getReader(): {
    read(): Promise<{ done: boolean; value?: Uint8Array }>;
    cancel(): Promise<void>;
  };
}

function hasStreamingBody(body: unknown): body is StreamingBody {
  return (
    typeof body === 'object' &&
    body !== null &&
    typeof (body as StreamingBody).getReader === 'function'
  );
}

/**
 * Reads a response body, refusing anything past `maxBytes`.
 *
 * A declared `content-length` is rejected before a single byte is read; a
 * chunked response is aborted as soon as the accumulated size crosses the
 * ceiling. Responses without a streamable body — which is what the test stubs of
 * global `fetch` return — fall back to `arrayBuffer()` and are checked
 * afterwards.
 */
async function readBoundedBody(
  response: {
    headers: Headers;
    body?: unknown;
    arrayBuffer(): Promise<ArrayBuffer>;
  },
  url: string,
  maxBytes: number
): Promise<Buffer> {
  const tooLarge = (): Error =>
    new Error(
      `the CalDAV server's answer for ${redactPath(url)} was larger than ` +
        `${maxBytes} bytes and was refused. Narrow the request — a shorter time ` +
        'range, or fewer calendars.'
    );

  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) throw tooLarge();

  const body = response.body;
  if (!hasStreamingBody(body)) {
    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.byteLength > maxBytes) throw tooLarge();
    return buffer;
  }

  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value === undefined) continue;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw tooLarge();
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}
