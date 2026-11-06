// An algod proxy that makes a dtalgorand node look like stock algod, to test the SDK's stock paths: the dtalgorand-only
// endpoints (`/v2/capabilities`, `/v2/query`, the `/versions` feeds) answer 404 and a `round` query parameter 400, as
// stock algod does, a simulate more than `simulateWindow` rounds back is refused, and the time-travel response header
// is dropped. Every request is recorded.
// Usage: tsx examples/stock-proxy.ts [port, default 8787] [upstream, default https://mainnet-api.algonode.cloud]
import { msgpackRawDecodeAsMap } from "algosdk"
import http from "node:http"
import https from "node:https"
import type { AddressInfo } from "node:net"

/** Nodely's MainNet algod, which runs dtalgorand. */
export const DEFAULT_UPSTREAM = "https://mainnet-api.algonode.cloud"

export type ProxyRequest = {
  method: string
  path: string
  /** The status the proxy answered with. */
  status: number
  /** Set when the proxy refused the request itself, as stock algod would. */
  denied?: string
  /** For a simulate: the request's fields, and its `round` if any. */
  simulate?: { keys: string[]; round?: bigint }
}

export type StockProxy = {
  /** The proxy's base URL, e.g. `http://localhost:8787`. */
  url: string
  port: number
  requests: ProxyRequest[]
  close(): Promise<void>
}

export async function startStockProxy({
  port = 0,
  upstream = DEFAULT_UPSTREAM,
  // stock algod simulates at a recent round only (the rounds it still has in memory); an estimate
  simulateWindow = 320n,
}: { port?: number; upstream?: string; simulateWindow?: bigint } = {}): Promise<StockProxy> {
  const up = new URL(upstream)
  const client = up.protocol === "https:" ? https : http
  const requests: ProxyRequest[] = []
  let latest = 0n

  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://proxy")
    const entry: ProxyRequest = { method: req.method ?? "GET", path: `${url.pathname}${url.search}`, status: 0 }
    requests.push(entry)
    const deny = (status: number, message: string) => {
      entry.status = status
      entry.denied = message
      res.writeHead(status, { "content-type": "application/json" })
      res.end(JSON.stringify({ message }))
    }
    if (url.pathname === "/v2/capabilities" || url.pathname === "/v2/query" || /^\/v2\/.*\/versions/.test(url.pathname))
      return deny(404, "Not Found")
    if (url.searchParams.has("round")) return deny(400, "Unknown parameter detected: round")

    const chunks: Buffer[] = []
    req.on("data", (c: Buffer) => chunks.push(c))
    req.on("end", () => {
      const body = Buffer.concat(chunks)
      if (url.pathname === "/v2/transactions/simulate" && body.length > 0) {
        try {
          const decoded = msgpackRawDecodeAsMap(body) as Map<unknown, unknown>
          const round = decoded.get("round") as number | bigint | undefined
          entry.simulate = { keys: [...decoded.keys()].map(String), round: round === undefined ? undefined : BigInt(round) }
          if (entry.simulate.round !== undefined && latest > 0n && entry.simulate.round < latest - simulateWindow)
            return deny(400, `round ${entry.simulate.round} is before the node's oldest simulate round`)
        } catch {
          // a JSON simulate: passed through as is
        }
      }
      const upReq = client.request(
        {
          protocol: up.protocol,
          host: up.hostname,
          port: up.port || undefined,
          path: req.url,
          method: req.method,
          headers: { ...req.headers, host: up.host },
        },
        (upRes) => {
          const headers = { ...upRes.headers }
          delete headers["x-algod-tt-round"]
          entry.status = upRes.statusCode ?? 502
          res.writeHead(entry.status, headers)
          upRes.pipe(res)
        },
      )
      upReq.on("error", (e) => deny(502, e.message))
      upReq.end(body)
    })
  })

  // the latest round, for the simulate window (polled as JSON: the SDK's status reads may be msgpack)
  const pollStatus = () =>
    client
      .get({ protocol: up.protocol, host: up.hostname, port: up.port || undefined, path: "/v2/status" }, (r) => {
        let text = ""
        r.on("data", (c) => (text += c))
        r.on("end", () => {
          try {
            latest = BigInt(JSON.parse(text)["last-round"])
          } catch {
            // keep the last value
          }
        })
      })
      .on("error", () => {})
  pollStatus()
  const timer = setInterval(pollStatus, 5000)
  timer.unref()

  await new Promise<void>((resolve) => server.listen(port, resolve))
  const actual = (server.address() as AddressInfo).port
  return {
    url: `http://localhost:${actual}`,
    port: actual,
    requests,
    close: () =>
      new Promise<void>((resolve) => {
        clearInterval(timer)
        server.closeAllConnections()
        server.close(() => resolve())
      }),
  }
}

if (process.argv[1]?.endsWith("stock-proxy.ts")) {
  const port = Number(process.argv[2] ?? 8787)
  const upstream = process.argv[3] ?? DEFAULT_UPSTREAM
  startStockProxy({ port, upstream }).then((proxy) => {
    console.log(`stock algod proxy for ${upstream} on ${proxy.url}`)
    let seen = 0
    setInterval(() => {
      for (const r of proxy.requests.slice(seen)) console.log(`${r.status} ${r.method} ${r.path}${r.denied ? ` (${r.denied})` : ""}`)
      seen = proxy.requests.length
    }, 500)
  })
}
