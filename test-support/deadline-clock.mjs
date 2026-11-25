// Advance deadline calculations and their timers together, without waiting for machine time.
export function deadlineClock(t) {
  let elapsed = 0;
  t.mock.timers.enable({ apis: ['setTimeout'] });
  t.mock.method(performance, 'now', () => elapsed);
  t.mock.method(AbortSignal, 'timeout', ms => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(new DOMException('The operation was aborted due to timeout', 'TimeoutError')), ms).unref();
    return controller.signal;
  });
  return {
    now: () => elapsed,
    tick(ms) {
      elapsed += ms;
      t.mock.timers.tick(ms);
    },
  };
}
