# reti-ghost-sdk 0.3.0-dt.1: review issues

Review of the uncommitted `dt` branch, 2026-10-21. Live checks ran against the MainNet dtalgorand nodes at `10.114.0.27:8100` and `:4000`; stock-node checks ran against a public MainNet algod. Fixed so far: 1b in `0.3.0-dt.2`; 1, 2, 3 and 6 in `0.3.0-dt.4` (marked below).

The Reti UI time-travel branch (`~/code/reti`, worktree `time-travel`, branch `feat/ui-time-travel`) vendors a build of this SDK. It relies on `config.id === 0` for a validator that doesn't exist yet, and uses `roundAt`, `getValidatorTotalsSeries` and `getRegistryTotalsSeries`. Any fix here means repacking its tarball.

## Bugs

### 1. One round before the registry existed fails a whole series (confirmed) — fixed in 0.3.0-dt.4

Fixed: rounds go through `planRounds`, and a series turns a round it can't read into an `ok: false` point with the same error a single read throws (`RetiNotDeployedError` here); the other rounds still read. `roundAt` clamps since dt.2.


- Where: `projects/sdk/src/index.ts:427, 440, 450`, with `checkedRounds` at `:479-490`.
- The series methods pass every round to `checkedRounds`, which throws if any one is before the registry's creation round (or too old for a stock node). The README says "A failed round doesn't fail the series".
- `roundAt` doesn't clamp to the creation round, though `DT-PLAN.md` says it should: `sdk.roundAt(new Date("2024-06-01"))` returns round 39352938.
- Scenario: an "all time" chart with `from = (await sdk.roundAt(dateBefore2025)).round`. `getRegistryTotalsSeries([46518891n, 46518890n])` throws `RetiNotDeployedError` for the whole call; the validator and pool series do the same.
- Fix: return such rounds as `{ ok: false, error }` points, or clamp `from` to the creation round. Have `sdk.roundAt` pass the creation round as `minRound`.

### 1b. `roundAt` always reads round 1's header (confirmed, from the Reti UI session) — fixed in 0.3.0-dt.2

Fixed in `0.3.0-dt.2`: `sdk.roundAt` takes `{ minRound, clamp, onProbe }`, searches from the creation round by default and returns it for an earlier date (the `roundAt` half of issue 1). The known-latest option below is not done.

