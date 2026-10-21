import { AlgorandClient } from "@algorandfoundation/algokit-utils"

/** The Reti registry on MainNet. */
export const REGISTRY_APP_ID = 2714516089n

/** A dtalgorand MainNet node: `DT_ALGOD_SERVER` (e.g. http://localhost:4000), `DT_ALGOD_TOKEN`. */
export function dtAlgorand(): AlgorandClient {
  const server = process.env.DT_ALGOD_SERVER
  if (!server) throw new Error("Set DT_ALGOD_SERVER to a dtalgorand MainNet node, e.g. http://localhost:4000")
  const url = new URL(server)
  const port = url.port || (url.protocol === "https:" ? "443" : "80")
  return AlgorandClient.fromConfig({
    algodConfig: { server: `${url.protocol}//${url.hostname}`, port, token: process.env.DT_ALGOD_TOKEN ?? "" },
  })
}

/** Runs `fn`, logging how long it took. */
export async function timed<T>(label: string, fn: () => Promise<T>): Promise<T> {
  const start = performance.now()
  try {
    return await fn()
  } finally {
    console.debug(`[${label}] ${(performance.now() - start).toFixed(0)}ms`)
  }
}
