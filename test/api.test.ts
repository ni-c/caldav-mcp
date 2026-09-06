import { afterEach, describe, expect, it, vi } from 'vitest';

import { CalDavApi, CalDavApiError, normaliseEtag } from '../src/api.js';
import { Discovery } from '../src/discovery.js';
import { testConfig } from './harness.js';

/**
 * The transport: ceilings, redirects, validators and the origin guard.
 *
 * These are the properties that keep a hostile or merely broken server from
 * reaching further than one answer, and none of them is visible in a tool's
 * behaviour until the day it matters.
 */

const ORIGIN = 'https://dav.example.net';

function api(overrides: Parameters<typeof testConfig>[0] = {}): CalDavApi {
  return new CalDavApi(testConfig(overrides));
}

/** Answers every request with one canned response. */
function answer(
  body: string,
  init: { status?: number; headers?: Record<string, string> } = {}
): void {
  vi.stubGlobal('fetch', async () =>
    Promise.resolve(
      new Response(body, {
        status: init.status ?? 200,
        headers: init.headers ?? {},
      })
    )
  );
}

const MULTISTATUS = `<?xml version="1.0"?>
<multistatus xmlns="DAV:"><response><href>/x/</href>
<propstat><prop><displayname>X</displayname></prop><status>HTTP/1.1 200 OK</status></propstat>
</response></multistatus>`;

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('the origin guard', () => {
  it('resolves a relative, an absolute-path and an absolute href alike', () => {
    const client = api();
    for (const href of ['work/', '/tester/work/', `${ORIGIN}/tester/work/`]) {
      expect(client.resolveHref(href, `${ORIGIN}/tester/`), href).toBe(
        `${ORIGIN}/tester/work/`
      );
    }
  });

  it('refuses an href on another origin', () => {
    // A hostile or misconfigured <D:href> would otherwise receive this server's
    // credentials — and, with CALDAV_INSECURE_TLS on, its relaxed certificate
    // checking too.
    expect(() =>
      api().resolveHref('https://evil.example/steal/', `${ORIGIN}/`)
    ).toThrow(/not the configured server/);
  });

  it('preserves percent-encoding exactly as received', () => {
    // %2F inside a segment is not the same as a / between two, so decoding and
    // re-encoding would not round-trip.
    expect(api().resolveHref('/tester/a%2Fb/', `${ORIGIN}/`)).toBe(
      `${ORIGIN}/tester/a%2Fb/`
    );
  });

  it('refuses an href carrying credentials, even on the right host', () => {
    // `URL.origin` leaves the userinfo out, so this passed the origin check
    // and the credential-shaped string went on to list_calendars and into
    // every request URL for that calendar.
    expect(() =>
      api().resolveHref(
        'https://x:y@dav.example.net/tester/work/',
        `${ORIGIN}/`
      )
    ).toThrow(/carrying credentials/);
  });

  it('refuses a scheme that is not http or https', () => {
    // A blob: URL reports the host's origin while being nothing this server
    // can fetch or address as a path.
    expect(() =>
      api().resolveHref('blob:https://dav.example.net/uuid', `${ORIGIN}/`)
    ).toThrow(/does not follow/);
  });

  it('escapes what it quotes from the server', () => {
    expect(() =>
      api().resolveHref('https://evil\u{202e}.example/', `${ORIGIN}/`)
    ).toThrow(/\\u202e/);
  });
});

