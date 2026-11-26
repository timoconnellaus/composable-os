// Persistent entrypoints the integration host hands to gatekeepers (ADR 0050). Each is minted
// with props (`ctx.exports.X({ props })`), so a gatekeeper can store it and call it back later:
// - ConnectCallback: the connect flow's `GatekeeperConnectCallback` for one connection;
// - HostHookInitiator: a bound hook's `HookInitiator`, whose startHook() opens one firing.
// Both forward to the connection's integration host Durable Object.
//
// On a many-client host (stage 66, ADR 0615) the props carry the client whose connection minted
// them: a gatekeeper calling back reaches that client's connection object and no other, since
// props are the host's and the holder cannot change them. One minted without a client refuses.
import { WorkerEntrypoint } from "cloudflare:workers";
import { propsClientEnvironment } from "@composable-os/db/client-entries";
import { hostFor } from "./runtime.ts";

interface Minted {
  connectionId: string;
  /** The client, on a many-client host; absent or null on a single-client deployment. */
  client?: string | null;
}

/** The minting connection's object, in its client's environment. */
async function mintedHost(env: Env, props: Minted) {
  // A gatekeeper's callback carries on for a client that is paused (its flow began before).
  const clientEnv = await propsClientEnvironment(env, props, { served: false });
  return hostFor(clientEnv, props.connectionId);
}

export class ConnectCallback extends WorkerEntrypoint<Env, Minted & { vendor: string }> {
  async complete(user: unknown, expiresAt?: Date) {
    return (await mintedHost(this.env, this.ctx.props)).stage(
      this.ctx.props.vendor,
      user,
      expiresAt,
    );
  }

  async reconnectComplete(stageId: string, _expiresAt?: Date) {
    return (await mintedHost(this.env, this.ctx.props)).stageReconnect(
      this.ctx.props.vendor,
      stageId,
    );
  }

  async credentialsExpired(): Promise<void> {
    await (await mintedHost(this.env, this.ctx.props)).credentialsChanged("expired");
  }

  async credentialsRestored(_expiresAt?: Date): Promise<void> {
    await (await mintedHost(this.env, this.ctx.props)).credentialsChanged("restored");
  }
}

export class HostHookInitiator extends WorkerEntrypoint<Env, Minted & { hookId: string }> {
  async startHook() {
    return (await mintedHost(this.env, this.ctx.props)).startHook(this.ctx.props.hookId);
  }
}
