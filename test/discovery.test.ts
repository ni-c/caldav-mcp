import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  connect,
  dataOf,
  FakeCalDav,
  ORIGIN,
  type FakeOptions,
} from './harness.js';

/**
 * The discovery walk, shape by shape.
 *
 * Every step from `CALDAV_URL` to a calendar list is a guess about where the
 * DAV endpoint is, and each guess has a way of being wrong that a real server
 * exhibits. The fake can now answer each of those; these tests walk them.
 */

afterEach(() => vi.unstubAllGlobals());

async function listing(
  options: FakeOptions = {},
  url = ORIGIN
): Promise<{
  fake: FakeCalDav;
  calendars: string[];
  notes: string[];
  info: Record<string, unknown>;
}> {
  const fake = new FakeCalDav(options);
  fake.install();
  const session = await connect({ url });
  try {
    const listed = dataOf(
      await session.client.callTool({ name: 'list_calendars', arguments: {} })
    );
    const info = dataOf(
      await session.client.callTool({ name: 'get_server_info', arguments: {} })
    );
    return {
      fake,
      calendars: (listed.calendars as { id: string }[]).map((c) => c.id),
      notes: (listed.notes as string[] | undefined) ?? [],
      info,
    };
  } finally {
    await session.close();
  }
}

const BOTH = ['/tester/private/', '/tester/work/'];

describe('the well-known route', () => {
  it('names the origin it refused to follow, and carries on', async () => {
    // RFC 6764 lets this route redirect to another host; following it would
    // send the credentials there, and throwing here — as this once did —
    // ended discovery for the life of the process, because the principal
    // promise is memoised.
    const { calendars, notes, fake } = await listing({
      principalAt: 'nowhere',
      wellKnown: { status: 301, location: 'https://elsewhere.example/dav/' },
    });
    expect(calendars).toEqual(BOTH);
    expect(notes).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/redirected to https:\/\/elsewhere\.example/),
        expect.stringMatching(/did not report a principal/),
      ])
    );
    expect(
      fake.requests.some(
        (r) => new URL(r.url).origin === 'https://elsewhere.example'
      )
    ).toBe(false);
  });

  it('treats a redirect without a location, or to nowhere, as no route', async () => {
    for (const wellKnown of [
      { status: 302 },
      { status: 301, location: 'http://[' },
      { status: 404 },
      { status: 500 },
    ]) {
      const { calendars, notes } = await listing({
        principalAt: 'nowhere',
        wellKnown,
      });
      expect(calendars, JSON.stringify(wellKnown)).toEqual(BOTH);
      expect(notes.join(' ')).not.toMatch(/redirected/);
    }
  });

  it('accepts a principal answered at the route itself', async () => {
    const { calendars, notes, info } = await listing({
      principalAt: 'nowhere',
      wellKnown: { status: 207 },
    });
    expect(calendars).toEqual(BOTH);
    expect(notes.join(' ')).not.toMatch(/did not report a principal/);
    expect(info.principal).toBe(`${ORIGIN}/tester/`);
  });

  it('survives a network failure on the route', async () => {
    const fake = new FakeCalDav({ principalAt: 'nowhere' });
    fake.install();
    const inner = globalThis.fetch;
    vi.stubGlobal('fetch', (input: string | URL, init?: RequestInit) =>
      String(input).endsWith('/.well-known/caldav')
        ? Promise.reject(new TypeError('fetch failed'))
        : inner(input, init)
    );
    const session = await connect();
    try {
      const listed = dataOf(
        await session.client.callTool({ name: 'list_calendars', arguments: {} })
      );
      expect((listed.calendars as unknown[]).length).toBe(2);
    } finally {
      await session.close();
    }
  });
});

describe('a DAV endpoint under a path prefix', () => {
  it('finds the principal at the origin root when the prefix does not answer it', async () => {
    const { calendars, fake } = await listing(
      {
        basePath: '/dav.php',
        principalAt: 'origin-root',
        wellKnown: { status: 404 },
      },
      `${ORIGIN}/dav.php`
    );
    expect(calendars).toEqual(BOTH);
    const probed = fake.requests
      .filter((r) => r.method === 'PROPFIND')
      .map((r) => new URL(r.url).pathname)
      .slice(0, 3);
    expect(probed).toEqual(['/dav.php/', '/.well-known/caldav', '/']);
  });

  it('falls back to the configured URL as the home set when nothing names a principal', async () => {
    // The origin root behind /dav.php is a plain web server: it answers a
    // PROPFIND with 404 or 405, which used to end discovery one step before
    // the fallback that was written for exactly this.
    // CALDAV_URL points at the user's own collection root, so the calendars
    // sit under it — which is what the home-set fallback assumes.
    for (const status of [404, 405]) {
      const { calendars, notes } = await listing(
        {
          basePath: '/tester',
          principalAt: 'nowhere',
          wellKnown: { status: 404 },
          failWith: (method, path) =>
            method === 'PROPFIND' && path === '/'
              ? { status, body: 'not here' }
              : undefined,
        },
        `${ORIGIN}/tester`
      );
      expect(calendars, String(status)).toEqual(BOTH);
      expect(notes).toEqual(
        expect.arrayContaining([
          expect.stringMatching(/did not report a principal/),
        ])
      );
    }
  });

  it('still treats a refusal as the answer', async () => {
    for (const status of [401, 403, 500]) {
      const fake = new FakeCalDav({
        basePath: '/dav.php',
        principalAt: 'nowhere',
        wellKnown: { status: 404 },
        failWith: (method, path) =>
          method === 'PROPFIND' && path === '/'
            ? { status, body: 'no' }
            : undefined,
      });
      fake.install();
      const session = await connect({ url: `${ORIGIN}/dav.php` });
      try {
        const result = (await session.client.callTool({
          name: 'list_calendars',
          arguments: {},
        })) as { isError?: boolean; content: { text?: string }[] };
        expect(result.isError, String(status)).toBe(true);
        expect(result.content[0]?.text).toContain(`HTTP ${status}`);
      } finally {
        await session.close();
      }
    }
  });
});