describe('the sink', () => {
  it('sends credentials to the configured origin and nowhere else', async () => {
    // Every caller passes a resolveHref or resourceUrl result, so this cannot
    // be reached today. The point is that the property lives here rather
    // than in eight call sites: a future tool handing an unresolved href to
    // `get` meets this line, not the network.
    let called = false;
    vi.stubGlobal('fetch', async () => {
      called = true;
      return Promise.resolve(new Response('', { status: 200 }));
    });
    await expect(api().get('https://evil.example/x.ics')).rejects.toThrow(
      /only the configured server/
    );
    expect(called).toBe(false);
  });

  it('is no weaker than the resolver upstream of it', async () => {
    // A sink that is weaker than the check in front of it is not a sink. It
    // used to compare `URL.origin` alone, and `URL.origin` omits the
    // userinfo — so a link carrying credentials on the right host satisfied
    // "same origin" and would have gone on the wire. That is the exact gap
    // `resolveHref` was tightened to close, left open one layer further down,
    // where the credentials actually leave the process.
    for (const url of [
      'https://x:y@dav.example.net/tester/work/a.ics',
      'https://:secret@dav.example.net/tester/work/a.ics',
      'blob:https://dav.example.net/tester/work/a.ics',
    ]) {
      let called = false;
      vi.stubGlobal('fetch', async () => {
        called = true;
        return Promise.resolve(new Response('', { status: 200 }));
      });
      await expect(api().get(url), url).rejects.toThrow(
        /only the configured server/
      );
      expect(called, url).toBe(false);
    }
  });
});

describe('refusing an oversized answer', () => {
  it('refuses on a declared content-length before reading a byte', async () => {
    let read = false;
    vi.stubGlobal('fetch', async () => {
      const response = new Response('x', {
        status: 200,
        headers: { 'content-length': String(64 * 1024 * 1024) },
      });
      Object.defineProperty(response, 'body', {
        get() {
          read = true;
          return null;
        },
      });
      return Promise.resolve(response);
    });
    await expect(
      api().propfind(`${ORIGIN}/`, 0, ['D:displayname'])
    ).rejects.toThrow(/larger than/);
    expect(read).toBe(false);
  });

  it('aborts a chunked answer as soon as it crosses the ceiling', async () => {
    let cancelled = false;
    const chunk = new Uint8Array(256 * 1024);
    vi.stubGlobal('fetch', async () => {
      let sent = 0;
      const stream = new ReadableStream<Uint8Array>({
        pull(controller) {
          sent += 1;
          // 8 MB ceiling on a resource read; this is 16 MB of chunks.
          if (sent > 64) controller.close();
          else controller.enqueue(chunk);
        },
        cancel() {
          cancelled = true;
        },
      });
      return Promise.resolve(new Response(stream, { status: 200 }));
    });
    await expect(api().get(`${ORIGIN}/x.ics`)).rejects.toThrow(/larger than/);
    expect(cancelled).toBe(true);
  });

  it('says what to do about it', async () => {
    answer('x', { headers: { 'content-length': String(64 * 1024 * 1024) } });
    await expect(api().get(`${ORIGIN}/x.ics`)).rejects.toThrow(
      /Narrow the request/
    );
  });
});

