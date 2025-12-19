import pMap from "p-map";
import { chunk } from "./chunk.js";

/**
 * Decorator that automatically chunks array arguments and aggregates results
 * @param chunkSize - The maximum size of each chunk
 * @returns Method decorator
 */
export function chunked(
  chunkSize: number,
  { chunkArgIndex = 0 }: { chunkArgIndex?: number } = {},
) {
  return function (
    target: any,
    propertyKey: string,
    descriptor: PropertyDescriptor
  ): PropertyDescriptor {
    const originalMethod = descriptor.value;

    descriptor.value = async function (...args: any[]) {
      const ids = args[chunkArgIndex];
      const instanceConcurrency =
        this && typeof (this as any).concurrency === "number"
          ? (this as any).concurrency
          : 2;
      // If appIds array is smaller than or equal to chunk size, call original method directly
      if (ids.length <= chunkSize) {
        // console.log("No chunking needed, calling original method directly.");
        return originalMethod.apply(this, [ids, ...args]);
      }
      console.log({
        message: `Chunking array of size ${ids.length} into chunks of size ${chunkSize} with concurrency ${instanceConcurrency}`,
      });
      // Chunk the appIds array
      const chunks = chunk(ids, chunkSize);
      const results = await pMap(chunks, async (chunkedIds) => {
        // console.log(`Processing chunk of size ${chunkedIds.length}: ${chunkedIds}`);
        return originalMethod.apply(this, [chunkedIds, ...args]);
      }, { concurrency: instanceConcurrency });

      // Flatten the results into a single array
      return results.flat();
    };

    return descriptor;
  };
}
