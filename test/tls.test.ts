import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * The one code path that weakens TLS, in its own file because `vi.mock` is
 * hoisted and file-wide: undici's `fetch` and `Agent` are replaced so the
 * test can see which fetch a request went through and with which dispatcher.
 */
vi.mock('undici', async (importOriginal) => {
  const original = await importOriginal<typeof import('undici')>();
  return {
    ...original,
    fetch: vi.fn(async () =>
      Promise.resolve(new Response('', { status: 200, headers: { dav: '1' } }))
    ),
    Agent: class FakeAgent {
      constructor(public readonly options: unknown) {}
    },
  };
});

import { Agent, fetch as undiciFetch } from 'undici';

import { CalDavApi } from '../src/api.js';
import { testConfig } from './harness.js';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.mocked(undiciFetch).mockClear();
});

describe('CALDAV_INSECURE_TLS', () => {
  it('uses a relaxed dispatcher only under the switch, and only for the origin', async () => {
    const globalFetch = vi.fn(async () =>
      Promise.resolve(new Response('', { status: 200, headers: { dav: '1' } }))
    );
    vi.stubGlobal('fetch', globalFetch);

    const relaxed = new CalDavApi(testConfig({ insecureTls: true }));
    await relaxed.options('https://dav.example.net/');
    expect(globalFetch).not.toHaveBeenCalled();
    expect(undiciFetch).toHaveBeenCalledTimes(1);
    const init = vi.mocked(undiciFetch).mock.calls[0]?.[1] as {
      dispatcher?: InstanceType<typeof Agent> & { options?: unknown };
    };
    expect(init.dispatcher).toBeInstanceOf(Agent);
    expect(init.dispatcher?.options).toEqual({
      connect: { rejectUnauthorized: false },
    });

    // Another origin never reaches the relaxed dispatcher — nor any fetch.
    await expect(relaxed.options('https://elsewhere.example/')).rejects.toThrow(
      /only the configured server/
    );
    expect(undiciFetch).toHaveBeenCalledTimes(1);
  });

  it('leaves certificate checking alone without the switch', async () => {
    const globalFetch = vi.fn<
      (input: string, init?: Record<string, unknown>) => Promise<Response>
    >(async () =>
      Promise.resolve(new Response('', { status: 200, headers: { dav: '1' } }))
    );
    vi.stubGlobal('fetch', globalFetch);
    const strict = new CalDavApi(testConfig({ insecureTls: false }));
    await strict.options('https://dav.example.net/');
    expect(globalFetch).toHaveBeenCalledTimes(1);
    expect(undiciFetch).not.toHaveBeenCalled();
    expect(globalFetch.mock.calls[0]?.[1]?.dispatcher).toBeUndefined();
  });
});
