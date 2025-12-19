import { AlgorandClient } from "@algorandfoundation/algokit-utils"
import {
  Validator,
  NodePoolAssignmentConfig,
  RetiReaderSDK,
  ValidatorConfig,
  ValidatorCurState,
  ValidatorPoolInfo,
  AssetInfo as AssetInfoBase,
} from "./generated/RetiReaderSDK.js"
import { chunked } from "./utils/chunked.js"
import { chunk } from "./utils/chunk.js"
import { ALGORAND_ZERO_ADDRESS_STRING } from "algosdk"

export { Validator } from "./generated/RetiReaderSDK.js"

export type AssetInfo =
  | {
      index: bigint
      deleted: true
    }
  | {
      index: bigint
      params: {
        creator: string
        total: bigint
        decimals: number
        unitName: string
        name: string
      }
    }

export class RetiGhostSDK {
  static ghost = RetiReaderSDK

  public algorand: AlgorandClient
  public registryAppId: bigint
  public ghostSDK: RetiReaderSDK

  constructor({
    algorand,
    registryAppId,
    ghostAppId,
  }: {
    algorand: AlgorandClient
    registryAppId: number | bigint
    ghostAppId?: bigint
  }) {
    this.algorand = algorand
    this.registryAppId = BigInt(registryAppId)
    this.ghostSDK = new RetiReaderSDK({
      algorand: this.algorand,
      readerAccount: "Y76M3MSY6DKBRHBL7C3NNDXGS5IIMQVQVUAB6MP4XEMMGVF2QWNPL226CA",
      ghostAppId,
    })
  }

  async getNumValidators(): Promise<number> {
    const { numV } = await this.algorand.app.getGlobalState(this.registryAppId)
    return Number(numV.value)
  }

  @chunked(127)
  async getValidatorConfig(validatorIds: number[] | bigint[]): Promise<ValidatorConfig[]> {
    console.log("Fetching validator configs for IDs:", validatorIds)
    const extraFee = (1000 * validatorIds.length).microAlgo()
    return this.ghostSDK.getValidatorConfig({
      methodArgsOrArgsArray: { registryAppId: this.registryAppId, validatorIds },
      extraMethodCallArgs: { extraFee },
    })
  }

  @chunked(127)
  async getValidatorStates(validatorIds: number[] | bigint[]): Promise<ValidatorCurState[]> {
    console.log("Fetching validator states for IDs:", validatorIds)
    const extraFee = (1000 * validatorIds.length).microAlgo()
    return this.ghostSDK.getValidatorStates({
      methodArgsOrArgsArray: { registryAppId: this.registryAppId, validatorIds },
      extraMethodCallArgs: { extraFee },
    })
  }

  async getPools(validatorIds: number[] | bigint[]): Promise<ValidatorPoolInfo["poolInfo"][][]> {
    const results = await this._internal_getPoolInfo(validatorIds)
    return validatorIds.map((vid) => results.filter((r) => r.validatorId === BigInt(vid)).map((r) => r.poolInfo))
  }

  @chunked(127)
  private async _internal_getPoolInfo(validatorIds: number[] | bigint[]): Promise<ValidatorPoolInfo[]> {
    const extraFee = (1000 * validatorIds.length).microAlgo()
    return this.ghostSDK.getPools({
      methodArgsOrArgsArray: { registryAppId: this.registryAppId, validatorIds },
      extraMethodCallArgs: { extraFee },
    })
  }

  // @chunked(255)
  // private async _internal_getPoolInfo(validatorIds: number[] | bigint[]): Promise<ValidatorPoolInfo[]> {
  //   const extraFee = (16000).microAlgo()
  //   const args = chunk(
  //     validatorIds.map((p) => Number(p)),
  //     16,
  //   )
  //   // TODO add app ref
  //   const extraMethodCallArgs = args.map((chunk) => ({
  //     extraFee,
  //     accessReferences: chunk.map((id) => ({
  //       box: { appId: this.registryAppId, name: Buffer.concat([Buffer.from("v"), encodeUint64(BigInt(id))]) },
  //     })),
  //   }))
  //   console.log(extraMethodCallArgs)
  //   return this.ghostSDK.getPools({
  //     methodArgsOrArgsArray: { registryAppId: this.registryAppId, validatorIds },
  //     extraMethodCallArgs,
  //   })
  // }

  @chunked(127)
  async getNodePoolAssignments(validatorIds: number[] | bigint[]): Promise<NodePoolAssignmentConfig[]> {
    const extraFee = (1000 * validatorIds.length).microAlgo()
    return this.ghostSDK.getNodePoolAssignments({
      methodArgsOrArgsArray: { registryAppId: this.registryAppId, validatorIds },
      extraMethodCallArgs: { extraFee },
    })
  }

  async getValidators(validatorIds: number[]): Promise<Validator[]> {
    const extraFee = (validatorIds.length * 4000).microAlgo()
    const data = await this.ghostSDK.getValidators({
      methodArgsOrArgsArray: { registryAppId: this.registryAppId, validatorIds },
      extraMethodCallArgs: { extraFee },
    })
    return data
  }

  @chunked(255)
  async getPoolAlgodVersions(poolAppIds: number[] | bigint[]): Promise<string[]> {
    const args = chunk(
      poolAppIds.map((p) => Number(p)),
      16,
    )
    const extraMethodCallArgs = args.map((chunk) => ({ accessReferences: chunk.map((id) => ({ appId: BigInt(id) })) }))
    return this.ghostSDK.getAlgodVersion({
      methodArgsOrArgsArray: args.map((chunk) => ({ poolAppIds: chunk })),
      extraMethodCallArgs,
    })
  }

  async getBlockTimestamps(num: number): Promise<bigint[]> {
    // viable alternative would be to do validity = 1
    // but we will fetch lastRound to override params cache
    const { lastRound } = await this.algorand.client.algod.status().do()
    return this.ghostSDK.getBlockTimestamps({
      methodArgsOrArgsArray: { num },
      extraMethodCallArgs: { firstValidRound: lastRound, lastValidRound: lastRound + 3n },
    })
  }

  @chunked(128)
  async getAssets(assetIds: number[] | bigint[]): Promise<AssetInfo[]> {
    const assets: AssetInfo[] = []
    const data = await this.ghostSDK.getAssets({
      methodArgsOrArgsArray: { assetIds },
    })
    for (const asset of data) {
      if (asset.creator === ALGORAND_ZERO_ADDRESS_STRING) {
        assets.push({ index: asset.assetId, deleted: true })
      } else {
        assets.push({
          index: asset.assetId,
          params: {
            creator: asset.creator,
            total: asset.total,
            decimals: asset.decimals,
            unitName: asset.unitName,
            name: asset.name,
          },
        })
      }
    }
    return assets
  }
}
