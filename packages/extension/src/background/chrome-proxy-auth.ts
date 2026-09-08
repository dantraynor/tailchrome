import { ProxySession } from "@tailchrome/shared/background/proxy-session";
import type { ProxySessionCredentials } from "@tailchrome/shared/types";

export class ChromeProxyAuth {
  private readonly session = new ProxySession();
  private readonly attemptedRequests = new Set<string>();

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

  set(session: ProxySessionCredentials | null): void {
    this.session.set(session);
    this.attemptedRequests.clear();
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
