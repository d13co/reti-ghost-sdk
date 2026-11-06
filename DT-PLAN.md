# Plan: reti-ghost-sdk DT variant (time travel)

Branch `dt`, worktree `.claude/worktrees/dt`, version `reti-ghost-sdk@0.3.0-dt.1`.

## Goal

Let the Reti UI (`~/code/reti/ui`) render any page as of any round since the registry was created (round 46,518,891, Jan 2025) by reading everything through the SDK at round R. On top of that, add three history features: date → round lookup, a windowed change timeline, and chart series built on small reader methods.

The SDK keeps working against a stock algod for reads at the latest round. Past-round reads, timelines and series require a DT node.

## Measured costs

Measured on mainnet against the latest DT node (`10.114.0.27:4000`, build 5.0.3).

- **Node limits:** `max-txn-groups` 16, `max-rounds` 256, `max-extra-opcode-budget` 640k, `resource-limit-multiplier` 128.
- **Block header at any round:** ~50 ms.
- **All validator boxes at a past round, over REST:** ~130 ms.
- **Ghost `getValidators` (60 ids) at a past round:** 50–200 ms.
- **The current AVM 11 ghost works unchanged** at every round tested from 46.6M to 66M. No `protocol` override is needed.
- **Multi-round simulate of `getValidators` (60 ids):** 16 rounds 0.25 s / 1.5 MB, 64 rounds 0.5 s / 6 MB, 256 rounds 2.2 s / 24 MB, with 0 round errors.
- **Registry `/versions`:**
  - Full history: 84k box-change rounds (7.5 s) and 80k global-state versions (5 s). With values that is ~1.4 KB per version, ~110 MB in all.
  - One validator box: 10k versions. Without values 0.7 s; with values 4.7 s / 14.5 MB.
  - A 500k-round window (~2 weeks): 2.2k versions in 190 ms.

These costs set the design rules:

- Timelines fetch rounds only, never values, and never the full history.
- Series use small reader methods, never the full `Validator` struct.
- A series is capped at 256 points per request.

## 1. Stack

All three forks are unpublished, so they ship as vendored tarballs. This follows the ghostkit `feat/dt` pattern.

- **`vendor/` at the repo root** holds:
  - `algosdk-3.8.0-dt.1.tgz` and `algorandfoundation-algokit-utils-9.2.3-dt.1.tgz`, copied from `~/code/ghostkit/.claude/worktrees/feat-dt/vendor/`.
  - `ghostkit-0.1.0-dt.1.tgz`, built with `npm pack` in the ghostkit `feat-dt` worktree.
- **`pnpm-workspace.yaml`:** `overrides` for `algosdk` and `@algorandfoundation/algokit-utils` pointing at the tarballs, so exactly one copy of each loads.
- **`projects/contracts/package.json`:** `ghostkit` → `file:../../vendor/ghostkit-0.1.0-dt.1.tgz`. Bump `algokit-utils` and `algosdk` to the vendored versions.
- **`projects/sdk/package.json`:**
  - Version `0.3.0-dt.1`.
  - Keep the peer ranges loose (`algosdk >=3.5.2`, `algokit-utils >=9.2.0`). Prereleases don't satisfy `^`, and the forks are detected at runtime anyway.
  - The generated SDK inlines the ghostkit runtime, so ghostkit is not a runtime dependency.
- **Delete the leftover `projects/sdk/src/generated/sdk.ts`**; nothing imports it.

## 2. Reader contract (`projects/contracts/smart_contracts/`)

### Registry stub (`reti/contract.algo.ts`, `reti/types.algo.ts`)

- Add `getStakedPoolsForAccount(staker: Address): ValidatorPoolKey[]`.
- Add a `StakingPool` stub (`reti/stakingPool.algo.ts`) with `getStakerInfo(staker: Address): StakedInfo`.
- Copy the `ValidatorPoolKey` and `StakedInfo` types from `~/code/reti/contracts/contracts/`.

### Chunk tags

Add `/** @ghostkit-chunk <arg> refsPerItem=N */` to every array method so the regenerated SDK chunks to the node's limits:

