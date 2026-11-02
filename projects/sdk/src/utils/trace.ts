/**
 * Debug logging for the requests the SDK makes itself (status, block headers, `/versions`, REST box reads), in the
 * generated reader's `[DEBUG]` format and level (`console.warn`), which already logs each query and simulate. Off
 * unless `debug` is set.
 *
 *   [DEBUG] reti-ghost-sdk id=k3j9x2a1 m=box-versions app=1234 box=v:42 maxRound=57982211 t=48.20ms → 12, more
 */

type Detail = Record<string, unknown>

const formatDetail = (detail: Detail): string =>
  Object.entries(detail)
    .filter(([, value]) => value !== undefined)
    .map(([key, value]) => ` ${key}=${String(value)}`)
    .join("")

const isAbort = (e: unknown) => (e as Error | undefined)?.name === "AbortError"

/**
 * Runs `request`, logging it once it settles when `debug` is on: what it was for, its parameters, how long it took and
 * (with `describe`) what came back. A failure is logged and rethrown; an abort is logged as cancelled.
 */
export async function traced<T>(
  debug: boolean,
  label: string,
  detail: Detail,
  request: () => Promise<T>,
  describe?: (value: T) => string,
): Promise<T> {
  if (!debug) return request()
  const id = Math.random().toString(36).substring(2, 10)
  const start = performance.now()
  const line = () =>
    `[DEBUG] reti-ghost-sdk id=${id} m=${label}${formatDetail(detail)} t=${(performance.now() - start).toFixed(2)}ms`
  try {
    const value = await request()
    console.warn(`${line()}${describe ? ` → ${describe(value)}` : ""}`)
    return value
  } catch (e) {
    if (isAbort(e)) console.warn(`${line()} cancelled`)
    else console.warn(`${line()} ✗ ${(e as Error)?.message ?? String(e)}`)
    throw e
  }
}

/** A `/versions` page, described: how many versions, their rounds, and whether there's more. */
export const describeVersions = (page: { versions: { round: bigint }[]; nextToken?: string }): string => {
  const { versions } = page
  if (versions.length === 0) return `0${page.nextToken ? ", more" : ""}`
  const span =
    versions.length === 1 ? `${versions[0].round}` : `${versions[0].round}…${versions[versions.length - 1].round}`
  return `${versions.length} (${span})${page.nextToken ? ", more" : ""}`
}
