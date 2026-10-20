import { KoraRpcGroup } from "@kora/contracts";
import * as Effect from "effect/Effect";
import { RpcClient } from "effect/unstable/rpc";

export const makeKoraRpcClient = RpcClient.make(KoraRpcGroup);
type RpcClientFactory = typeof makeKoraRpcClient;
export type KoraRpcClient =
  RpcClientFactory extends Effect.Effect<infer Client, any, any> ? Client : never;
