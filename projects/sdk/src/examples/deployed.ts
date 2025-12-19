import { AlgorandClient } from "@algorandfoundation/algokit-utils"
import { RetiGhostSDK } from ".."
import algosdk from "algosdk"

const deployer = algosdk.mnemonicToSecretKey(
  "city climb pledge blue dry live choose sorry exotic lucky whip paddle rain miss off report dish health shove mom museum burden reunion abstract term",
)

const algorand = AlgorandClient.testNet()

const factory = algorand.client.getTypedAppFactory(RetiGhostSDK.ghost.factory, {
  defaultSender: deployer.addr,
  defaultSigner: algosdk.makeBasicAccountTransactionSigner(deployer),
})

;(async () => {
  // const { appClient } = await factory.send.create.getBlockTimestamps({ args: { num: 0n }})

  // console.log(`Deployed RetiReader at app ID: ${appClient.appId}`)

  const deployed = new RetiGhostSDK({
    algorand,
    registryAppId: 0n,
    ghostAppId: 752173746n,
  })

  await deployed.getBlockTimestamps(10)
  console.log("--dEPlOyED--")
  console.time("deployed")
  await deployed.getBlockTimestamps(10)
  console.timeEnd("deployed")

  console.log("--ghost--")
  const ghost = new RetiGhostSDK({
    algorand,
    registryAppId: 0n,
  })

  console.time("ghost")
  await ghost.getBlockTimestamps(10)
  console.timeEnd("ghost")
})()
