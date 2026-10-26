# reti-ghost-sdk — dtalgorand branch

Fast Reti SDK that utilizes [ghost contracts](https://github.com/d13co/ghostkit) to batch fetch data.

**Status: Experimental.** This is the `dtalgorand` branch: a prerelease line of the SDK (`0.3.0-dt.*`, npm dist-tag `dt`) that can read the Reti registry as of any round since it was created, on a dtalgorand node. The stable SDK (`0.2.x`, dist-tag `latest`) lives on `main`.

**For SDK usage, see [`projects/sdk/README.md`](projects/sdk/README.md).**

## About this fork

Algorand's algod only serves the latest state, so a stock node can't answer "what did the registry look like at round R?". [dtalgorand](https://github.com/d13co/dt-algorand) is a fork of go-algorand that can: it simulates transactions as of a past round, and indexes when each box, account, app and asset changed. This branch builds the Reti SDK on top of it, so an app (the Reti UI's time travel) can render any page as of a past round, plus date → round lookups, change timelines and chart series.

Doing that needs a fork at every layer under the SDK. None of them is published yet, so this branch carries them as tarballs in [`vendor/`](vendor/):

| Layer | Fork | Version | Source | What it adds |
|---|---|---|---|---|
| Node | dtalgorand (go-algorand) | based on `v5.0.4-stable` | [d13co/dt-algorand](https://github.com/d13co/dt-algorand), branch `dtalgorand` (queries not merged yet) | Simulate at a past round; several groups, parallel groups and several rounds per simulate request; validity window modes; running a past round under a later protocol; `GET /v2/transactions/simulate/limits`; `/versions` change feeds for boxes, accounts, apps and assets; read-only TEAL queries (`POST /v2/query`) |
| algosdk | `dtalgosdk` | `3.9.0-dt.2.0.1.0` | fork of [algorand/js-algorand-sdk](https://github.com/algorand/js-algorand-sdk), branch `dtalgorand` (query support on `dt-query` until merged) | `DTAlgodClient`: past-round reads, box and app versions, the extended simulate, the node's simulate and query limits, `DTAlgodClient.query`; a fix for decoding ABI values from byte views |
| algokit-utils | `@d13co/dt-algokit-utils` | `9.2.3-dt.2.0.1.0` | fork of [algorandfoundation/algokit-utils-ts](https://github.com/algorandfoundation/algokit-utils-ts), branch `dtalgorand` (query support on `dt-query` until merged) | `algorand.dt`: detects a dtalgorand node and runs the composer's simulate through the extended simulate at a round, following the node's limits; `algorand.query`: runs composers' app calls as queries with a simulate fallback, chunked by the node's limits; request cancellation with an `AbortSignal` |
| ghostkit | `ghostkit` | `0.1.0-dt.2` | [d13co/ghostkit](https://github.com/d13co/ghostkit), branch `feat/dt` (query support on `dt-query` until merged) | A dtalgorand simulate backend, a query backend (the `auto` default when the node has queries), `prefetch()`, AVM 13, 4 KB app args, chunk tags that survive puya-ts, log decoding that copes with byte views. Build time only: the generated SDK inlines its runtime |

On top of those, this branch changes the SDK itself:

- **Reader contract** (`projects/contracts/`): new read-only reader methods (registry, validator and pool totals, pool states, staker positions, account balances, asset holdings, round timestamps and a round scan for date lookups), each item one log so reads chunk to the node's limits. Ids not created yet at a round read as zeros instead of failing the simulate.
- **SDK** (`projects/sdk/`): reads go through read-only queries when the node has them, else simulate; every read takes `{ round }` (or `sdk.atRound(round)`) and an `AbortSignal`; `roundAt` / `timestampOf`; `getChangeRounds` timelines; series reads over many rounds; a staker's deposit and withdrawal history across every pool they were ever in; clear errors for rounds before the registry, past the node's tip, or too old for a stock node.

It still works against any algod for the latest state. With stock algosdk and algokit-utils, or on a stock node, reads at older rounds throw `TimeTravelUnavailableError`.

Workspace-wide `overrides` in [`pnpm-workspace.yaml`](pnpm-workspace.yaml) make every package here use the vendored algosdk and algokit-utils, so only one copy of each loads. A consumer needs the same; see the SDK README's Install section.

## Development Installation

For SDK development, run at project root:

```
algokit bootstrap all
```

Node.js 22+ is required (upstream puya-ts requirement, and the algokit-utils fork).

## Development Build

Run at project root:

```
algokit project run build
```

## Releasing a prerelease

1. Bump `version` in `projects/sdk/package.json` to the next `0.3.0-dt.N`.
2. If a fork changed, pack it, put the tarball in `vendor/`, and update `pnpm-workspace.yaml`, the `devDependencies` in `projects/contracts` and `projects/sdk`, the Install section of `projects/sdk/README.md`, and the table above.
3. `algokit project run build`, and commit.
4. Tag the commit `v0.3.0-dt.N` and push the branch and the tag. The SDK README's install snippet downloads the fork tarballs from that tag.
5. From `projects/sdk`: `pnpm publish --tag dt`, so `latest` stays on the stable line. `prepublishOnly` refuses to publish a prerelease as `latest`, then rebuilds `dist/`.

## Usage

See [`projects/sdk/README.md`](projects/sdk/README.md).