describe('redirects', () => {
  it('refuses one on every authenticated verb', async () => {
    // Following one would resend the credentials to whatever host the upstream
    // named. `redirect: 'error'` makes undici reject rather than follow.
    const seen: (string | undefined)[] = [];
    vi.stubGlobal('fetch', async (_url: string, init: RequestInit) => {
      seen.push(init.redirect);
      return Promise.resolve(new Response(MULTISTATUS, { status: 207 }));
    });
    const client = api();
    await client.propfind(`${ORIGIN}/`, 0, ['D:displayname']);
    await client.report(`${ORIGIN}/x/`, 1, '<x/>');
    await client.get(`${ORIGIN}/x.ics`).catch(() => undefined);
    await client.options(`${ORIGIN}/`).catch(() => undefined);
    expect(new Set(seen)).toEqual(new Set(['error']));
  });

  it('follows the well-known probe manually and pins it to the origin', async () => {
    vi.stubGlobal('fetch', async (_url: string, init: RequestInit) => {
      expect(init.redirect).toBe('manual');
      return Promise.resolve(
        new Response('', { status: 301, headers: { location: '/dav/' } })
      );
    });
    // RFC 6764 defines the endpoint *as* a redirect, so refusing one here would
    // refuse the mechanism. The Location still goes through the origin guard.
    expect(await api().probeWellKnown()).toEqual({ url: `${ORIGIN}/dav/` });
  });

  it('refuses a well-known redirect to another host without throwing', async () => {
    // Refusing to follow it is right — it would send the credentials to a host
    // nobody configured. Throwing is not: this used to propagate out of
    // discovery, which then never reached its later steps, and the principal
    // promise is memoised, so one redirect failed every tool call for the life
    // of the process. RFC 6764 §6 explicitly allows the cross-host form, so
    // this is the ordinary hosted-provider bootstrap rather than an attack.
    vi.stubGlobal('fetch', async () =>
      Promise.resolve(
        new Response('', {
          status: 301,
          headers: { location: 'https://evil.example/dav/' },
        })
      )
    );
    expect(await api().probeWellKnown()).toEqual({
      refusedOrigin: 'https://evil.example',
    });
  });

  it('treats a missing well-known route as normal', async () => {
    // Baikal only ships it when the vhost is configured for it.
    answer('not found', { status: 404 });
    expect(await api().probeWellKnown()).toEqual({});
  });

  it('lets discovery carry on past a refused cross-host redirect', async () => {
    // The transport-level assertion above is only half of it: what matters is
    // that discovery reaches its later steps and its fallback, and says which
    // host it would not follow. That host is what CALDAV_URL should have been,
    // so naming it turns a mystery into an instruction.
    vi.stubGlobal('fetch', (url: string) => {
      const target = new URL(String(url));
      if (target.pathname === '/.well-known/caldav') {
        return Promise.resolve(
          new Response(null, {
            status: 301,
            headers: { location: 'https://elsewhere.example/dav/' },
          })
        );
      }
      return Promise.resolve(
        new Response(
          '<?xml version="1.0"?><multistatus xmlns="DAV:"><response><href>/</href><propstat><prop/><status>HTTP/1.1 404 Not Found</status></propstat></response></multistatus>',
          { status: 207, headers: { 'content-type': 'application/xml' } }
        )
      );
    });
    const principal = await new Discovery(api(), []).principal();
    expect(principal.homes).toEqual([`${ORIGIN}/`]);
    expect(JSON.stringify(principal.notes)).toContain('elsewhere.example');
  });
});

describe('validators', () => {
  it('reads a strong ETag', async () => {
    answer('BEGIN:VCALENDAR', { headers: { etag: '"abc"' } });
    expect((await api().get(`${ORIGIN}/x.ics`)).etag).toBe('"abc"');
  });

  it('reports a weak ETag as absent, so a write refuses rather than races', async () => {
    // RFC 9110: If-Match requires strong comparison, and a proxy may weaken an
    // ETag the origin issued strong.
    answer('BEGIN:VCALENDAR', { headers: { etag: 'W/"abc"' } });
    expect((await api().get(`${ORIGIN}/x.ics`)).etag).toBeUndefined();
  });

  it('treats an ETag that is not one as absent', async () => {
    // The value goes back out in If-Match on the next write. undici refuses
    // a header value with a control character, which reached the model as
    // `fetch failed` on every write to that resource; a bare word or an
    // unbalanced quote is not an entity-tag either (RFC 9110 §8.8.3).
    for (const etag of [
      'abc',
      '"a"b',
      '"a b"',
      '"',
      '""x',
      `"${'a'.repeat(1025)}"`,
    ]) {
      expect(normaliseEtag(etag), etag).toBeUndefined();
    }
    for (const etag of ['"abc"', '"00123"', '""', '"a-b_c.d:e/f"']) {
      expect(normaliseEtag(etag), etag).toBe(etag);
    }
    expect(normaliseEtag('  "abc"  ')).toBe('"abc"');
  });

  it('cannot receive a line break in an ETag, nor send one', () => {
    // The platform's half of the guarantee, pinned: neither a Response nor a
    // Headers object can be built with a value carrying CR or LF, so a
    // header-injecting ETag cannot even be received, and could not be sent
    // if it were.
    expect(
      () => new Response('', { headers: { etag: '"a"\r\nX-Injected: y' } })
    ).toThrow(TypeError);
    expect(() => new Headers({ 'If-Match': '"a"\r\nX-Injected: y' })).toThrow(
      TypeError
    );
    expect(() => new Headers({ 'If-Match': '"a"\nX' })).toThrow(TypeError);
  });

  it('sends exactly one guard on every write', async () => {
    const headers: Record<string, string>[] = [];
    vi.stubGlobal('fetch', async (_url: string, init: RequestInit) => {
      headers.push(init.headers as Record<string, string>);
      return Promise.resolve(new Response(null, { status: 204 }));
    });
    const client = api();
    await client.put(`${ORIGIN}/x.ics`, 'ICS', { create: true });
    await client.put(`${ORIGIN}/x.ics`, 'ICS', { ifMatch: '"abc"' });
    await client.del(`${ORIGIN}/x.ics`, '"abc"');

    expect(headers[0]?.['If-None-Match']).toBe('*');
    expect(headers[1]?.['If-Match']).toBe('"abc"');
    expect(headers[2]?.['If-Match']).toBe('"abc"');
    // Never `If-Match: *` — that is the absence of the guard wearing its
    // clothes.
    for (const header of headers) {
      expect(header['If-Match']).not.toBe('*');
    }
  });
});

