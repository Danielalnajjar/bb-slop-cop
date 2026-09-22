/** Stop awaiting an uncancellable external call; its late result is still handled. */
export async function waitForAbort<T>(
  work: () => Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  signal?.throwIfAborted();
  if (signal === undefined) return work();
  let onAbort: () => void = () => {};
  const aborted = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    const result = await Promise.race([work(), aborted]);
    signal.throwIfAborted();
    return result;
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
}

export async function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await waitForAbort(() => new Promise<void>((resolve) => {
      timer = setTimeout(resolve, ms);
    }), signal);
  } finally {
    clearTimeout(timer);
  }
}