- `validatorIds`: for `getValidatorConfig`, `getValidatorStates`, `getPools`, `getNodePoolAssignments` and `getValidators`. Measure `refsPerItem`; the old 127/64 chunk sizes suggest 1 and 2.
- `poolAppIds`, `assetIds`.

### New reader methods (all `readonly`, `onCreate: "allow"`, one log per item)

| Method | Returns per item | Source | Replaces UI read |
|---|---|---|---|
| `getPoolStates(pools: Application[])` | `PoolState { validatorId, poolId, numStakers, staked, minEntryStake, lastPayout, epochNumber, algodVer, roundsPerDay, binRoundStart, rewardAccumulator, ewma }` | `app_global_get_ex` on the pool | `fetchPoolGlobalStates`, `fetchPoolGlobalState`, `fetchPoolApy` |
| `getStakerPositions(registryAppId, stakers: Address[])` | `{ staker, validatorId, poolId, poolAppId, info: StakedInfo }` per position | inner `getStakedPoolsForAccount`, then `getStakerInfo` per pool | `fetchStakedPoolsForAccount`, `fetchStakerPoolData`, `fetchStakerValidatorData` |
| `getAccountBalances(accounts: Account[])` | `{ balance, minBalance }` | `acct_params_get` | `fetchAccountBalance`, `fetchBalance` |
| `getAssetHoldings(account: Account, assets: Asset[])` | `{ assetId, balance, optedIn }` | `asset_holding_get` | `fetchRemainingRewardsBalance`, `fetchAccountAssetInformation`, `isOptedInToAsset` |
| `getValidatorTotals(registryAppId, validatorIds)` | `{ totalAlgoStaked, totalStakers, numPools }` (slim, for series) | inner `getValidatorState` | — |
| `getPoolTotals(pools: Application[])` | `{ staked, numStakers }` (slim, for series) | `app_global_get_ex` | — |

- Two reads stay on REST at R because the ghost can't read another app's boxes and the pool has no getter for them:
  - the pool `stakers` box (`fetchStakedInfoForPool`);
  - the bulk `v*` validator boxes (an optional fast path).
- **`getBlockTimestamps`:** keep the method. Under ghostkit `atRound(R)` (valid from R+1) it returns blocks R−num … R−1. Drop the wrapper's explicit fv/lv.
- **Rebuild:** `pnpm --filter smart_contracts build` regenerates `RetiReader.arc56.json` and `RetiReaderSDK.ts` with the `GhostkitBase` API: `atRound`, `atRounds`, `batch`, `getNode`, `chunk`, `ghostFee`.

## 3. SDK wrapper (`projects/sdk/src/`)

Reuse from branch `worktree-simulate-round` (commit 481a361):

- the `ReadOptions { round }` trailing argument and the constructor `round` / `readerAccount` options;
- its README section and `examples/at-round.ts`.

Drop its `TimeTravelAlgodClient` code; that client is now `DTAlgodClient`, and ghostkit takes care of the rest. Don't merge that branch.

### `index.ts`: `RetiGhostSDK`

**Constructor:** `{ algorand, registryAppId, round?, ghostAppId?, readerAccount?, backend?, debug? }`.

- `readerAccount` defaults to ghostkit's per-network fee sink.
- `backend` defaults to `'auto'`, falling back to stock.

**Pinning:**

- `atRound(round | undefined): RetiGhostSDK` returns a pinned clone, mirroring `AppClient.atRound`.
- Every method also takes `{ round }`.
- Pinned reads always use the simulated ghost and ignore `ghostAppId`. The deployed reader (3374692547) doesn't exist at early rounds and is updatable.

**Node and range:**

- `getNode()` → `{ kind: 'dt' | 'stock', limits }`, passed through from ghostkit.
- `getRegistryCreationRound()` comes from the first `/v2/applications/{id}/versions` entry and is cached.
- Reads before that round throw `RetiNotDeployedError`. A round after the latest is passed through as the node's 400.

**Existing methods, now on the regenerated SDK:**

