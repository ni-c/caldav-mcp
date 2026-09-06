import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { connect, dataOf, FakeCalDav, type Connected } from './harness.js';

/**
 * The second hardening pass, 2026-09-07.
 *
 * Same shape as `hardening.test.ts`: each test names a defect that was real in
 * this tree and pins the fix through the tools, asserting on what went on the
 * wire or what came back — never on a guard having been called.
 */

const CALENDAR = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//t//EN'];

/** One VEVENT with the given extra lines, as a stored resource. */
function event(lines: string[], uid = 'e@example.net'): string {
  return [
    ...CALENDAR,
    'BEGIN:VEVENT',
    `UID:${uid}`,
    'DTSTAMP:20260901T120000Z',
    'DTSTART:20260907T070000Z',
    'DTEND:20260907T080000Z',
    'SUMMARY:Plain',
    ...lines,
    'END:VEVENT',
    'END:VCALENDAR',
    '',
  ].join('\r\n');
}

/** One VTODO with the given extra lines, as a stored resource. */
function task(lines: string[], uid = 't@example.net'): string {
  return [
    ...CALENDAR,
    'BEGIN:VTODO',
    `UID:${uid}`,
    'DTSTAMP:20260901T120000Z',
    'DUE:20260910T120000Z',
    'SUMMARY:Chore',
    ...lines,
    'END:VTODO',
    'END:VCALENDAR',
    '',
  ].join('\r\n');
}

