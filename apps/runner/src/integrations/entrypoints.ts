// Persistent entrypoints the integration host hands to gatekeepers (ADR 0050). Each is minted
// with props (`ctx.exports.X({ props })`), so a gatekeeper can store it and call it back later:
// - ConnectCallback: the connect flow's `GatekeeperConnectCallback` for one connection;
// - HostHookInitiator: a bound hook's `HookInitiator`, whose startHook() opens one firing.
// Both forward to the connection's integration host Durable Object.
import { WorkerEntrypoint } from "cloudflare:workers";
import { hostFor } from "./runtime.ts";

export class ConnectCallback extends WorkerEntrypoint<
  Env,
  { connectionId: string; vendor: string }
> {
  async complete(user: unknown, expiresAt?: Date) {
    return hostFor(this.env, this.ctx.props.connectionId).stage(
      this.ctx.props.vendor,
      user,
      expiresAt,
    );
  }

  async reconnectComplete(stageId: string, _expiresAt?: Date) {
    return hostFor(this.env, this.ctx.props.connectionId).stageReconnect(
      this.ctx.props.vendor,
      stageId,
    );
  }

  async credentialsExpired(): Promise<void> {
    await hostFor(this.env, this.ctx.props.connectionId).credentialsChanged("expired");
  }

  async credentialsRestored(_expiresAt?: Date): Promise<void> {
    await hostFor(this.env, this.ctx.props.connectionId).credentialsChanged("restored");
  }
}

export class HostHookInitiator extends WorkerEntrypoint<
  Env,
  { connectionId: string; hookId: string }
> {
  async startHook() {
    return hostFor(this.env, this.ctx.props.connectionId).startHook(this.ctx.props.hookId);
  }
}