- Where: `projects/sdk/src/index.ts` (`RetiGhostSDK.roundAt` calls `this.clock.roundAt(time)` with no options) and `projects/sdk/src/history/dateToRound.ts` (`minRound` defaults to 1).
- Every lookup's second probe is round 1's header (2019-06-11). In the browser on a cold cache that one read took ~960 ms, about a quarter of a 3.7 s lookup.
- Probe sequence for target 2026-07-21T07:36:47Z on `:8100`: latest, round 1, 63924883, 63300582, 63301878, then a 5-round window (63301874–78): 10 header reads.
- Fix: default `minRound` to `getRegistryCreationRound()` (same change as issue 1), and let `sdk.roundAt` take `{ minRound, onProbe }` and pass them through. The UI currently calls `sdk.clock.roundAt` directly to trace probes.
- Lower priority: `RoundClock.roundAt` starts with `latest()`, a status read plus a header read. A caller that just read status (the UI's chart query does) pays for it twice. Accept an optional known latest `{ round, timestamp }`.

### 2. Reads pinned to a round break on a stock node (confirmed) — fixed in 0.3.0-dt.4

Fixed: on a node without time travel, a round within 20 of the latest (`STOCK_ROUND_SLACK`) reads the latest state: ghost reads use the latest-state reader, and REST reads (`getRegistryTotals`, `getPoolStakers`) drop the round. Older rounds throw `TimeTravelUnavailableError`, so `getPoolStakers` no longer returns the latest box for them. Series share one latest-state read for those rounds. Checked on a public MainNet node: a pin from `status()` still reads 30 s later. `getRoundTimestamp` now reads `Txn.firstValid - 1` (the same round when pinned) so it also works unpinned.


- Where: `projects/sdk/src/index.ts:132` (`RECENT_ROUNDS = 1n`), `:234`, `:338`, `:479-485`.
- A pin goes stale in seconds: `atRound(lastRound)` stops working after about 2 rounds (~6 s). A `round` from `status()` passed straight back can fail, because the SDK calls `status()` again.
- `getRegistryTotals` / `getNumValidators` throw `DTUnsupportedError` for any explicit round, even `lastRound`, because the utils fork's `getGlobalState` requires time travel for a `round`.
- `getPoolStakers({ round })` sends `?round=`, which stock algod ignores, so it silently returns the latest box (`getBoxValue` doesn't check support).
- Fix: on a node without time travel, drop the round for REST reads when it is at or near `lastRound`, and allow a few rounds of slack in the check. Or document that pinning a round needs a DT node.

### 3. A round past the node's latest stalls ~14 s, then fails with a 500 (confirmed) — fixed in 0.3.0-dt.4

Fixed in the SDK: a round past the node's latest throws `FutureRoundError` in ~20 ms (a failed point in a series). The SDK keeps the latest round it has seen and reads status only for a round above it, or at most once a second on a node without time travel. Direct `sdk.ghost.atRound(future)` calls still stall until the server fix lands.


- Where: `projects/sdk/src/index.ts:468-496` (`checkedRounds` has no upper bound).
- A ghost read at a future round sends `POST /v2/transactions/simulate` with that `round`. The node answers in ~20 ms with HTTP 500 `{"message":"ledger does not have entry N (latest L, committed L)"}`. algokit-utils' `AlgoHttpClientWithRetry` retries 500s (5 tries, delays 0, 2, 4, 8 s), so the call fails after ~14 s.
- Root cause (confirmed by the go-algorand session): `Simulator.Simulate` (`ledger/simulation/simulator.go:847`) gets `ErrNoEntry` from `BlockHdr(round)`, and the handler (`handlers.go:1642`) turns anything that isn't an `InvalidRequestError` into a 500. Upstream algod does the same. Simulate with `rounds` is fine: a future entry fails in its own round result. `GET /v2/stateproofs/{round}` and `GET /v2/blocks/{round}/lightheader/proof` also give a 500 for a future round. `?round=` reads and `/versions` give 400, blocks and deltas 404.
- Scenario: a UI takes `lastRound` from one node behind a load balancer, then reads from a node a few rounds behind it, and the page hangs for 14 s.
- Fix: in `checkedRounds`, reject rounds above `status().lastRound` with a clear error (cache the status briefly). A server-side fix (return 400) is pending in the go-algorand session; keep the SDK check either way.
- Reproduction: the request body is saved at `/tmp/claude-1005/-home-bit-code-reti-ghost-sdk/26f0dce0-0c71-4321-ba8e-1f1ac4a1f8a6/scratchpad/sim-body.bin`; replay with `curl -X POST -H 'Content-Type: application/msgpack' --data-binary @sim-body.bin 'http://10.114.0.27:8100/v2/transactions/simulate?format=msgpack'`.

### 4. Pool reads fail for an id that isn't a live app (confirmed)

- Where: `projects/contracts/smart_contracts/reti_reader/contract.algo.ts:406-409` (`readPoolState`), and the same pattern at `:388`, `:329`, `:528`.
- `pool.address` compiles to `app_params_get AppAddress; assert`, which fails before the `exists` flag from `appCreator` is checked, so that check does nothing. `getPoolBalancesAndLastPayouts`, `getAlgodVersion` and `getPoolTotals` fail the same way ("app 1000 does not exist").
- Scenario: `getPoolStates([1000])`, or an asset id such as `31566704`, fails the whole chunk instead of returning `exists: false` as the `PoolState` doc says.
- Impact is low for real Reti pools, which are never deleted.
- Fix: check `appCreator` first and return the empty state when the app doesn't exist; read the address via `op.AppParams.appAddress` with its exists flag.

### 5. `getStakerPositions`: no dedupe, and a stale pool entry fails the chunk (plausible)

- Where: `projects/contracts/smart_contracts/reti_reader/contract.algo.ts:447-468`.
- The UI's `fetchStakedPoolsForAccount` dedupes because of a historical "duplicate staked pools" bug. The SDK would return duplicate positions, and per-validator sums would double-count.
- If a staker's `sps` box lists a pool whose `stakers` box no longer holds them, `StakingPool.getStakerInfo` throws "account not found", failing a chunk of up to 16 stakers.
- Checked: no duplicates at the latest round across all 5526 `sps` boxes. Past rounds are not checked.
- Fix: dedupe pool keys in the contract or the SDK. Optionally read the pool's `stakers` box directly instead of calling `getStakerInfo`.

### 6. Resolving the backend in `ready()` disables ghostkit's auto fallback (plausible) — fixed in 0.3.0-dt.4

Fixed: the repo now vendors algosdk `3.8.0-dt.2` and the ghostkit build that copies logs (ghostkit `feat/dt` 26fa8ac, packed as `ghostkit-0.1.0-dt.1.tgz`). `backend.ts`, `copyingLogs` and `ready()` are gone; `backend` goes straight to ghostkit, so it stays `'auto'`. Checked: `sdk.ghost` decodes correctly before any SDK read, at the latest round and through `atRounds`.


- Where: `projects/sdk/src/index.ts:499-511`, `projects/sdk/src/backend.ts:35-45`.
- `ready()` replaces `'auto'` with a backend object. Ghostkit's `_gkRun` falls back from DT to stock on `DTUnsupportedError` only when `this.backend === 'auto'`, so the fallback never happens.
- The public `sdk.ghost` / `sdk.baseSDK`, if used before any SDK read, skip the log-copy workaround and decode garbage.
- Fix: switch to the fixed algosdk (`3.8.0-dt.2`) and the ghostkit build that copies logs itself, then drop `copyingLogs` and leave the backend on `'auto'`.

### 7. `getChangeRounds` fails unclearly and doesn't validate options (partly confirmed)

- Where: `projects/sdk/src/history/timeline.ts:358`.
- With stock algokit-utils, `algorand.dt` is undefined, so it throws a `TypeError` rather than the `TimeTravelUnavailableError` the README implies (plausible).
- `limit` of 0 or less reaches the node as a raw 400 (confirmed).
- Fix: guard and throw a clear error; validate 1 ≤ `limit` ≤ 10,000.

## Smaller issues

- `roundAt` took up to 15 header reads (target round 56071817); the README says 7–11 and the code comment "under 10".
- Peer ranges `>=3.5.2` and `>=9.2.0` don't match the prereleases `3.8.0-dt.1` / `9.2.3-dt.1` under semver, so pnpm warns about unmet peers and npm may refuse to install (ERESOLVE).
- `projects/sdk/tsconfig.json` includes only `src`, so `npx tsc --noEmit` doesn't check the examples.
- License: the README says ISC, `package.json` says MIT (predates this branch).
- README Known Issues is wrong about assets: destroyed or missing assets read fine (`getAssets([1000])` returns `deleted: true`); only apps fail.
- Series points come back sorted and deduplicated, not in input order. (In 0.3.0-dt.2 they no longer carry ghostkit's `protocolOverride` object, and they gain `timestamp`.)
- `getBlockTimestamps({ round })` goes through the registry creation check, though block timestamps don't depend on the registry.
- `getValidators` returns a validator that doesn't exist yet with `config.id = 0` (the UI relies on this; keep it). `poolInfo` is tuples while `getPools` returns objects (predates this branch).
- UI reads not covered at a past round: an account's full asset holdings (`fetchAssetHoldings` / `accountInformation`), the gating creator's created assets (`ui/src/utils/contracts.ts:376`), xGov registry boxes (`useXGovs`).

## Checked and fine

- `getBlockTimestamps` range at a past round and at latest (R−num … R−1, as the UI's `fetchBlockTimes`); `num` up to 1000, 1001 fails.
- Creation round 46518891 reads work; R−1 throws `RetiNotDeployedError`.
- `roundAt`: 75 random targets all met `ts(r) ≤ t < ts(r+1)`.
- Timeline paging with `next`; `sps` box names; `atRound` sharing state through `Object.create`.
- Ids not created yet return zeros for pools, assets, holdings and validators (0, 999, 9999).
- Empty inputs; `getStakerPositions` on a stock node with stakers in 6 pools.
- Build, CJS `require` and ESM `import` of `dist/`; examples typecheck when passed to `tsc` explicitly.
- `verify.ts`: SDK reads match REST reads at 255 rounds over the registry's life.

## Fixed in other repos (uncommitted)

- algosdk (`js-algorand-sdk`, worktree `feat-timetravel`, branch `dtalgorand`, now `3.8.0-dt.2`): the ABI decoder ignored a `Uint8Array`'s `byteOffset` for dynamic types (`src/abi/abi_type.ts`). Regression test in `tests/10.ABI.ts`. Also in upstream algosdk.
- ghostkit (`ghostkit`, worktree `feat-dt`): the runtime copies logs before decoding; the `@ghostkit-chunk` tag is read inside backticks (puya-ts drops bare JSDoc tags) and stripped from generated docs; vendored algosdk and algokit-utils refreshed (both lacked simulate-limits).
- This worktree now vendors both (see issue 6).
