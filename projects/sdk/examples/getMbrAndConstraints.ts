import { AlgorandClient } from "@algorandfoundation/algokit-utils"
import { RetiGhostSDK } from "../src"

const registryAppId = 2714516089

const sdk = new RetiGhostSDK({
  algorand: AlgorandClient.mainNet(),
  registryAppId,
  ghostAppId: 3374692547n
})

;(async () => {
  console.time("run")

  const mbrAndConstraints = await sdk.getMbrAmountsAndProtocolConstraints()
  console.log("MBR Amounts and Protocol Constraints:", mbrAndConstraints)

  console.timeEnd("run")
})()
