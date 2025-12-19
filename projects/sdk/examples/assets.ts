import { AlgorandClient } from "@algorandfoundation/algokit-utils"
import { RetiGhostSDK } from "../src"

const registryAppId = 2714516089

const sdk = new RetiGhostSDK({
  algorand: AlgorandClient.mainNet(),
  registryAppId,
})

;(async () => {
  console.time("run")
  const assetIds = process.argv.slice(2).map((id) => BigInt(id))
  const data = await sdk.getAssets(assetIds)
  console.timeEnd("run")
  console.log(data)
})()