describe('what the principal says', () => {
  it('uses the configured URL when the principal names no home set', async () => {
    const { calendars, notes } = await listing({ noHomeSet: true });
    expect(calendars).toEqual(BOTH);
    expect(notes).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/named no calendar home set/),
      ])
    );
  });

  it('keeps the first twenty addresses and says how many there were', async () => {
    const addresses = Array.from({ length: 30 }, (_, i) => `p${i}@example.net`);
    const { info, notes } = await listing({ addresses });
    expect((info.self_addresses as string[]).length).toBe(20);
    expect(notes).toEqual(
      expect.arrayContaining([expect.stringMatching(/30 addresses; only/)])
    );
  });
});

describe('what a home set lists', () => {
  it('drops a scheduling inbox and outbox, an address book and a notification collection that are not calendars', async () => {
    const { calendars, fake } = await listing({
      extraCollections: [
        { href: '/tester/inbox/', types: ['schedule-inbox'] },
        { href: '/tester/outbox/', types: ['schedule-outbox'] },
        { href: '/tester/contacts/', types: ['addressbook'] },
        { href: '/tester/notes/', types: ['notification'] },
        { href: '/tester/untyped/', types: [] },
        { href: '/tester/plain/', types: ['calendar'], displayName: 'Plain' },
        { href: 'https://elsewhere.example/tester/far/', types: ['calendar'] },
      ],
    });
    expect(calendars).toEqual(['/tester/plain/', ...BOTH]);
    expect(
      fake.requests.some(
        (r) => new URL(r.url).origin === 'https://elsewhere.example'
      )
    ).toBe(false);
  });

  // RFC 4791 §4.2: a collection that reports `calendar` is a calendar, whatever
  // else its resourcetype names. SOGo marks the account's own calendar with
  // `schedule-outbox` as well (#61).
  it('keeps a calendar that also carries a scheduling, address book or notification marker', async () => {
    const { calendars } = await listing({
      extraCollections: [
        {
          href: '/tester/personal/',
          types: [
            'calendar',
            'vevent-collection',
            'vtodo-collection',
            'schedule-outbox',
          ],
        },
        { href: '/tester/in-cal/', types: ['calendar', 'schedule-inbox'] },
        { href: '/tester/book-cal/', types: ['calendar', 'addressbook'] },
        { href: '/tester/note-cal/', types: ['calendar', 'notification'] },
      ],
    });
    expect(calendars).toEqual([
      '/tester/book-cal/',
      '/tester/in-cal/',
      '/tester/note-cal/',
      '/tester/personal/',
      ...BOTH,
    ]);
  });
});

describe('CALDAV_URL on one collection', () => {
  it('uses a calendar that SOGo also marks as the scheduling outbox (#61)', async () => {
    const { calendars, notes } = await listing(
      {
        calendars: [
          {
            name: 'personal',
            extraTypes: [
              'vevent-collection',
              'vtodo-collection',
              'schedule-outbox',
            ],
          },
        ],
      },
      `${ORIGIN}/tester/personal`
    );
    expect(calendars).toEqual(['/tester/personal/']);
    expect(notes.join(' ')).toMatch(/is a calendar collection/);
    expect(notes.join(' ')).not.toMatch(/is not used/);
  });

  it('says so when the collection stops answering as a calendar', async () => {
    const fake = new FakeCalDav();
    fake.install();
    const inner = globalThis.fetch;
    let asked = 0;
    vi.stubGlobal('fetch', (input: string | URL, init?: RequestInit) => {
      const own =
        String(input) === `${ORIGIN}/tester/work/` &&
        init?.method === 'PROPFIND';
      if (own && (asked += 1) === 2) {
        return Promise.resolve(
          new Response('<multistatus xmlns="DAV:"/>', {
            status: 207,
            headers: { 'content-type': 'application/xml' },
          })
        );
      }
      return inner(input, init);
    });
    const session = await connect({ url: `${ORIGIN}/tester/work` });
    try {
      const listed = dataOf(
        await session.client.callTool({ name: 'list_calendars', arguments: {} })
      );
      expect(listed.calendars).toEqual([]);
      expect((listed.notes as string[]).join(' ')).toMatch(
        /did not answer as a calendar/
      );
    } finally {
      await session.close();
    }
  });

  it('says why a subscription that is also a scheduling inbox is not used', async () => {
    const { calendars, notes } = await listing(
      {
        calendars: [
          {
            name: 'feed',
            subscribed: 'only',
            extraTypes: ['schedule-inbox'],
          },
        ],
      },
      `${ORIGIN}/tester/feed`
    );
    expect(calendars).toEqual([]);
    expect(notes.join(' ')).toMatch(/schedule-inbox/);
    expect(notes.join(' ')).toMatch(/is not used/);
  });
});
