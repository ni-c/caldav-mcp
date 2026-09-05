import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ToolFilterError } from 'mcp-tool-allowlist';

import { createServer } from '../src/server.js';
import {
  ALL_TOOLS,
  ESSENTIAL_TOOLS,
  READ_TOOLS,
  WRITE_TOOLS,
} from '../src/tools/catalogue.js';
import { connect, FakeCalDav, testConfig, type Connected } from './harness.js';

/**
 * The tool filter itself lives in `mcp-tool-allowlist` and is tested there.
 *
 * What only this repository can assert is the wiring: that the catalogue and
 * the tools actually registered are the same set, that the messages name *this*
 * server's variables, and that the gate hangs off the right switch. Note that
 * the tool names appear here exactly once — in the imports — because a second
 * copy would drift from the catalogue and then agree with itself.
 */

let fake: FakeCalDav;
let session: Connected | undefined;

beforeEach(() => {
  fake = new FakeCalDav();
  fake.install();
});

afterEach(async () => {
  await session?.close();
  session = undefined;
  vi.unstubAllGlobals();
});

async function names(config: Parameters<typeof connect>[0]): Promise<string[]> {
  session = await connect(config);
  const { tools } = await session.client.listTools();
  const list = tools.map((tool) => tool.name).sort();
  await session.close();
  session = undefined;
  return list;
}

describe('the catalogue', () => {
  it('is exactly the set of tools the server registers', async () => {
    expect(await names({})).toEqual([...ALL_TOOLS].sort());
  });

  it('splits into read and write with nothing left over', () => {
    expect([...READ_TOOLS, ...WRITE_TOOLS].sort()).toEqual(
      [...ALL_TOOLS].sort()
    );
    expect(new Set(ALL_TOOLS).size).toBe(ALL_TOOLS.length);
  });

  it('holds names the env-var syntax cannot misread', () => {
    for (const name of ALL_TOOLS) {
      expect(name, name).toMatch(/^[a-z0-9_]+$/);
    }
    // `essential` is a preset keyword, so it must not also be a tool.
    expect(ALL_TOOLS).not.toContain('essential');
  });

  it('has an essential preset that is a real, sensibly sized subset', () => {
    expect(new Set(ESSENTIAL_TOOLS).size).toBe(ESSENTIAL_TOOLS.length);
    expect(ESSENTIAL_TOOLS.length).toBeGreaterThanOrEqual(5);
    expect(ESSENTIAL_TOOLS.length).toBeLessThanOrEqual(8);
    for (const tool of ESSENTIAL_TOOLS) {
      expect(ALL_TOOLS, tool).toContain(tool);
    }
  });

  it('leaves everything irreversible out of the essential preset', () => {
    // Editorial rather than mechanical: the preset is what a model reaches for
    // first, so nothing that cannot be undone belongs in it.
    for (const tool of ESSENTIAL_TOOLS) {
      expect(tool, tool).not.toMatch(/^delete_/);
      expect(tool, tool).not.toBe('move_event');
      expect(tool, tool).not.toBe('respond_to_event');
    }
  });
});

describe('narrowing the tool list', () => {
  it('selects by exact name', async () => {
    expect(await names({ allowTools: 'list_events,get_event' })).toEqual([
      'get_event',
      'list_events',
    ]);
  });

  it('selects by prefix', async () => {
    const selected = await names({ allowTools: 'list_*' });
    expect(selected).toEqual([
      'list_calendars',
      'list_events',
      'list_journals',
      'list_tasks',
    ]);
  });

  it('selects the essential preset', async () => {
    expect(await names({ allowTools: 'essential' })).toEqual(
      [...ESSENTIAL_TOOLS].sort()
    );
  });

  it('subtracts a deny list from an allow list', async () => {
    expect(
      await names({ allowTools: 'list_*', denyTools: 'list_journals' })
    ).toEqual(['list_calendars', 'list_events', 'list_tasks']);
  });

  it('treats an empty value as unset, the way the library defines it', async () => {
    // `mcp-tool-allowlist` resolves an empty or whitespace value to *unset*
    // rather than to "allow nothing", and says why in its own test: a blank
    // `CALDAV_ALLOW_TOOLS=` line in a compose file must not take the server
    // down. This server follows the library rather than reinterpreting it, and
    // this test is here so that stays a decision rather than a surprise.
    expect(await names({ allowTools: '' })).toEqual([...ALL_TOOLS].sort());
    expect(await names({ allowTools: '  ' })).toEqual([...ALL_TOOLS].sort());
    expect(await names({ allowTools: ',,' })).toEqual([...ALL_TOOLS].sort());
  });
});

describe('an unusable list aborts the server', () => {
  const build = (config: Parameters<typeof testConfig>[0]) => () =>
    createServer(testConfig(config));

  it('refuses a name that is not a tool, and lists the real ones', () => {
    expect(build({ allowTools: 'list_evnets' })).toThrow(ToolFilterError);
    try {
      build({ allowTools: 'list_evnets' })();
    } catch (error) {
      const message = (error as Error).message;
      expect(message).toContain('list_evnets');
      expect(message).toContain('CALDAV_ALLOW_TOOLS');
      expect(message).toContain('list_events');
    }
  });

  it('refuses a malformed pattern', () => {
    expect(build({ allowTools: '*_event' })).toThrow(ToolFilterError);
    expect(build({ allowTools: 'list_*_x' })).toThrow(ToolFilterError);
  });

  it('throws rather than exiting, so it can be tested at all', () => {
    // `process.exit` in createServer would be untestable: the suite builds
    // servers in-process. `src/index.ts` turns this into exit 1.
    expect(build({ allowTools: 'nope' })).toThrow(ToolFilterError);
  });

  it('says a suppressed write tool exists rather than calling it unknown', () => {
    // The one answer that would be wrong. Under read-only the write tools never
    // reach registerTool, so a catalogue derived from the registrations would
    // report "unknown tool" and send the reader after a typo that is not there.
    try {
      createServer(testConfig({ readOnly: true, allowTools: 'delete_event' }));
      expect.unreachable('should have thrown');
    } catch (error) {
      const message = (error as Error).message;
      expect(message).not.toMatch(/unknown/i);
      expect(message).toContain('CALDAV_READ_ONLY');
    }
  });
});

describe('read-only mode', () => {
  it('registers only the read tools', async () => {
    expect(await names({ readOnly: true })).toEqual([...READ_TOOLS].sort());
  });

  it('combines with an allow list naming only read tools', async () => {
    expect(
      await names({ readOnly: true, allowTools: 'list_events,get_event' })
    ).toEqual(['get_event', 'list_events']);
  });

  it('refuses an allow list that names a tool read-only suppresses', async () => {
    // Rather than quietly dropping it: whoever wrote the name expects it to be
    // there, and a server that starts without it lies about its own surface.
    await expect(
      names({ readOnly: true, allowTools: 'list_events,create_event' })
    ).rejects.toThrow(/read-only mode suppresses/);
  });
});
