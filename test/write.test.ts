import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { connect, FakeCalDav, textOf, type Connected } from './harness.js';

/**
 * The preservation matrix: what survives an edit that never mentioned it.
 *
 * A CalDAV `PUT` replaces the whole resource, so this is the property the write
 * path exists to hold. Nothing here is preserved by special-case code — the
 * fields are simply never touched — which is exactly why it needs a test that
 * would notice if the strategy quietly changed to rebuilding from fields.
 */

const WORK = '/tester/work/';
const WINDOW = { from: '2026-09-01T00:00:00Z', to: '2026-10-15T00:00:00Z' };

/** One event carrying every shape this server does not model. */
const RICH = [
  'BEGIN:VCALENDAR',
  'VERSION:2.0',
  'PRODID:-//Example Corp//Calendar 1.0//EN',
  'CALSCALE:GREGORIAN',
  'BEGIN:VTIMEZONE',
  'TZID:Europe/Berlin',
  'BEGIN:DAYLIGHT',
  'TZOFFSETFROM:+0100',
  'TZOFFSETTO:+0200',
  'TZNAME:CEST',
  'DTSTART:19700329T020000',
  'RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=-1SU',
  'END:DAYLIGHT',
  'END:VTIMEZONE',
  'BEGIN:VEVENT',
  'UID:rich@example.net',
  'DTSTAMP:20260901T120000Z',
  'DTSTART;TZID=Europe/Berlin:20260907T090000',
  'DTEND;TZID=Europe/Berlin:20260907T100000',
  'SUMMARY:Original title',
  'DESCRIPTION:Ümlaute und ein deutlich längerer Text, der die 75-Oktett-Grenze der Zeilenfaltung überschreitet und deshalb umbrochen werden muss.',
  'LOCATION:Raum 1\\; zweite Etage',
  'GEO:52.52;13.405',
  'ORGANIZER;CN=Alice:mailto:alice@example.net',
  'ATTENDEE;CN=Bob;ROLE=REQ-PARTICIPANT;PARTSTAT=ACCEPTED;RSVP=TRUE:mailto:bob@example.net',
  'ATTENDEE;CN=Carol;CUTYPE=RESOURCE:mailto:room@example.net',
  'ATTACH;FMTTYPE=text/plain;ENCODING=BASE64;VALUE=BINARY;X-APPLE-FILENAME=note.txt:aGVsbG8gd29ybGQ=',
  'ATTACH;FMTTYPE=application/pdf:https://example.net/agenda.pdf',
  'CATEGORIES:Work,Weekly',
  'STATUS:CONFIRMED',
  'X-MICROSOFT-CDO-BUSYSTATUS:BUSY',
  'X-CUSTOM-THING;X-PARAM=weird:some value',
  'BEGIN:VALARM',
  'ACTION:DISPLAY',
  'TRIGGER:-PT15M',
  'DESCRIPTION:Reminder',
  'END:VALARM',
  'BEGIN:VALARM',
  'ACTION:EMAIL',
  'TRIGGER;RELATED=END:-PT1H',
  'DESCRIPTION:Mail reminder',
  'SUMMARY:Subject line',
  'ATTENDEE:mailto:alice@example.net',
  'REPEAT:2',
  'DURATION:PT5M',
  'END:VALARM',
  'END:VEVENT',
  'END:VCALENDAR',
  '',
].join('\r\n');

let fake: FakeCalDav;
let session: Connected;

beforeEach(async () => {
  fake = new FakeCalDav();
  fake.install();
  fake.seed('work', 'rich.ics', RICH);
  session = await connect({}, 'accept');
});

afterEach(async () => {
  await session.close();
  vi.unstubAllGlobals();
});

async function call(
  name: string,
  args: Record<string, unknown> = {}
): Promise<unknown> {
  return session.client.callTool({ name, arguments: args });
}

async function idOfRich(): Promise<string> {
  const result = (await call('list_events', WINDOW)) as {
    structuredContent?: { events?: { id: string; uid?: string }[] };
  };
  const found = result.structuredContent?.events?.find(
    (entry) => entry.uid === 'rich@example.net'
  );
  expect(found, 'the fixture was not listed').toBeDefined();
  return found?.id ?? '';
}

/** The stored resource, unfolded so a wrapped property matches on one line. */
function stored(): string {
  return (fake.stored('work', 'rich.ics') ?? '').replace(/\r\n[ \t]/g, '');
}

