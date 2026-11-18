import vm from 'node:vm';

import { ToolInputError } from './errors.js';
import { resetGuards } from './ical-guard.js';

/**
 * A hard limit on the time synchronous work may take, enforced by V8.
 *
 * ical.js has loops whose length a stored entry chooses. ical-guard.ts bounds
 * the ones found so far, and five rounds of review kept finding another. This
 * is the line that does not depend on finding them: the work runs as the
 * callback of a script started with a `timeout`, and when the time is up V8
 * terminates whatever is executing — this server's code, ical.js, any loop.
 * The termination cannot be caught on the way out and runs no `finally`, so
 * the guard state is reset here afterwards; everything the work had written
 * to the outside before that point stays as it was.
 *
 * Starting the watchdog costs about a millisecond, so listings use
 * {@link eachBounded}, which puts a whole batch under one limit.
 */

export class HardLimitExceeded extends ToolInputError {
  constructor() {
    super(
      'caldav-mcp: the stored entry took longer to evaluate than this server ' +
        'allows. This is the stored entry, not the arguments of this call.'
    );
    this.name = 'HardLimitExceeded';
  }
}

const context = vm.createContext({});
const script = new vm.Script('run()');

/** Runs `work` and returns its result, or throws {@link HardLimitExceeded}. */
export function withHardLimit<T>(ms: number, work: () => T): T {
  let result: T | undefined;
  context.run = () => {
    result = work();
  };
  try {
    script.runInContext(context, { timeout: Math.max(1, Math.ceil(ms)) });
  } catch (error) {
    if ((error as { code?: string }).code === 'ERR_SCRIPT_EXECUTION_TIMEOUT') {
      resetGuards();
      throw new HardLimitExceeded();
    }
    throw error;
  } finally {
    context.run = undefined;
  }
  return result as T;
}

/** The time one entry may take on its own, parse to last occurrence. */
export const ENTRY_LIMIT_MS = 1000;

/**
 * The same for a tool that reads or writes one entry, which may carry a large
 * inline attachment and is worth waiting longer for.
 */
export const SINGLE_ENTRY_LIMIT_MS = 3000;

/** Entries a call gives up on before it stops evaluating any more. */
export const MAX_OVERRUNS = 3;

/**
 * Synchronous evaluation one call may spend in total. Entries just under
 * their own limit never count as overruns, so without this a calendar of them
 * cost a second each.
 */
export const CALL_EVALUATION_MS = 10_000;

/**
 * Overruns and evaluation time left, shared across one call. Time is counted
 * while evaluating only: the server answering slowly is not the entries'
 * doing, and is bounded by the call's own budget.
 */
export interface Overruns {
  count: number;
  leftMs: number;
}

export function newOverruns(): Overruns {
  return { count: 0, leftMs: CALL_EVALUATION_MS };
}

/**
 * Runs `work` over `items` in batches under one hard limit each.
 *
 * `work` computes and returns its item's effects as a function; the effects
 * run once per item, after the computation, so an item a batch is restarted
 * in is not counted twice. When a batch is stopped, the entry it stopped in
 * gets a limit of its own; stopped again, it is handed to `onOverrun` and
 * skipped. After {@link MAX_OVERRUNS} such entries in a call, or once the
 * call's evaluation time is spent, the rest are handed to `onAbandoned`
 * unevaluated, so a calendar of hostile entries costs seconds in total.
 *
 * `work` must catch its own errors; a termination passes through any catch.
 */
export function eachBounded<T>(
  items: readonly T[],
  overruns: Overruns,
  work: (item: T) => (() => void) | undefined,
  onOverrun: (item: T) => void,
  onAbandoned: (count: number) => void
): void {
  const applied = new Set<number>();
  let index = 0;
  while (index < items.length) {
    if (overruns.count >= MAX_OVERRUNS || overruns.leftMs <= 0) {
      onAbandoned(items.length - index);
      return;
    }
    const start = index;
    const progress = { index, expired: false };
    const batchStarted = Date.now();
    try {
      withHardLimit(ENTRY_LIMIT_MS, () => {
        for (; progress.index < items.length; progress.index += 1) {
          if (Date.now() - batchStarted >= overruns.leftMs) {
            progress.expired = true;
            return;
          }
          const effects = work(items[progress.index] as T);
          if (!applied.has(progress.index)) {
            // Marked first: stopped inside the effects, an item loses some of
            // them rather than gaining them twice.
            applied.add(progress.index);
            effects?.();
          }
        }
      });
    } catch (error) {
      overruns.leftMs -= Date.now() - batchStarted;
      if (!(error instanceof HardLimitExceeded)) throw error;
      if (progress.index === start && !applied.has(start)) {
        overruns.count += 1;
        onOverrun(items[start] as T);
        index = start + 1;
      } else {
        index = applied.has(progress.index)
          ? progress.index + 1
          : progress.index;
      }
      continue;
    }
    overruns.leftMs -= Date.now() - batchStarted;
    if (progress.expired) {
      onAbandoned(items.length - progress.index);
    }
    return;
  }
}
