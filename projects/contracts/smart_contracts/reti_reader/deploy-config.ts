import { AlgorandClient } from "@algorandfoundation/algokit-utils";
import { RetiReaderSDK } from "../../../sdk/src/generated/RetiReaderSDK"

// Below is a showcase of various deployment options you can use in TypeScript Client
export async function deploy() {
  console.log("=== Deploying RetiReader ===");

  const algorand = AlgorandClient.fromEnvironment();
  const deployer = await algorand.account.fromEnvironment("DEPLOYER");

  const factory = algorand.client.getTypedAppFactory(RetiReaderSDK.factory, {
    defaultSender: deployer.addr,
  });

  const { appClient, result } = await factory.deploy({
    onUpdate: "update",
    onSchemaBreak: "fail",
    createParams: { method: "getValidatorStates(uint64,uint64[])(uint16,uint64,uint64,uint64)", args: { registryAppId: 1n, validatorIds: [] }, extraProgramPages: 1 },
  });
}
