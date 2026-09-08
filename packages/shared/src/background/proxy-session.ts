import type { NativeReply, ProxySessionCredentials } from "../types";

/** Credentials travel only from native messaging to the background proxy manager. */
export function readProxySession(
  reply: NonNullable<NativeReply["procRunning"]>,
): ProxySessionCredentials | null {
  const auth = reply.proxyAuth;
  if (
    !Number.isInteger(reply.port) || reply.port < 1 || reply.port > 65535 ||
    !auth || auth.version !== 1 ||
    typeof auth.username !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(auth.username) ||
    typeof auth.password !== "string" || !/^[A-Za-z0-9_-]{32,128}$/.test(auth.password)
  ) return null;
  return { port: reply.port, username: auth.username, password: auth.password };
}

export class ProxySession {
  #session: ProxySessionCredentials | null = null;

  set(session: ProxySessionCredentials | null): void {
    this.#session = session ? { ...session } : null;
  }

  credentialsFor(port: number): { username: string; password: string } | undefined {
    if (!this.#session || this.#session.port !== port) return undefined;
    return { username: this.#session.username, password: this.#session.password };
  }
}
