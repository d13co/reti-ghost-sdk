import { AlgorandClient } from "@algorandfoundation/algokit-utils"
import { ALGORAND_ZERO_ADDRESS_STRING } from "algosdk"
import { describe, expect, it, vi } from "vitest"
import { RetiGhostSDK } from "../src/index.js"

const CREATOR = "7ZUECA7HFLZTXENRV24SHLU4AVPUTMTTDUFUBNBD64C73F3UHRTHAIOF6Q"

/** An SDK whose latest-state reads go to a fake reader; asset 0 doesn't exist, the rest are `A<id>`. */
function fakeSdk() {
  const getAssets = vi.fn(async ({ methodArgsOrArgsArray }: { methodArgsOrArgsArray: { assetIds: bigint[] } }) =>
    methodArgsOrArgsArray.assetIds.map((assetId) =>
      assetId === 0n
        ? { assetId: 0n, creator: ALGORAND_ZERO_ADDRESS_STRING, total: 0n, decimals: 0, unitName: "", name: "" }
        : { assetId, creator: CREATOR, total: 1000n, decimals: 6, unitName: `A${assetId}`, name: `Asset ${assetId}` },
    ),
  )
  const sdk = new RetiGhostSDK({ algorand: AlgorandClient.defaultLocalNet(), registryAppId: 1n })
  ;(sdk as unknown as { baseSDK: unknown }).baseSDK = { getAssets }
  const idsRead = () => getAssets.mock.calls.map((call) => call[0].methodArgsOrArgsArray.assetIds)
  return { sdk, getAssets, idsRead }
}

describe("getAssets", () => {
  it("reads separate calls made together in one request, each asset once", async () => {
    const { sdk, idsRead } = fakeSdk()
    const [one, two, three] = await Promise.all([sdk.getAssets([10]), sdk.getAssets([20n]), sdk.getAssets([10, 30])])
    expect(idsRead()).toEqual([[10n, 20n, 30n]])
    expect(one).toEqual([
      {
        index: 10n,
        params: { creator: CREATOR, total: 1000n, decimals: 6, unitName: "A10", name: "Asset 10" },
      },
    ])
    expect(two.map((a) => "params" in a && a.params.unitName)).toEqual(["A20"])
    expect(three.map((a) => a.index)).toEqual([10n, 30n])
  })

  it("marks an asset that doesn't exist as deleted, under the id asked for", async () => {
    const { sdk } = fakeSdk()
    expect(await sdk.getAssets([0])).toEqual([{ index: 0n, deleted: true }])
  })

  it("makes no request for no assets", async () => {
    const { sdk, getAssets } = fakeSdk()
    expect(await sdk.getAssets([])).toEqual([])
    expect(getAssets).not.toHaveBeenCalled()
  })

  it("rejects an aborted call without failing the others in its batch", async () => {
    const { sdk } = fakeSdk()
    const controller = new AbortController()
    const aborted = sdk.getAssets([10], { signal: controller.signal })
    const kept = sdk.getAssets([20])
    controller.abort(new Error("stop"))
    await expect(aborted).rejects.toThrow("stop")
    expect((await kept).map((a) => a.index)).toEqual([20n])
  })
})
