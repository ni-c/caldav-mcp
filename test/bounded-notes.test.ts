import { afterEach, describe, expect, it, vi } from 'vitest';

import { MAX_ENTRY_NOTES } from '../src/entries.js';
import { connect, dataOf, FakeCalDav, type Connected } from './harness.js';

/**
 * Every entry that cannot be read earns a note, and a calendar somebody else
 * writes to can hold thousands of them. Uncapped, they crowded the entries out
 * of the answer. Notes about the call — a calendar that refused, a filter the
 * server would not apply — come first and are never cut.
 */
const BROKEN = 'BEGIN:VCALENDAR\r\nBEGIN:VTODO\r\nUID:x\r\nSUMMARY:cut off';

describe('notes about individual entries', () => {
  let session: Connected | undefined;

  afterEach(async () => {
    await session?.close();
    session = undefined;
    vi.unstubAllGlobals();
  });

  async function notesFor(
    broken: number,
    options: ConstructorParameters<typeof FakeCalDav>[0] = {}
  ): Promise<string[]> {
    const fake = new FakeCalDav(options);
    fake.install();
    for (let i = 0; i < broken; i += 1) {
      fake.seed('work', `broken-${String(i).padStart(3, '0')}.ics`, BROKEN);
    }
    fake.seed(
      'private',
      'fine.ics',
      'BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//t//EN\r\nBEGIN:VTODO\r\nUID:f\r\nDTSTAMP:20261101T000000Z\r\nSUMMARY:fine\r\nEND:VTODO\r\nEND:VCALENDAR\r\n'
    );
    session = await connect();
    const listing = dataOf(
      await session.client.callTool({
        name: 'list_tasks',
        arguments: { undated: true },
      })
    );
    return (listing.notes as string[] | undefined) ?? [];
  }

  it('are kept in full up to the cap', async () => {
    const notes = await notesFor(MAX_ENTRY_NOTES);
    expect(notes).toHaveLength(MAX_ENTRY_NOTES);
    expect(notes.join(' ')).not.toContain('left out');
  });

  it('are cut at the cap and the rest is counted', async () => {
    const notes = await notesFor(50);
    expect(notes).toHaveLength(MAX_ENTRY_NOTES + 1);
    expect(notes.at(-1)).toBe(
      '30 more notes about individual entries were left out.'
    );
  });

  it('never push out a note about the call', async () => {
    const notes = await notesFor(50, {
      calendars: [{ name: 'work' }, { name: 'private' }, { name: 'third' }],
      failWith: (method, path) =>
        method === 'REPORT' && path.endsWith('/third/')
          ? { status: 403 }
          : undefined,
    });
    expect(notes[0]).toContain('third');
    expect(notes[1]).toBe('2 of 3 calendars answered.');
    expect(notes).toHaveLength(2 + MAX_ENTRY_NOTES + 1);
  });
});
