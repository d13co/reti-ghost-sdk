/**
 * Waits for a promise other callers share (a cache, a deduplicated read) without tying it to one caller's signal:
 * rejects with the signal's reason as soon as it aborts, while the shared work carries on for the others.
 */
export function raceAbort<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise
  if (signal.aborted) return Promise.reject(signal.reason)
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason)
    signal.addEventListener("abort", onAbort, { once: true })
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort)
        resolve(value)
      },
      (error) => {
        signal.removeEventListener("abort", onAbort)
        reject(error)
      },
    )
  })
}

/**
 * Runs a read, failing with the signal's reason (an `AbortError` unless the caller gave another) once it has aborted.
 * A simulate on a node without dtalgorand's extended simulate reports an abort as a failed call (`GhostkitError`), and
 * this turns it back into the abort.
 */
export async function abortable<T>(signal: AbortSignal | undefined, read: () => Promise<T>): Promise<T> {
  signal?.throwIfAborted()
  try {
    return await read()
  } catch (e) {
    signal?.throwIfAborted()
    throw e
  }
}

/** The simulate options that carry a read's signal to a generated reader method. */
export const sim = ({ signal }: { signal?: AbortSignal }) => (signal ? { extraSimulateArgs: { signal } } : {})

/** The simulate options that carry a read's signal to `atRounds` / `batch`. */
export const simOptions = ({ signal }: { signal?: AbortSignal }) => (signal ? { signal } : undefined)
