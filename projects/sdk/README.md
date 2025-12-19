# Reti Ghost SDK

Fast, read-only SDK for the Reti staking pool registry on Algorand, generated with Ghostkit and wrapped for ergonomic, high‑throughput reads.

It simulates a "ghost" contract (or optionally calls a deployed reader app) to batch and decode on-chain data efficiently with a single simulate per request. This follows the Ghostkit pattern; see the upstream rationale and constraints in the [Ghostkit README](https://github.com/d13co/ghostkit).

- Ghostkit: generates a typed SDK that reads structured data from contract log lines ([GitHub](https://github.com/d13co/ghostkit), [npm](https://www.npmjs.com/package/ghostkit))
- Wrapper: `RetiGhostSDK` adds batching and helpers specific to the Reti registry


## Install

```fish
# with pnpm
pnpm add reti-ghost-sdk

# or npm
echo "{\"type\":\"module\"}" > package.json # if you need ESM
npm i reti-ghost-sdk

# or yarn
yarn add reti-ghost-sdk
```

Peer/runtime dependencies are included by this package:
- `@algorandfoundation/algokit-utils`
- `algosdk`

Node.js 22+ is required for development (upstream puya-ts requirement).


## Quick Start

```ts
import { AlgorandClient } from "@algorandfoundation/algokit-utils"
import { RetiGhostSDK } from "reti-ghost-sdk"

const sdk = new RetiGhostSDK({
  algorand: AlgorandClient.mainNet(),
  registryAppId: 2714516089n, // Mainnet
  // Optional: use a deployed reader contract instead of ghost simulation
  // ghostAppId: 123456789013n,
})

const numValidators = await sdk.getNumValidators()
// Validator IDs are numeric and start from 1
const validatorIds = Array.from({ length: numValidators }, (_, i) => i + 1)

// Aggregated read: config, state, poolInfo[], nodeAssignment per validator
const validators = await sdk.getValidators(validatorIds)
// Order of inputs is preserved in outputs
// Example access for validator ID= : validators[0].config, validators[0].state, validators[0].poolInfo, validators[0].nodeAssignment

// Fetch all pools' algod versions
const algodVersions = await sdk.getPoolAlgodVersions(
  validators.flatMap(v => v.poolInfo.map(({poolAppId}) => poolAppId))
)
```


## What You Get

- `RetiGhostSDK`: high-level wrapper around the generated `RetiReaderSDK`
- Automatic input chunking to respect AVM reference and app-arg limits
- Clean, typed results that mirror the ARC‑56 structs of the Reti reader contract


## API Overview

All methods are read-only and return decoded, typed data. Many accept arrays and are automatically chunked for you.

- `constructor({ algorand, registryAppId, ghostAppId?, concurrency? })`
  - `algorand`: Algokit `AlgorandClient` (e.g., `AlgorandClient.mainNet()`)
  - `registryAppId`: Reti registry application id
  - `ghostAppId?`: optional app id of a deployed reader; if omitted, uses a ghost (simulated) contract
  - `concurrency?`: per-call chunk concurrency for batched reads (default `4`).

- `getValidators(validatorIds): Promise<Validator[]>`
  - Convenience call returning config, state, poolInfo, and nodeAssignment together.
  - Aggregates multiple reader calls behind the scenes; results are still per validator id in a single batched simulate.
  - Chunks 64 validators per simulate call
  - Returns `Validator[]`, an aggregated reader-only struct that is not defined in the core Reti registry contract (it’s composed for convenience by the reader/SDK).

- `getNumValidators(): Promise<number>`
  - Reads `numV` from the registry global state.

- `getValidatorConfig(validatorIds): Promise<ValidatorConfig[]>`
  - Batch fetches validator configs.

- `getValidatorStates(validatorIds): Promise<ValidatorCurState[]>`
  - Batch fetches current state (pools, totals, held back, ...).

- `getPools(validatorIds): Promise<ValidatorPoolInfo["poolInfo"][][]>`
  - For each validator id, returns an array of its `PoolInfo` entries.

- `getNodePoolAssignments(validatorIds): Promise<NodePoolAssignmentConfig[]>`
  - Node assignment structure for each validator.

- `getPoolAlgodVersions(poolAppIds): Promise<string[]>`
  - Reads the algod version string from many pool app ids. Uses app references for speed.

- `getBlockTimestamps(num): Promise<bigint[]>`
  - Small utility that fetches the last `num` block timestamps via ghost reader.

- `getAssets(assetIds): Promise<AssetInfo[]>`
  - Reads asset metadata and returns a simplified union type:
    - `{ index: bigint, deleted: true }` for deleted assets
    - `{ index: bigint, params: { creator, total, decimals, unitName, name } }` otherwise
  - Will fail for invalid asset IDs (under 1000)

Types like `ValidatorConfig`, `ValidatorCurState`, `PoolInfo`, `NodePoolAssignmentConfig`, and `Validator` are exported from the generated reader SDK and used directly here.


## Example Recipes

- Fetch all validator related data at once
```ts
// Aggregated read: config, state, poolInfo[], nodeAssignment per validator
const validators = await sdk.getValidators(validatorIds)
// Order of inputs is preserved in outputs
// Example access for validator ID= : validators[0].config, validators[0].state, validators[0].poolInfo, validators[0].nodeAssignment
```

- Fetch all validator configs at once
```ts
const numValidators = await sdk.getNumValidators()
const ids = [...Array(numValidators)].map((_, i) => i + 1)

const configs = await sdk.getValidatorConfig(ids)
```

- Read asset metadata
```ts
const assets = await sdk.getAssets([1234n, 31566704n])
// -> union: deleted or full params
```


## Ghost vs Deployed Reader

By default, calls are simulated against a ghost (non-deployed) reader contract. For some workloads, using a deployed reader app can reduce payload size and run time.

- Use deployed reader: pass `ghostAppId` in the constructor:
```ts
const sdk = new RetiGhostSDK({ algorand, registryAppId, ghostAppId: 123456789013n })
```

## Limits and Performance Notes

- AVM limits considered:
  - 128 references per simulate call (apps/assets/accounts/boxes)
  - ~2KB for app args; large inputs must be chunked
- This SDK automatically chunks large `validatorIds` / `poolAppIds` arrays:
  - Most methods: `@chunked(127)`
  - `getPoolAlgodVersions`: `@chunked(255)` with app references
- Concurrency:
  - Per-call: each method invocation processes chunks with a configurable concurrency (default `4`).
  - Not global: separate calls run their own chunk pipelines; concurrent SDK calls do not share a global limiter.
  - Order: results preserve input order across chunks.
  - Configure via constructor `new RetiGhostSDK({ concurrency: 8, ... })` or set `sdk.concurrency = 1` to throttle.
- Reader account:
  - The underlying generated SDK simulates using a funded reader account. The wrapper provides a default.

For deeper background on the approach and trade-offs, see the [Ghostkit README](https://github.com/d13co/ghostkit) and the Ghost contracts motivation.


## Types

- `ValidatorConfig`, `ValidatorCurState`, `PoolInfo`, `NodePoolAssignmentConfig`, `Validator`, `ValidatorPoolInfo` from the generated reader
- Extra type exported by this package:
  - `AssetInfo` (simplified union shape described above)


## Development

This package ships prebuilt types and JS from `dist/`. The generated reader client lives in `src/generated/` and is copied from the contracts project during build.

- Build
```fish
pnpm -w --filter reti-ghost-sdk build
```

- Examples: see `projects/sdk/src/examples/` in this repo for scripts demonstrating usage on MainNet and TestNet.


## License

ISC