describe('errors', () => {
  it('extracts the precondition from a DAV error document', async () => {
    answer(
      `<?xml version="1.0"?><d:error xmlns:d="DAV:" xmlns:cal="urn:ietf:params:xml:ns:caldav"><cal:supported-calendar-component/></d:error>`,
      { status: 403 }
    );
    await expect(api().get(`${ORIGIN}/x.ics`)).rejects.toMatchObject({
      status: 403,
      precondition: 'supported-calendar-component',
    });
  });

  it('keeps the query and any userinfo out of the message', async () => {
    answer('nope', { status: 500 });
    try {
      await api().get(`${ORIGIN}/x.ics?token=s3cret`);
      expect.unreachable('should have thrown');
    } catch (error) {
      expect((error as Error).message).not.toContain('s3cret');
      expect(error).toBeInstanceOf(CalDavApiError);
    }
  });
});

/** The error a call is expected to throw, typed. */
async function failing(attempt: Promise<unknown>): Promise<CalDavApiError> {
  try {
    await attempt;
  } catch (thrown) {
    return thrown as CalDavApiError;
  }
  throw new Error('the call was expected to fail');
}

describe('an answer that is not a success', () => {
  it('decides on the status before reading the body', async () => {
    // A reverse proxy answering 401 with a two-megabyte login page used to
    // surface as "larger than 1048576 bytes and was refused" — the size, not
    // the status, and no word about credentials.
    answer('<html>'.padEnd(2 * 1024 * 1024, 'x'), { status: 401 });
    const error = await failing(api().get(`${ORIGIN}/x.ics`));
    expect(error).toBeInstanceOf(CalDavApiError);
    expect(error.status).toBe(401);
    expect(error.message).toContain('HTTP 401');
    expect(error.message).not.toMatch(/larger than/);
    expect(error.body.length).toBeLessThanOrEqual(64 * 1024);
  });

  it('cuts an error body rather than refusing it, on every verb', async () => {
    let calls = 0;
    vi.stubGlobal('fetch', async () => {
      calls += 1;
      return Promise.resolve(
        new Response('x'.repeat(3 * 1024 * 1024), { status: 500 })
      );
    });
    const client = api();
    for (const attempt of [
      () => client.options(`${ORIGIN}/`),
      () => client.propfind(`${ORIGIN}/`, 0, ['D:displayname']),
      () => client.report(`${ORIGIN}/c/`, 1, '<x/>'),
      () => client.freeBusy(`${ORIGIN}/c/`, '<x/>'),
      () => client.get(`${ORIGIN}/c/x.ics`),
      () =>
        client.put(`${ORIGIN}/c/x.ics`, 'BEGIN:VCALENDAR', { create: true }),
      () => client.del(`${ORIGIN}/c/x.ics`, '"a"'),
    ]) {
      const error = await attempt().catch((thrown: unknown) => thrown);
      expect(error).toBeInstanceOf(CalDavApiError);
      expect((error as CalDavApiError).status).toBe(500);
      expect((error as CalDavApiError).body.length).toBe(64 * 1024);
    }
    expect(calls).toBe(7);
  });

  it('repeats a 401 from memory for ten seconds instead of asking again', async () => {
    // Every request is a login, a hosted provider locks an account after a
    // handful of failed ones, and a model told "authentication refused"
    // retries a tool that is annotated cheap and read-only.
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      let calls = 0;
      vi.stubGlobal('fetch', async () => {
        calls += 1;
        return Promise.resolve(new Response('nope', { status: 401 }));
      });
      const client = api();
      const first = await failing(client.get(`${ORIGIN}/x.ics`));
      expect(first.status).toBe(401);
      expect(first.remembered).toBeUndefined();

      vi.setSystemTime(Date.now() + 3_000);
      const second = await failing(
        client.propfind(`${ORIGIN}/`, 0, ['D:displayname'])
      );
      expect(second.status).toBe(401);
      expect(second.message).toMatch(/3s ago and was not asked again/);
      expect(second.message).toMatch(/CALDAV_USERNAME/);
      expect(calls).toBe(1);

      vi.setSystemTime(Date.now() + 8_000);
      await client.get(`${ORIGIN}/x.ics`).catch(() => undefined);
      expect(calls).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('forgets a 401 the moment the server answers anything else', async () => {
    let status = 401;
    vi.stubGlobal('fetch', async () =>
      Promise.resolve(new Response('BEGIN:VCALENDAR', { status }))
    );
    const client = api();
    await client.get(`${ORIGIN}/x.ics`).catch(() => undefined);
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(Date.now() + 11_000);
      status = 200;
      expect((await client.get(`${ORIGIN}/x.ics`)).ics).toBe('BEGIN:VCALENDAR');
      status = 401;
      // Not remembered from the first refusal: a fresh 401, then memory again.
      const again = await failing(client.get(`${ORIGIN}/x.ics`));
      expect(again.remembered).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('without credentials', () => {
  it('refuses the call with setup instructions instead of connecting', async () => {
    // The server must still start and list its tools, so this is where the
    // absence surfaces rather than at startup.
    let called = false;
    vi.stubGlobal('fetch', async () => {
      called = true;
      return Promise.resolve(new Response('', { status: 200 }));
    });
    const client = api({ username: undefined, password: undefined });
    await expect(client.get(`${ORIGIN}/x.ics`)).rejects.toThrow(
      /CALDAV_USERNAME/
    );
    expect(called).toBe(false);
  });
});

describe('authentication', () => {
  it('sends Basic for a username and password', async () => {
    const headers: Record<string, string>[] = [];
    vi.stubGlobal('fetch', async (_url: string, init: RequestInit) => {
      headers.push(init.headers as Record<string, string>);
      return Promise.resolve(new Response(MULTISTATUS, { status: 207 }));
    });
    await api().propfind(`${ORIGIN}/`, 0, ['D:displayname']);
    expect(headers[0]?.Authorization).toBe(
      `Basic ${Buffer.from('tester:not-a-secret').toString('base64')}`
    );
  });

  it('sends Bearer for a token', async () => {
    const headers: Record<string, string>[] = [];
    vi.stubGlobal('fetch', async (_url: string, init: RequestInit) => {
      headers.push(init.headers as Record<string, string>);
      return Promise.resolve(new Response(MULTISTATUS, { status: 207 }));
    });
    await api({
      username: undefined,
      password: undefined,
      token: 'abc',
    }).propfind(`${ORIGIN}/`, 0, ['D:displayname']);
    expect(headers[0]?.Authorization).toBe('Bearer abc');
  });
});
