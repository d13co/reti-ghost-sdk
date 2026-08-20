/**
 * Map over an array with a concurrency limit, preserving input order.
 *
 * Local stand-in for the `p-map` package, which is ESM-only and therefore
 * cannot be `require`d from the CommonJS build.
 *
 * @param input - Items to map over
 * @param mapper - Async (or sync) function applied to each item
 * @param options.concurrency - Maximum number of pending mapper calls (default: unlimited)
 * @returns Results in the same order as `input`
 */
export async function pMap<T, R>(
  input: readonly T[],
  mapper: (item: T, index: number) => Promise<R> | R,
  { concurrency = Number.POSITIVE_INFINITY }: { concurrency?: number } = {},
): Promise<R[]> {
  if (!(concurrency >= 1)) {
    throw new TypeError(`Expected \`concurrency\` to be at least 1, got \`${concurrency}\``)
  }

  const results = new Array<R>(input.length)
  let nextIndex = 0
  let stopped = false

  const worker = async () => {
    while (!stopped && nextIndex < input.length) {
      const index = nextIndex++
      try {
        results[index] = await mapper(input[index], index)
      } catch (error) {
        // Stop handing out further work, mirroring p-map's default stopOnError
        stopped = true
        throw error
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, input.length) }, worker))

  return results
}
