type Waiter<V> = {
  resolve: (value: V) => void
  reject: (error: unknown) => void
  signal?: AbortSignal
  done: boolean
}

type Batch<K, V> = { round: bigint | undefined; waiters: Map<K, Waiter<V>[]> }

/** Loads many keys at one round (undefined: the latest), one value per key. */
export type BatchLoader<K, V> = (keys: K[], round: bigint | undefined, signal: AbortSignal) => Promise<Map<K, V>>

/**
 * Coalesces loads of single keys made within `windowMs` of each other at the same round into one `loader` call
 * (DataLoader-style), each key loaded once however many callers ask for it. A caller's abort rejects only its own load;
 * the batch's request is cancelled once every caller in it has aborted.
 */
export class RoundBatcher<K, V> {
  private pending = new Map<string, Batch<K, V>>()

  constructor(
    private readonly loader: BatchLoader<K, V>,
    private readonly windowMs: number,
  ) {}

  load(key: K, round: bigint | undefined, signal?: AbortSignal): Promise<V> {
    signal?.throwIfAborted()
    const id = round === undefined ? "latest" : round.toString()
    let batch = this.pending.get(id)
    if (!batch) {
      const created: Batch<K, V> = { round, waiters: new Map() }
      batch = created
      this.pending.set(id, created)
      setTimeout(() => {
        if (this.pending.get(id) === created) this.pending.delete(id)
        void this.flush(created)
      }, this.windowMs)
    }
    const waiters = batch.waiters.get(key) ?? []
    batch.waiters.set(key, waiters)
    return new Promise<V>((resolve, reject) => {
      const onAbort = () => {
        if (waiter.done) return
        waiter.done = true
        reject(signal!.reason)
      }
      const settle =
        <T>(fn: (value: T) => void) =>
        (value: T) => {
          signal?.removeEventListener("abort", onAbort)
          fn(value)
        }
      const waiter: Waiter<V> = { resolve: settle(resolve), reject: settle(reject), signal, done: false }
      waiters.push(waiter)
      signal?.addEventListener("abort", onAbort, { once: true })
    })
  }

  private async flush(batch: Batch<K, V>): Promise<void> {
    const live = [...batch.waiters].flatMap(([key, waiters]) => {
      const open = waiters.filter((w) => !w.done)
      return open.length ? [{ key, waiters: open }] : []
    })
    if (live.length === 0) return
    const all = live.flatMap((entry) => entry.waiters)
    const controller = new AbortController()
    let open = all.length
    const listeners = all.map((waiter) => {
      const onAbort = () => {
        if (--open === 0) controller.abort(waiter.signal!.reason)
      }
      waiter.signal?.addEventListener("abort", onAbort, { once: true })
      return onAbort
    })
    try {
      const values = await this.loader(
        live.map((entry) => entry.key),
        batch.round,
        controller.signal,
      )
      for (const { key, waiters } of live) {
        const has = values.has(key)
        for (const waiter of waiters) {
          if (waiter.done) continue
          waiter.done = true
          if (has) waiter.resolve(values.get(key)!)
          else waiter.reject(new Error(`batch load left out ${String(key)}`))
        }
      }
    } catch (e) {
      for (const waiter of all) {
        if (waiter.done) continue
        waiter.done = true
        waiter.reject(e)
      }
    } finally {
      all.forEach((waiter, i) => waiter.signal?.removeEventListener("abort", listeners[i]))
    }
  }
}