describe('changing one field', () => {
  it('leaves every other property exactly where it was', async () => {
    const id = await idOfRich();
    const result = await call('update_event', { id, summary: 'New title' });
    expect(
      (result as { isError?: boolean }).isError,
      textOf(result)
    ).toBeFalsy();

    const after = stored();
    expect(after).toContain('SUMMARY:New title');
    expect(after).not.toContain('SUMMARY:Original title');

    for (const [what, pattern] of [
      ['an unknown X- property', /X-CUSTOM-THING;X-PARAM=weird:some value/],
      ['a vendor X- property', /X-MICROSOFT-CDO-BUSYSTATUS:BUSY/],
      ['an inline attachment', /aGVsbG8gd29ybGQ=/],
      ['its filename parameter', /X-APPLE-FILENAME=note\.txt/],
      ['a URL attachment', /agenda\.pdf/],
      ['the organiser', /ORGANIZER;CN=Alice:mailto:alice@example\.net/],
      ['an attendee with parameters', /ATTENDEE[^\r\n]*CUTYPE=RESOURCE/],
      ['the VTIMEZONE', /BEGIN:VTIMEZONE[\s\S]*END:VTIMEZONE/],
      ['a structured value', /GEO:52\.52;13\.405/],
      ['an escaped separator', /Raum 1\\;/],
      ['the simple alarm', /TRIGGER:-PT15M/],
      ['the complex alarm', /ACTION:EMAIL/],
      ['its repeat', /REPEAT:2/],
      ['its parameterised trigger', /TRIGGER;RELATED=END:-PT1H/],
      ['the categories', /CATEGORIES:Work,Weekly/],
      ['a non-ASCII description', /Ümlaute/],
    ] as const) {
      expect(after, what).toMatch(pattern);
    }
  });

  it('writes a document that is still legally folded', async () => {
    const id = await idOfRich();
    await call('update_event', { id, summary: 'New title' });
    const raw = fake.stored('work', 'rich.ics') ?? '';
    const tooLong = raw
      .split('\r\n')
      .filter((line) => Buffer.byteLength(line, 'utf8') > 75);
    expect(tooLong, 'lines over 75 octets').toEqual([]);
    expect(raw).toContain('\r\n');
  });

  it('advances the sequence and the timestamps', async () => {
    // SEQUENCE counts revisions the organiser published, and iTIP uses it to
    // decide whether an update supersedes what an attendee already has.
    const id = await idOfRich();
    await call('update_event', { id, summary: 'New title' });
    expect(stored()).toMatch(/^SEQUENCE:1$/m);
    expect(stored()).toMatch(/^LAST-MODIFIED:/m);
  });

  it('clears a field when it is passed as null', async () => {
    const id = await idOfRich();
    await call('update_event', { id, location: null });
    expect(stored()).not.toMatch(/^LOCATION:/m);
    // And nothing else went with it.
    expect(stored()).toMatch(/GEO:52\.52;13\.405/);
  });
});

describe('alarms', () => {
  it('replaces the simple reminders and keeps the ones it cannot write', async () => {
    const id = await idOfRich();
    const result = (await call('update_event', {
      id,
      alarms: [{ trigger: '-PT30M', description: 'Half an hour' }],
    })) as { structuredContent?: { alarms_preserved?: number } };

    const after = stored();
    expect(after).toContain('TRIGGER:-PT30M');
    expect(after).not.toContain('TRIGGER:-PT15M');
    // An EMAIL alarm with a REPEAT is something this server cannot faithfully
    // rewrite, so it is preserved untouched — and the answer says so, because a
    // caller who expected a clean slate should find out rather than assume.
    expect(after).toContain('ACTION:EMAIL');
    expect(after).toContain('REPEAT:2');
    expect(result.structuredContent?.alarms_preserved).toBe(1);
  });

  it('removes only the simple ones for an empty array', async () => {
    const id = await idOfRich();
    await call('update_event', { id, alarms: [] });
    const after = stored();
    expect(after).not.toContain('TRIGGER:-PT15M');
    expect(after).toContain('ACTION:EMAIL');
  });

  it('leaves every alarm alone when the field is absent', async () => {
    const id = await idOfRich();
    await call('update_event', { id, summary: 'Untouched alarms' });
    expect(stored()).toContain('TRIGGER:-PT15M');
    expect(stored()).toContain('ACTION:EMAIL');
  });

  it('accepts an absolute trigger as well as a duration', async () => {
    const id = await idOfRich();
    await call('update_event', {
      id,
      alarms: [{ trigger: '2026-09-07T08:00:00' }],
    });
    expect(stored()).toMatch(/TRIGGER[^\r\n]*:20260907T060000Z/);
  });
});

