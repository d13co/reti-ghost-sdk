# Reti Ghost SDK (dtalgorand variant)

Fast, read-only SDK for the Reti staking pool registry on Algorand, generated with Ghostkit and wrapped for ergonomic, high-throughput reads.

This variant (`0.3.0-dt.*`) reads the registry **as of any round since it was created** (round 46,518,891, Jan 2025) on a [dtalgorand](#node-requirements) node, so an app built on it can time travel: every page the Reti UI shows can be rendered as it was at round R. On top of that it has three history features: date → round lookup, a windowed change timeline, and chart series over many rounds.

On a dtalgorand node with read-only queries (`POST /v2/query`), reads go through queries: 1.5–3× faster than simulate, series responses ~6× smaller, and no fees or funded reader account needed. Otherwise they go through simulate, automatically.

It runs a "ghost" contract through queries or simulate (or optionally calls a deployed reader app) to batch and decode on-chain data efficiently. This follows the Ghostkit pattern; see the [Ghostkit README](https://github.com/d13co/ghostkit).

Reads at the latest round still work against any algod.


## Install

This is a prerelease line, published under the npm dist-tag `dt` (the stable SDK is `latest`, 0.2.x, from `main`):

```sh
npm install reti-ghost-sdk@dt
```

Reads at past rounds need the dtalgorand forks of algosdk and algokit-utils, which aren't on npm yet. Their tarballs are in this repo's [`vendor/`](https://github.com/d13co/reti-ghost-sdk/tree/dtalgorand/vendor) on the `dtalgorand` branch. The forks are packaged under their own names (`dtalgosdk`, `@d13co/dt-algokit-utils`) and installed under the stock names through overrides. Override both everywhere in your app, so that exactly one copy of each loads (your code, this SDK and any wallet library must share them):

```yaml
# pnpm: pnpm-workspace.yaml, or "pnpm": { "overrides": { ... } } in package.json
overrides:
  algosdk: https://raw.githubusercontent.com/d13co/reti-ghost-sdk/v0.3.0-dt.6/vendor/dtalgosdk-3.9.0-dt.2.0.1.0.tgz
  '@algorandfoundation/algokit-utils': https://raw.githubusercontent.com/d13co/reti-ghost-sdk/v0.3.0-dt.6/vendor/d13co-dt-algokit-utils-9.2.3-dt.2.0.1.0.tgz
```

With npm, put the same two entries under `"overrides"` in `package.json`. You can also copy the tarballs into your repo and point at them with `file:`.

The SDK detects the forks at runtime. With stock algosdk and algokit-utils it still reads the latest state, and reads at older rounds throw `TimeTravelUnavailableError` (see [Reading at a Past Round](#reading-at-a-past-round)). The peer ranges are loose (`>=`) for that reason; package managers may warn that the fork prereleases don't satisfy them, which is harmless. Older forks (`algosdk` 3.8.0-dt.2, algokit-utils 9.2.3-dt.2) still work, but read through simulate only.

The algokit-utils fork declares Node.js 22+.

See [the repo README](https://github.com/d13co/reti-ghost-sdk/tree/dtalgorand#readme) for what each fork changes and where its source is.

### Node requirements

| Feature | Needs |
|---|---|
| Reads at the latest round | any algod |
| Reads at a past round, date lookup, series | a dtalgorand node with time travel (`GET /v2/transactions/simulate/limits` reports `time-travel: true`) |
| Change timeline | a dtalgorand node (`/versions` endpoints) |
| Faster reads (queries) | a dtalgorand node with queries (`…/simulate/limits` reports a `query` object); without it the same reads go through simulate |

`sdk.getNode()` reports what was detected, the node's simulate limits, and `query` (the query limits) when reads go through queries; `sdk.supportsTimeTravel()` answers the main question, and `sdk.getMaxRounds()` how many rounds one simulate request covers. `sdk.prefetch()` fetches what the first reads wait for (the node's limits, the registry's creation round, and suggested params on a node without queries), so an app can start it early.


## Quick Start

```ts
import { AlgorandClient } from "@algorandfoundation/algokit-utils"
import { RetiGhostSDK } from "reti-ghost-sdk"

// a dtalgorand node; see "Node requirements"
const algorand = AlgorandClient.fromConfig({ algodConfig: { server: "https://dtalgod.example.com", port: 443, token: "" } })
const sdk = new RetiGhostSDK({ algorand, registryAppId: 2714516089n })

// latest
const { numValidators } = await sdk.getRegistryTotals()
const validators = await sdk.getValidators(Array.from({ length: numValidators }, (_, i) => i + 1))

// as of a date
const { round } = await sdk.roundAt(new Date("2025-06-01T00:00:00Z"))
const then = sdk.atRound(round) // every read of `then` is as of `round`
const { numValidators: n } = await then.getRegistryTotals()
const validatorsThen = await then.getValidators(Array.from({ length: n }, (_, i) => i + 1))

// or per call
const [state] = await sdk.getValidatorStates([1], { round: 55_000_000n })
```


## Reading at a Past Round

Every read takes a trailing `{ round }`, or pin a round for all reads with `sdk.atRound(round)` (or the constructor's `round`). A read is the state as of the end of that round. All the requests (queries or simulates) a read is split into run at the same round, so a large read is one consistent snapshot.

- Reads at past rounds always use the ghost, never a deployed reader (`ghostAppId`), which may not have existed or may have had other code then.
- A round before the registry existed throws `RetiNotDeployedError`, and a round past the node's latest throws `FutureRoundError`, both without a request. (A simulate at a future round would otherwise get an HTTP 500, which algokit-utils retries for ~14 s.)
- On a node without time travel, which can only read the latest state, a round within 20 of the latest (about a minute) reads the latest state, so a round taken from `status()` keeps working. An older round throws `TimeTravelUnavailableError`.
- The SDK reads the node's status only for a round past the latest it has seen, or, without time travel, at most once a second.
- Validators, pools and assets that don't exist yet at the round read as zeros (`exists: false` for pools, `deleted: true` for assets) instead of failing.

### Aborting reads

Every read also takes a `signal` (an `AbortSignal`): `{ round, signal }` for reads, the options object for `roundAt`, `timestampOf`, `firstRoundAtOrAfter`, `getTimestampsAtRounds`, `getChangeRounds` and the series methods. On abort the read rejects with the signal's reason (a `DOMException` named `AbortError` by default), on any backend, and a series rejects as a whole rather than returning failed points.

- With the dtalgorand fork of algokit-utils 9.2.3-dt.2 or later, the read's HTTP requests are cancelled and not retried, queries and simulates alike. With an older one the read still rejects on abort, but its requests run to the end.
- Reads other calls share (node detection, the registry's creation round, the node's status, cached block headers) aren't cancelled: the aborted read stops waiting for them, and they carry on for the others.
- On a stock node, `composer.simulate` can't pass the signal to fetch, so its simulate runs to the end.
- Past-round reads cost about the same as latest ones. Measured from Node.js on a local MainNet node, with queries / with the extended simulate: `getValidators` for all 227 validators 40–46 / 64–107 ms, `getValidatorConfig` 227 21–23 / 34–53 ms, `getPoolStates` for 286 pools 30–58 / 44–78 ms, `getStakerPositions` for 50 stakers 9–17 / 21–59 ms, `getBlockTimestamps(1000)` 10–39 / 12–65 ms, small reads (MBR, assets, 50 balances) 3–8 / 4–51 ms.


## API Overview

All methods are read-only, take an optional trailing `{ round }`, and return results in input order. Array inputs are chunked automatically to the node's limits.

### Registry

- `getRegistryTotals()`: `{ numValidators, numStakers, staked }` from the registry's global state.
- `getNumValidators()`: `numValidators` from the above.
- `getMbrAmountsAndProtocolConstraints()`: MBR amounts and protocol constraints.
- `getRegistryCreationRound()`: the earliest readable round (cached; undefined on a node without `/versions`).

### Validators

- `getValidators(validatorIds)`: config, state, `poolInfo` (`[poolAppId, totalStakers, totalAlgoStaked]` tuples) and node assignments per validator.
- `getValidatorConfig(validatorIds)`, `getValidatorStates(validatorIds)`, `getNodePoolAssignments(validatorIds)`.
- `getPools(validatorIds)`: for each validator, its `PoolInfo` objects.
- `getValidatorTotals(validatorIds)`: `{ validatorId, numPools, totalStakers, totalAlgoStaked }`, a small read made for charts.

### Pools

- `getPoolStates(poolAppIds)`: global state and account balance per pool: `exists`, `validatorId`, `poolId`, `numStakers`, `staked`, `minEntryStake`, `lastPayout`, `epochNumber`, `algodVer`, `roundsPerDay`, `binRoundStart`, `rewardAccumulator`, `stakeAccumulator`, `ewma` (the APY moving average the UI reads), `balance`, `minBalance`.
- `getPoolTotals(poolAppIds)`: `{ poolAppId, numStakers, staked }`, made for charts.
- `getPoolBalancesAndLastPayouts(poolAppIds)`, `getPoolAlgodVersions(poolAppIds)`.
- `getPoolStakers(poolAppId)`: the pool's `stakers` box (one REST read), empty slots left out.

### Stakers and accounts

- `getStakerPositions(stakers)`: every pool each staker is in, with their `StakedInfo` (balance, total rewarded, reward token balance, entry round).
- `getAccountBalances(accounts)`: `{ account, balance, minBalance }`.
- `getAssetHoldings([{ account, assetId }])`: `{ account, assetId, optedIn, balance }`.

### Assets and blocks

- `getAssets(assetIds)`: `{ index, deleted: true }` or `{ index, params: { creator, total, decimals, unitName, name } }`.
- `getBlockTimestamps(num)`: timestamps of the `num` blocks before the round (up to 1,000), oldest first.
- `getTimestampsAtRounds(rounds)` and `firstRoundAtOrAfter(start, target)`: see [Date → round](#date--round).


## History

### Date → round

`sdk.roundAt(date)` returns the last round whose block timestamp is at or before `date`; `sdk.timestampOf(round)` goes the other way. The lookup reads block headers (any round, ~50 ms each): a few secant steps, then one parallel read of the rounds around the estimate. Measured: 7–11 header reads, 0.25–0.4 s. Headers are cached in `sdk.clock`.

`roundAt` searches from the registry's creation round, and returns that round for an earlier date. Pass `{ minRound }` to search further back, `{ clamp: false }` to get a `RangeError` for a date before `minRound`, and `{ onProbe }` to see each header read.

Two reads let an app do the search itself with fewer requests, e.g. against its own cache of round ↔ time pairs:

- `getTimestampsAtRounds(rounds)`: the block timestamps of any rounds, from one request per `max-rounds` rounds (queries: 16 on the local MainNet node, in parallel; simulate: `getMaxRounds()`, 256 on the dtalgorand MainNet nodes), each `{ round, ok, value }` like a series point.
- `firstRoundAtOrAfter(start, target, { knownRound? })`: the first round from `start` whose timestamp is at or after `target`, from one request (query or simulate) that scans up to 1,000 rounds. Undefined if none of them reaches it. Pass a `knownRound` the node has (e.g. the latest you've seen) to stop the scan there; without it, a scan that would end past the node's tip costs a status read and a second request.

Both add what they read to `sdk.clock`. Measured from Node.js against a dtalgorand MainNet node, rounds spread over the registry's life: 16 timestamps in 57–107 ms (16 header reads 8 at a time: 54–207 ms), a full 1,000-round scan in 70–195 ms. On a local MainNet node, 16 timestamps take 7–8 ms with queries, 21–31 ms with the extended simulate.

### Change timeline

`sdk.getChangeRounds(target, options)` lists the rounds at which something changed, newest first by default:

| `target` | What changes |
|---|---|
| `{ validator: id }` | the validator's record: config, state, pools, node assignments |
| `{ registry: true }` | validator count, total stakers and stake |
| `{ pool: appId }` | the pool's global state: payouts, stake, APY |
| `{ poolStakers: appId }` | the pool's stakers box |
| `{ staker: address }` | the set of pools the staker is in |

It returns rounds and timestamps only. Read the state at a chosen round with `{ round }`. The full history is large (the registry ~80k changes since Jan 2025, one validator ~10k), so a call needs `minRound`, or uses `order: 'desc'` with `limit` ≤ 1,000. Measured: the last 20 changes of a validator in one request (~80 ms), a 2-week window (~180 changes) in ~40 ms. Page with `next`.

### Series

For charts, one request runs a small read at many rounds, up to the node's `max-rounds` per request: with queries `getNode().query.maxRounds` (16 on the local MainNet node, requests in parallel), with simulate `getMaxRounds()` (256 on the dtalgorand MainNet nodes):

- `getValidatorTotalsSeries(validatorIds, rounds)`
- `getPoolTotalsSeries(poolAppIds, rounds)`
- `getRegistryTotalsSeries(rounds)`

`rounds` is a list, or `{ from, to, points }` spread evenly; points come back deduplicated and in round order. Each point is `{ round, ok: true, value, timestamp }` or `{ round, ok: false, error }`, where `timestamp` is the round's block timestamp in seconds, read in the same request and cached in `sdk.clock`. A round that can't be read is an `ok: false` point with the error a single read would throw (`RetiNotDeployedError`, `FutureRoundError`, `TimeTravelUnavailableError`); the other rounds still read. Without time travel, the rounds near the latest share one read of the latest state. At most 256 points by default (`maxPoints` to change).

Measured from Node.js on a local MainNet node, all from registry creation to now (time and total response size):

| Series | With queries | With the extended simulate |
|---|---|---|
| 227 validators × 64 rounds | 0.2 s, 0.55 MB | 0.7–0.8 s, 3.3 MB |
| 227 validators × 256 rounds | 0.8–1.0 s, 2.2 MB | 2.5–2.9 s, 13.4 MB |
| 286 pools × 256 rounds | 1.1–1.2 s, 2.1 MB | 1.7–1.8 s, 5.5 MB |
| registry totals × 105 rounds | 31–37 ms, 0.1 MB | 120–265 ms, 1.1 MB |

On simulate, most of the validator series' response is the simulate's record of its inner calls, so in a browser keep validator series to about 64–128 points there, or chart the registry totals. Queries return no such record: a validator series of 256 points is ~2 MB.


## Ghost vs Deployed Reader

By default, calls run against a ghost (non-deployed) reader contract, through queries or simulate. For latest-state reads you can call a deployed reader instead by passing `ghostAppId`. Reads at a past round always use the ghost.

Ghost Mainnet App ID: 3374692547 **currently updatable by author.** It runs the 0.2.0 reader, which lacks the methods added in 0.3.0, so deploy the new reader before pointing `ghostAppId` at it.


## Options

`new RetiGhostSDK({ algorand, registryAppId, round?, ghostAppId?, readerAccount?, backend?, ghostFee?, cacheParamsTimeout?, debug? })`

- `readerAccount`: the account reads run as. Defaults to the network's fee sink, which is funded at every round. On simulate it must hold `ghostFee` at the round read; queries check no fees, so it needn't be funded there.
- `backend`: `auto` (default) uses read-only queries when the forks and the node support them, else a dtalgorand node's extended simulate, else one simulate per group; `query` always queries (throws on a node without queries), `dt` always uses the extended simulate, `stock` one simulate per group, or your own ghostkit backend.
- `ghostFee`: what each simulated group may spend on fees (never charged). Default 10 Algo, enough for 10,000 inner calls. Simulate only: queries charge and check no fees.
- `cacheParamsTimeout`: ms that latest-state reads reuse suggested params for (default 3,000).


## Limits and Known Issues

- Chunking follows the node's simulate limits (`max-txn-groups`, `resource-limit-multiplier`) and the AVM's 256 inner transactions per group: `getValidators` takes 64 validators per group, the other validator reads 256; a dtalgorand node sends up to 16 groups per request. The chunks stay the same with queries, so a fallback to simulate needs no re-chunking; there each app call runs alone, with the node's per-call budget (`getNode().query.maxCallBudget`, 320,000 on the local MainNet node), and requests follow the query limits.
- A query for a round past the node's tip (`firstRoundAtOrAfter` without `knownRound` near the tip, or `getTimestampsAtRounds` with future rounds) is answered through simulate instead, with the same result.
- An asset or pool app that existed and was later destroyed or deleted can't be read at rounds after that; the simulate fails as "unavailable". Ids not created yet at a round are handled.


## Development

- Build: `algokit project run build` at the repo root, or `pnpm --filter smart_contracts build && pnpm --filter reti-ghost-sdk build`. The SDK build copies the generated reader client from the contracts project into `src/generated/`.
- Examples (`examples/`, run with `npx tsx`; point `DT_ALGOD_SERVER` at a dtalgorand MainNet node, and set `DT_ALGOD_TOKEN` if it needs one):
  - `at-round.ts [round|latest]`: everything the UI reads, at a round
  - `date-to-round.ts [date]`, `timeline.ts [validatorId]`, `series.ts [points]`
  - `abort.ts`: aborting reads (series, pinned reads, `roundAt` between probes, shared header reads, the stock backend). Last run: all 13 pass, on a local MainNet node with queries and on one without.
  - `verify.ts [points]`: cross-checks the SDK's reads with REST reads at the same rounds (validator boxes byte for byte, pool global state and balances, staker positions and balances) over the registry's life. Last run: 255 rounds through queries, 32 through the extended simulate, all match.
  - `query-vs-simulate.ts [points]`: the same reads through queries and through the extended simulate, every value compared, with timings and the requests each sent; on a node without queries, checks that reads fall back to simulate. Last run: all 74 checks pass with queries, 73 on the fallback.


## License

ISC