- `getMbrAmountsAndProtocolConstraints`, `getValidatorConfig`, `getValidatorStates`, `getPools`, `getNodePoolAssignments`, `getValidators`, `getPoolAlgodVersions`, `getAssets`, `getPoolBalancesAndLastPayouts`, `getBlockTimestamps`.
- Drop the manual `extraFee`s; `ghostFee` covers them.
- Drop `@chunked`, `p-map` and `concurrency`; ghostkit packs ≤16 groups per simulate and runs the stock backend with concurrency 8.
- Drop the per-txn `accessReferences` from `getPoolAlgodVersions` and use the chunk tag plus unnamed resources.
- Keep the return shapes so existing callers don't break.

**Registry reads:**

- `getNumValidators({ round })` → `algorand.app.getGlobalState(registryAppId, { round })` from the utils fork.
- `getRegistryTotals({ round })` → `{ numValidators, numStakers, staked }` from the same read.

**New reads:** `getPoolStates`, `getStakerPositions`, `getAccountBalances`, `getAssetHoldings`, `getPoolStakers(poolAppId, { round })`.

- `getPoolStakers` uses `algorand.app.getBoxValue(poolAppId, 'stakers', { round })` and decodes `StakedInfo[200]`, skipping empty slots.
- Optional fast path: `getAllValidatorsFromBoxes({ round })` reads `v*` boxes at R over REST and decodes them like the UI's `fetchAllValidatorData` does. Keep it only if it beats the ghost path.

### `history/dateToRound.ts`: date → round

- `roundAt(date: Date | number): Promise<{ round, timestamp }>` returns the last round whose timestamp is ≤ the given time.
- Interpolation search over `GET /v2/blocks/{R}?header-only=true` (stock algosdk `block(r).headerOnly(true)`). Start from the latest header and average block time, then interpolate within the [lo, hi] bracket, with a bisection fallback.
- Target: ≤6 header reads.
- Clamp to the registry creation round and the latest round. Cache headers per session.
- `timestampOf(round)` is a helper for UI labels.

### `history/timeline.ts`: windowed change timeline

- `getChangeRounds(target, { minRound, maxRound, limit = 1000, order = 'desc', next? }): Promise<{ changes: { round, timestamp, deleted }[], next? }>`
- Never requests values. Values are read at a chosen round with the normal `{ round }` reads.
- Targets map onto the utils-fork `algorand.dt` calls:

| `target` | Call |
|---|---|
| `{ validator: id }` | `getBoxVersions(registry, 'v' + uint64(id))` |
| `{ registry: true }` | `getAppVersions(registry)` |
| `{ pool: appId }` | `getAppVersions(pool)` |
| `{ poolStakers: appId }` | `getBoxVersions(pool, 'stakers')` |
| `{ staker: addr }` | `getBoxVersions(registry, staker-pool-set box)` (check the exact box name in the registry source) |

- **Guardrail:** `minRound` is required unless `order: 'desc'` with `limit ≤ 1000`, so an unbounded full-history scan isn't the default.

### `history/series.ts`: chart series

- `getSeries(kind, ids, rounds | { from, to, points }): Promise<{ round, values }[]>`, built on ghostkit `atRounds`. It uses `rounds` with `validityWindow: 'rewrite'`, ≤256 rounds per request and ≤16 groups.
- `kind` is `'validatorTotals'` (`getValidatorTotals`), `'poolTotals'` (`getPoolTotals`) or `'registryTotals'`.
- `'registryTotals'` runs parallel `{ round }` global-state reads (~50 ms each) and doesn't simulate.
- Spread `{ from, to, points }` evenly, with `points` ≤ 256 by default.
- Per-round failures come back as `{ round, error }` entries. They don't fail the whole series.
- Target: all ~213 validators × 256 points in a few MB. Measure it and record the result in the README.

## 4. Docs and examples

- **README:**
  - `-dt` install section (tarballs plus overrides) and the node requirements.
  - "Reading at a past round" (from simulate-round, updated).
  - Date lookup, timeline and series, with the measured costs.
  - What doesn't work on a stock node.
- **Examples:** `at-round.ts` (updated), `staker-at-round.ts`, `date-to-round.ts`, `timeline.ts`, `series.ts`. Read the node URL from `DT_ALGOD_SERVER`, defaulting to `http://10.114.0.27:4000`.

