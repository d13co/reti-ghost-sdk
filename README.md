# reti-ghost-sdk

Fast Reti SDK that utilizes [ghost cotracts](https://github.com/d13co/ghostkit) to batch fetch data.

**Status: Experimental**

Methods supported:

- getNumValidators
- getValidatorConfig
- getValidatorStates
- getPools
- getNodePoolAssignments

This mirrors the required data for reti UI's `useValidators` data fetcher. When run in parallel (see example) it fetches all data in less than 1 second.

## Installation

Run at project root:

```
algokit bootstrap all
```

## Build

Run at project root:

```
algokit project run build
```

## Usage

See `projects/sdk/src/run.ts`

## Example Run

```
cd projects/sdk
tsx src/run.ts
```

### Sample Output

```
Retrieved node pool assignments: 196
Sample {
  nodes: [
    [ [Array] ],
    [ [Array] ],
    [ [Array] ],
    [ [Array] ],
    [ [Array] ],
    [ [Array] ],
    [ [Array] ],
    [ [Array] ]
  ]
}
  --
Retrieved validator states: 196
Sample {
  numPools: 2,
  totalStakers: 195n,
  totalAlgoStaked: 4752507090411n,
  rewardTokenHeldBack: 0n
}
  --
Retrieved validator configs: 196
Sample {
  id: 1n,
  owner: 'RSV2YCHXA7MWGFTX3WYI7TVGAS5W5XH5M7ZQVXPPRQ7DNTNW36OW2TRR6I',
  manager: 'EP2N3CDADK7RPFWR6EE72URF5OJMSPBNKGFDPNJGGYRSDLEK6ZWSMEG5HE',
  nfdForInfo: 2714599972n,
  entryGatingType: 0,
  entryGatingAddress: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAY5HFKQ',
  entryGatingAssets: [ 0n, 0n, 0n, 0n ],
  gatingAssetMinBalance: 0n,
  rewardTokenId: 0n,
  rewardPerPayout: 0n,
  epochRoundLength: 2592,
  percentToValidator: 50000,
  validatorCommissionAddress: 'RSV2YCHXA7MWGFTX3WYI7TVGAS5W5XH5M7ZQVXPPRQ7DNTNW36OW2TRR6I',
  minEntryStake: 1000000000n,
  maxAlgoPerPool: 0n,
  poolsPerNode: 3,
  sunsettingOn: 0n,
  sunsettingTo: 0n
}
  --
Retrieved pools: 196
Samples 1 63 95 96 [
  {
    poolAppId: 2714622967n,
    totalStakers: 195,
    totalAlgoStaked: 4752507090411n
  },
  { poolAppId: 2726614654n, totalStakers: 0, totalAlgoStaked: 0n }
] [] [
  {
    poolAppId: 2909634834n,
    totalStakers: 127,
    totalAlgoStaked: 2343330999007n
  },
  { poolAppId: 2971894622n, totalStakers: 0, totalAlgoStaked: 0n },
  { poolAppId: 2971899422n, totalStakers: 0, totalAlgoStaked: 0n }
] [ { poolAppId: 2910050280n, totalStakers: 0, totalAlgoStaked: 0n } ]
  --
run: 890.081ms
```
