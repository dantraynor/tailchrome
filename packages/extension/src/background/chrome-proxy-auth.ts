import { ProxySession } from "@tailchrome/shared/background/proxy-session";
import type { ProxySessionCredentials } from "@tailchrome/shared/types";

export const PROXY_AUTH_PROBE_HOST = "tailchrome-proxy-auth.invalid";

export class ChromeProxyAuth {
  private readonly session = new ProxySession();
  private readonly attemptedRequests = new Set<string>();
  private readyPort: number | null = null;
  private probe: AbortController | null = null;

  constructor() {
    chrome.webRequest.onAuthRequired.addListener(
      this.listener,
      { urls: ["<all_urls>"] },
      ["asyncBlocking"],
    );
  }

  hasSession(port: number): boolean {
    return this.session.credentialsFor(port) !== undefined;
  }

  set(session: ProxySessionCredentials | null): boolean {
    const previous = session && this.session.credentialsFor(session.port);
    if (previous && previous.username === session.username && previous.password === session.password) return false;
    this.probe?.abort();
    this.probe = null;
    this.readyPort = null;
    this.session.set(session);
    this.attemptedRequests.clear();
    return true;
  }

  isReadyFor(port: number): boolean {
    return this.readyPort === port && this.hasSession(port);
  }

  // Chrome hides other extensions' requests from onAuthRequired. Populate its
  // proxy auth cache with our own request before enabling protected routes.
  // Proxy credentials are shared across origins, unlike server credentials.
  async prepare(port: number): Promise<void> {
    if (!this.hasSession(port)) throw new Error("Proxy session unavailable");
    if (this.isReadyFor(port)) return;
    this.probe?.abort();
    const controller = new AbortController();
    this.probe = controller;
    const timeout = setTimeout(() => controller.abort(), 5000);
    try {
      const response = await fetch(`http://${PROXY_AUTH_PROBE_HOST}/`, {
        method: "HEAD",
        credentials: "include",
        cache: "no-store",
        redirect: "error",
        signal: controller.signal,
      });
      // Older authenticated helpers return 502 for this reserved destination.
      // Any HTTP response other than 407 means proxy authentication completed;
      // success does not depend on a tailnet service or the Tailscale web UI.
      if (response.status === 407 || controller.signal.aborted || this.probe !== controller) {
        throw new Error("Proxy authentication failed");
      }
      this.readyPort = port;
    } finally {
      clearTimeout(timeout);
      if (this.probe === controller) this.probe = null;
    }
  }

  readonly listener = (
    details: chrome.webRequest.OnAuthRequiredDetails,
    callback?: (response: chrome.webRequest.BlockingResponse) => void,
  ): undefined => {
    if (!details.isProxy || details.challenger.host !== "127.0.0.1") {
      callback?.({});
      return;
    }
    const credentials = this.session.credentialsFor(details.challenger.port);
    if (!credentials) {
      callback?.({});
      return;
    }
    // Do not open an endless challenge loop if a process no longer accepts its credential.
    if (this.attemptedRequests.has(details.requestId)) {
      callback?.({ cancel: true });
      return;
    }
    if (this.attemptedRequests.size >= 1024) {
      this.attemptedRequests.delete(this.attemptedRequests.values().next().value!);
    }
    this.attemptedRequests.add(details.requestId);
    callback?.({ authCredentials: credentials });
  };
}