## 5. Verification

- **Build:** `pnpm --filter smart_contracts build`, then `pnpm --filter reti-ghost-sdk build`, then `tsc --noEmit` for the examples.
- **Cross-check against an independent source:** at ~64 rounds spread from 46.6M to the latest, compare SDK output with raw REST reads at the same round:
  - validator config/state vs. the decoded `v` box;
  - pool states vs. `/v2/applications/{pool}?round=R` global state;
  - account balances vs. `/v2/accounts/{a}?round=R`.
- **Program changes:** sweep `getValidators` for all validators across the rounds where the registry or pool programs changed, found by scanning `getAppVersions` within windows. The goal is zero decode errors.
- **Date lookup:** `roundAt(timestampOf(r)) === r` for random `r`, at ≤6 header reads.
- **Timeline:** the round where `getChangeRounds({ validator })` reports a change agrees with a state diff between R−1 and R.
- **Series:** the values at each point equal the single-round reads, and the response size and time are recorded.
- **Stock fallback:** with `backend: 'auto'` against a non-DT algod (e.g. `mainnet-api.4160.nodely.dev`), latest-state reads work and pinned reads throw clear errors.

## Out of scope

- UI changes in `~/code/reti/ui`. That's a separate plan.
- Nodely APY and NFD, which only answer "now".
- Publishing to npm while the forks are unpublished.

## Implementation notes (2026-10-21)

Done on branch `dt`, not committed. What differs from the plan, and why:

- **Vendored stack:** algosdk comes from `~/code/algokit-utils-ts/vendor/`, not ghostkit's `vendor/`. ghostkit's copy predates the fork's simulate-limits commit (11 of 12 DT features). algokit-utils is packed fresh from its built `dist` (commit 52117313).
- **Chunk tags:** puya-ts drops unknown JSDoc tags, so a `@ghostkit-chunk` line never reaches ARC-56 and ghostkit's chunk tags don't work as documented. Wrapping the tag in backticks (`` `@ghostkit-chunk …` ``) keeps it in the description. Tags also cap `maxPerGroup` at the AVM's 256 inner transactions per group (64 for `getValidators`, which makes 4 inner calls per validator).
- **Log decode bug:** ghostkit's new runtime passes logs straight to `getABIDecodedValue`. The old template copied them (`new Uint8Array(log)`). algosdk's ABI decoder ignores `byteOffset` for dynamic types (`abi_type.ts` lines 535 and 678, also upstream), and the DT simulate returns logs as views into one buffer, so every struct with a dynamic field failed. Worked around in `projects/sdk/src/backend.ts` by copying logs. The real fixes belong in algosdk and the ghostkit runtime.
- **Missing objects at a round:** `app_global_get_ex` / `asset_params_get` on an id that doesn't exist fails the simulate ("app X does not exist"). The reader treats ids at or above the ghost's own app id as not created yet (apps and assets share one counter), and validator ids above `numV` as missing, and returns zeros. Without this, every series point before the newest validator or pool existed failed.
- **Fees:** default `ghostFee` is 10 Algo per group rather than ghostkit's 1 Algo, since 64 `getValidators` items make 256 inner calls.
- **Stock nodes:** pinned reads more than 1 round back fail fast with `TimeTravelUnavailableError`. A stock node can't simulate 2+ rounds back with ghostkit's validity window ("txTail: tried to check for dup in missing round").
- **Date lookup:** 7–11 header reads (0.25–0.4 s) rather than ≤6: about 4–5 sequential secant steps, then one parallel read of 7 rounds.
- **Series size:** 227 validators × 256 rounds is 12 MB (2.6 s), not "a few MB". The simulate's record of the inner calls dominates. 64 rounds is 3 MB; the README recommends 64–128 points in a browser.
- **Not done:** `getAllValidatorsFromBoxes` (optional fast path). The ghost path is already ~270 ms for all validators.
- **Verification:** `examples/verify.ts` passes at 255 rounds from creation to now (validator config, state and pools byte for byte against the `v` boxes; pool global state and balances; staker positions and balances). The registry's program never changed, so there are no upgrade rounds to sweep.