describe('what a write argument may carry', () => {
  let fake: FakeCalDav;
  let session: Connected;

  beforeEach(async () => {
    fake = new FakeCalDav();
    fake.install();
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

  /** True when a call was refused, whichever way the SDK reports it. */
  async function refused(
    name: string,
    args: Record<string, unknown>
  ): Promise<boolean> {
    try {
      const result = (await call(name, args)) as { isError?: boolean };
      return result.isError === true;
    } catch {
      return true;
    }
  }

  const base = {
    calendar_id: '/tester/work/',
    summary: 'Fine',
    start: '2026-09-20T10:00:00',
  };

  function puts(): string[] {
    return fake.requests
      .filter((request) => request.method === 'PUT')
      .map((request) => request.body ?? '');
  }

  it('refuses a recurrence rule ical.js would quietly rewrite', async () => {
    // `ICAL.Recur.fromString` reads what it understands and drops the rest:
    // `COUNT=1e9` became `COUNT=1`, `INTERVAL=0` vanished, an unknown part
    // vanished, the second of two COUNTs won, and everything after a line
    // break was gone. Each of those was then written into a shared calendar
    // as if it were what the caller asked for.
    for (const recurrence of [
      'FREQ=DAILY;COUNT=1e9',
      'FREQ=DAILY;INTERVAL=0',
      'FREQ=DAILY;X-FOO=1',
      'FREQ=DAILY;COUNT=5;COUNT=6',
      'RSCALE=GREGORIAN;FREQ=YEARLY;SKIP=FORWARD',
      'FREQ=DAILY;COUNT=3\nATTENDEE:mailto:x@example.net',
      'FREQ=DAILY;COUNT=3\r\nSUMMARY:evil',
      'FREQ=DAILY;BYDAY=MO TU',
      'FREQ=daily',
      'DAILY',
    ]) {
      expect(
        await refused('create_event', { ...base, recurrence }),
        JSON.stringify(recurrence)
      ).toBe(true);
    }
    expect(puts()).toHaveLength(0);
  });

  it('writes a rule exactly as given, in every spelling RFC 5545 allows', async () => {
    for (const [recurrence, written] of [
      ['FREQ=WEEKLY;BYDAY=MO;COUNT=10', 'FREQ=WEEKLY;COUNT=10;BYDAY=MO'],
      ['FREQ=MONTHLY;BYMONTHDAY=-1', 'FREQ=MONTHLY;BYMONTHDAY=-1'],
      ['FREQ=YEARLY;BYMONTH=3;BYDAY=2SU', 'FREQ=YEARLY;BYMONTH=3;BYDAY=2SU'],
      [
        'FREQ=DAILY;INTERVAL=2;UNTIL=20261231T235959Z',
        'FREQ=DAILY;INTERVAL=2;UNTIL=20261231T235959Z',
      ],
      ['FREQ=WEEKLY;WKST=SU;BYDAY=TU,TH', 'FREQ=WEEKLY;BYDAY=TU,TH;WKST=SU'],
      // INTERVAL=1 is the default and the one rewrite that changes nothing.
      ['FREQ=DAILY;INTERVAL=1', 'FREQ=DAILY'],
      ['RRULE:FREQ=DAILY;COUNT=2', 'FREQ=DAILY;COUNT=2'],
    ]) {
      fake.requests.length = 0;
      const result = await call('create_event', { ...base, recurrence });
      expect((result as { isError?: boolean }).isError, recurrence).not.toBe(
        true
      );
      const body = puts()[0] ?? '';
      expect(body, recurrence).toContain(`RRULE:${written}\r\n`);
    }
  });

  it('refuses an alarm trigger that is not a duration', async () => {
    // ical.js accepted every one of these and wrote something else: `PT-5M`
    // verbatim, `P1W2D` as `P9D`, `-PT1M,PT2M` as `PT2M`, a hundred billion
    // hours as a hundred billion hours, and nothing past the line break.
    for (const trigger of [
      'PT-5M',
      'P1W2D',
      '-PT1M,PT2M',
      'PT99999999999H',
      '-PT15M\r\nX:y',
      '-PT15M\nATTACH:https://evil.example/x',
      'P',
      'PT',
      '-P',
      'P400D',
    ]) {
      expect(
        await refused('create_event', {
          ...base,
          alarms: [{ trigger }],
        }),
        JSON.stringify(trigger)
      ).toBe(true);
    }
    expect(puts()).toHaveLength(0);
  });

  it('writes the triggers RFC 5545 allows, and one line each', async () => {
    for (const [trigger, written] of [
      ['-PT15M', 'TRIGGER:-PT15M'],
      ['-P1D', 'TRIGGER:-P1D'],
      ['PT1H30M', 'TRIGGER:PT1H30M'],
      ['-P1DT2H', 'TRIGGER:-P1DT2H'],
      ['P2W', 'TRIGGER:P2W'],
      ['-pt15m', 'TRIGGER:-PT15M'],
      ['2026-09-20T09:00:00Z', 'TRIGGER;VALUE=DATE-TIME:20260920T090000Z'],
    ]) {
      fake.requests.length = 0;
      const result = await call('create_event', {
        ...base,
        alarms: [{ trigger }],
      });
      expect((result as { isError?: boolean }).isError, trigger).not.toBe(true);
      const body = puts()[0] ?? '';
      const triggers = body
        .split('\r\n')
        .filter((line) => line.startsWith('TRIGGER'));
      expect(triggers, trigger).toEqual([written]);
    }
  });
});

describe('an integer somebody else wrote', () => {
  let fake: FakeCalDav;
  let session: Connected;

  beforeEach(async () => {
    fake = new FakeCalDav();
    fake.install();
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

  it('leaves a task field that is not an integer out instead of failing the answer', async () => {
    // The SDK checks every result against the tool's output schema and
    // answers a protocol error when it does not match — for the whole call,
    // not the one entry. `percent_complete` and `priority` are declared as
    // integers; ical.js hands `VALUE=FLOAT:1.5` over as 1.5, and a
    // twenty-digit SEQUENCE as 1e20. One such line, written by anybody with
    // access to a shared calendar, took `list_tasks` and `get_task` down.
    fake.seed(
      'work',
      'a.ics',
      task(['PERCENT-COMPLETE;VALUE=FLOAT:1.5'], 'a@example.net')
    );
    fake.seed(
      'work',
      'b.ics',
      task(['PRIORITY;VALUE=FLOAT:2.7'], 'b@example.net')
    );
    fake.seed(
      'work',
      'c.ics',
      task(['SEQUENCE:99999999999999999999'], 'c@example.net')
    );
    fake.seed(
      'work',
      'd.ics',
      task(['PERCENT-COMPLETE;VALUE=TEXT:50', 'PRIORITY:3'], 'd@example.net')
    );
    const listing = dataOf(
      await call('list_tasks', { from: '2026-09-01', to: '2026-09-30' })
    );
    const entries = listing.tasks as Record<string, unknown>[];
    expect(entries.map((entry) => entry.uid).toSorted()).toEqual([
      'a@example.net',
      'b@example.net',
      'c@example.net',
      'd@example.net',
    ]);
    const byUid = Object.fromEntries(
      entries.map((entry) => [entry.uid as string, entry])
    );
    expect(byUid['a@example.net']).not.toHaveProperty('percent_complete');
    expect(byUid['b@example.net']).not.toHaveProperty('priority');
    expect(byUid['c@example.net']).not.toHaveProperty('sequence');
    expect(byUid['d@example.net']?.percent_complete).toBe(50);
    expect(byUid['d@example.net']?.priority).toBe(3);
    for (const entry of entries) {
      const single = dataOf(await call('get_task', { id: entry.id }));
      expect((single.task as { uid?: string }).uid).toBe(entry.uid);
    }
  });

  it('leaves an attachment size that is not a number out', async () => {
    // `ATTACH;SIZE=` with three hundred digits is Infinity to Number(), and
    // twenty digits is past the safe-integer range the schema's `int()`
    // accepts. Either one failed the whole listing.
    fake.seed(
      'work',
      'a.ics',
      event([
        `ATTACH;FMTTYPE=application/pdf;SIZE=${'9'.repeat(300)}:https://files.example/a.pdf`,
      ])
    );
    fake.seed(
      'work',
      'b.ics',
      event(
        ['ATTACH;SIZE=99999999999999999999:https://files.example/b.pdf'],
        'b@example.net'
      )
    );
    fake.seed(
      'work',
      'c.ics',
      event(['ATTACH;SIZE=1234:https://files.example/c.pdf'], 'c@example.net')
    );
    const listing = dataOf(
      await call('list_events', { from: '2026-09-01', to: '2026-09-30' })
    );
    const entries = listing.events as Record<string, unknown>[];
    expect(entries).toHaveLength(3);
    const sizes = entries.map(
      (entry) =>
        (entry.attachments as { size?: number }[] | undefined)?.[0]?.size
    );
    expect(sizes.toSorted()).toEqual([1234, undefined, undefined]);
  });

  it('is the same for an event: a SEQUENCE that is not an integer is left out', async () => {
    fake.seed('work', 'a.ics', event(['SEQUENCE;VALUE=FLOAT:1.5']));
    const listing = dataOf(
      await call('list_events', { from: '2026-09-01', to: '2026-09-30' })
    );
    const entries = listing.events as Record<string, unknown>[];
    expect(entries).toHaveLength(1);
    expect(entries[0]).not.toHaveProperty('sequence');
  });
});