describe('an entry too large to read in full', () => {
  it('refuses to edit it rather than writing a truncated version', async () => {
    // A PUT assembled from a truncated read would silently destroy whatever
    // fell off the end — most likely the attachment itself.
    const huge = RICH.replace('aGVsbG8gd29ybGQ=', 'A'.repeat(9 * 1024 * 1024));
    fake.seed('work', 'huge.ics', huge);
    const id = await idOfRich();
    // Address the oversized resource by rewriting the id's resource part.
    const parts = id.split('.');
    const oversized = `${parts[0]}.${parts[1]}.${Buffer.from(
      'huge.ics',
      'utf8'
    ).toString('base64url')}`;

    const result = await call('update_event', {
      id: oversized,
      summary: 'nope',
    });
    expect((result as { isError?: boolean }).isError).toBe(true);
    expect(textOf(result)).toMatch(/lose the attachment/);
    // And nothing was written.
    expect(fake.stored('work', 'huge.ics')).toBe(huge);
  });
});

describe('the ETag guard', () => {
  it('refuses the write and reports, rather than retrying, on a 412', async () => {
    const id = await idOfRich();
    // Change the resource between the server's read and its write.
    const original = fake.stored('work', 'rich.ics') ?? '';
    let reads = 0;
    const real = globalThis.fetch;
    vi.stubGlobal('fetch', async (url: string | URL, init?: RequestInit) => {
      const method = (init?.method ?? 'GET').toUpperCase();
      const response = await real(url as string, init);
      if (method === 'GET' && String(url).endsWith('rich.ics')) {
        reads += 1;
        if (reads === 1) {
          // Race it *after* the read has been answered, so the server is now
          // holding an ETag that has just become stale.
          fake.seed(
            'work',
            'rich.ics',
            original.replace('Original title', 'Somebody else')
          );
        }
      }
      return response;
    });

    const result = await call('update_event', { id, summary: 'mine' });
    expect((result as { isError?: boolean }).isError).toBe(true);
    const message = textOf(result);
    expect(message).toMatch(/nothing was written/i);
    // A blind retry is precisely the lost update the ETag prevented, so the
    // answer is something a caller can act on instead.
    expect(message).toMatch(/make the same call again/);
    expect(stored()).toContain('Somebody else');
    expect(stored()).not.toContain('mine');
  });

  it('refuses to write at all when the server offers no strong ETag', async () => {
    const id = await idOfRich();
    const real = globalThis.fetch;
    vi.stubGlobal('fetch', async (url: string | URL, init?: RequestInit) => {
      const response = await real(url as string, init);
      if ((init?.method ?? 'GET').toUpperCase() === 'GET') {
        const body = await response.text();
        return new Response(body, {
          status: response.status,
          // A proxy is allowed to weaken an ETag the origin issued strong, and
          // a weak validator cannot protect a write.
          headers: { etag: 'W/"weak"' },
        });
      }
      return response;
    });
    const result = await call('update_event', { id, summary: 'nope' });
    expect((result as { isError?: boolean }).isError).toBe(true);
    expect(textOf(result)).toMatch(/strong ETag/);
  });
});

describe('creating', () => {
  it('never lets the caller choose the path', async () => {
    const before = fake.names('work');
    await call('create_event', {
      calendar_id: WORK,
      summary: '../escape',
      start: '2026-09-20T10:00:00',
    });
    const added = fake.names('work').filter((name) => !before.includes(name));
    expect(added).toHaveLength(1);
    // Traversal and overwriting are removed rather than defended against: the
    // name comes from a generated UUID.
    expect(added[0]).toMatch(/^[0-9a-f-]{36}\.ics$/);
  });

  it('refuses a calendar that does not take the component', async () => {
    await session.close();
    vi.unstubAllGlobals();
    fake = new FakeCalDav({
      calendars: [{ name: 'work', components: ['VEVENT'] }],
    });
    fake.install();
    session = await connect({}, 'accept');
    const result = await call('create_task', {
      calendar_id: WORK,
      summary: 'nope',
      due: '2026-09-20T10:00:00',
    });
    expect((result as { isError?: boolean }).isError).toBe(true);
    expect(textOf(result)).toMatch(/does not accept VTODO/);
  });

  it('refuses a read-only calendar', async () => {
    await session.close();
    vi.unstubAllGlobals();
    fake = new FakeCalDav({ calendars: [{ name: 'work', readOnly: true }] });
    fake.install();
    session = await connect({}, 'accept');
    const result = await call('create_event', {
      calendar_id: WORK,
      summary: 'nope',
      start: '2026-09-20T10:00:00',
    });
    expect((result as { isError?: boolean }).isError).toBe(true);
    expect(textOf(result)).toMatch(/not write to it/);
  });
});
