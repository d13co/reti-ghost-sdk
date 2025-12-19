# Reti Ghost SDK

Fast, read-only SDK for the Reti staking pool registry on Algorand, generated with Ghostkit and wrapped for ergonomic, high‑throughput reads.

It simulates a "ghost" contract (or optionally calls a deployed reader app) to batch and decode on-chain data efficiently with a single simulate per request. This follows the Ghostkit pattern; see the upstream rationale and constraints in the Ghostkit README.

- Ghostkit: generates a typed SDK that reads structured data from contract log lines
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

// Mainnet registry app id
const registryAppId = 2714516089n

const sdk = new RetiGhostSDK({
  algorand: AlgorandClient.mainNet(),
  registryAppId,
  // Optional: use a deployed reader contract instead of ghost simulation
  // ghostAppId: 123456789013n,
})

const numValidators = await sdk.getNumValidators()
const validatorIds = Array.from({ length: numValidators }, (_, i) => BigInt(i + 1))

// Batched reads with automatic chunking
const [configs, states, pools, nodeAssignments] = await Promise.all([
  sdk.getValidatorConfig(validatorIds),
  sdk.getValidatorStates(validatorIds),
  sdk.getPools(validatorIds),
  sdk.getNodePoolAssignments(validatorIds),
])

// Derived helpers
const algodVersions = await sdk.getPoolAlgodVersions(
  pools.flatMap(list => list.map(p => p.poolAppId))
)
```


## What You Get

- `RetiGhostSDK`: high-level wrapper around the generated `RetiReaderSDK`
- Automatic input chunking to respect AVM reference and app-arg limits
- Clean, typed results that mirror the ARC‑56 structs of the Reti reader contract


## API Overview

All methods are read-only and return decoded, typed data. Many accept arrays and are automatically chunked for you.

- `constructor({ algorand, registryAppId, ghostAppId? })`
  - `algorand`: Algokit `AlgorandClient` (e.g., `AlgorandClient.mainNet()`)
  - `registryAppId`: Reti registry application id
  - `ghostAppId?`: optional app id of a deployed reader; if omitted, uses a ghost (simulated) contract

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

- `getValidators(validatorIds): Promise<Validator[]>`
  - Convenience call returning config, state, poolInfo, and nodeAssignment together.

- `getPoolAlgodVersions(poolAppIds): Promise<string[]>`
  - Reads the algod version string from many pool app ids. Uses app references for speed.

- `getBlockTimestamps(num): Promise<bigint[]>`
  - Small utility that demonstrates block access via ghost reader.

- `getAssets(assetIds): Promise<AssetInfo[]>`
  - Reads asset metadata and returns a simplified union type:
    - `{ index: bigint, deleted: true }` for deleted assets
    - `{ index: bigint, params: { creator, total, decimals, unitName, name } }` otherwise

Types like `ValidatorConfig`, `ValidatorCurState`, `PoolInfo`, `NodePoolAssignmentConfig`, and `Validator` are exported from the generated reader SDK and used directly here.


## Example Recipes

- Fetch everything at once
```ts
const numValidators = await sdk.getNumValidators()
const ids = [...Array(numValidators)].map((_, i) => i + 1)

const [assignments, configs, states, pools] = await Promise.all([
  sdk.getNodePoolAssignments(ids),
  sdk.getValidatorConfig(ids),
  sdk.getValidatorStates(ids),
  sdk.getPools(ids),
])
```

- Paginate large calls yourself (wrapper already chunks, but you can control concurrency by slicing)
```ts
import pMap from "p-map"
import { chunk } from "reti-ghost-sdk/dist/utils/chunk.js" // or copy your own tiny chunk helper

const ids = [...Array(numValidators)].map((_, i) => i + 1)
const chunks = chunk(ids, 64)
await pMap(chunks, async (part, i) => {
  const data = await sdk.getValidators(part)
  // ...work with data
}, { concurrency: 2 })
```

- Read asset metadata
```ts
const assets = await sdk.getAssets([1n, 31566704n])
// -> union: deleted or full params
```


## Ghost vs Deployed Reader

By default, calls are simulated against a ghost (non-deployed) reader contract. For some workloads, using a deployed reader app can reduce payload size and run time.

- Use deployed reader: pass `ghostAppId` in the constructor:
```ts
const sdk = new RetiGhostSDK({ algorand, registryAppId, ghostAppId: 752173746n })
```
- Advanced: you can deploy from the included reader factory via Algokit if needed:
```ts
import algosdk from "algosdk"
const deployer = algosdk.mnemonicToSecretKey("<mnemonic>")
const factory = sdk.algorand.client.getTypedAppFactory(RetiGhostSDK.ghost.factory, {
  defaultSender: deployer.addr,
  defaultSigner: algosdk.makeBasicAccountTransactionSigner(deployer),
})
// const { appClient } = await factory.send.create.getBlockTimestamps({ args: { num: 0n } })
// console.log(appClient.appId)
```


## Limits and Performance Notes

- AVM limits to consider:
  - 128 references per simulate call (apps/assets/accounts/boxes)
  - ~2KB for app args; large inputs must be chunked
- This SDK automatically chunks large `validatorIds` / `poolAppIds` arrays:
  - Most methods: `@chunked(127)`
  - `getPoolAlgodVersions`: `@chunked(255)` with app references
- Reader account:
  - The underlying generated SDK simulates using a funded reader account. The wrapper provides a default.

For deeper background on the approach and trade-offs, see the Ghostkit README and the Ghost contracts motivation.


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
