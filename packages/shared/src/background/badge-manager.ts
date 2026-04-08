import type { TailscaleState } from "../types";

type IconPaths = { [size: number]: string };

const ONLINE_ICONS: IconPaths = {
  16: "icons/icon-16.png",
  32: "icons/icon-32.png",
  48: "icons/icon-48.png",
  128: "icons/icon-128.png",
};

const OFFLINE_ICONS: IconPaths = {
  16: "icons/icon-16-offline.png",
  32: "icons/icon-32-offline.png",
  48: "icons/icon-48-offline.png",
  128: "icons/icon-128-offline.png",
};

const WARNING_ICONS: IconPaths = {
  16: "icons/icon-16-warning.png",
  32: "icons/icon-32-warning.png",
  48: "icons/icon-48-warning.png",
  128: "icons/icon-128-warning.png",
};

const BADGE_COLOR_ORANGE = "#E5832A";
const BADGE_COLOR_BLUE = "#4C78C6";
const BADGE_COLOR_GRAY = "#888888";

export class BadgeManager {
  private lastBadgeKey = "";

  update(state: TailscaleState): void {
    const badgeKey = this.computeBadgeKey(state);
    if (badgeKey === this.lastBadgeKey) return;
    this.lastBadgeKey = badgeKey;

    if (state.installError || state.hostVersionMismatch) {
      this.setIcon(WARNING_ICONS);
      this.setBadge("!", BADGE_COLOR_ORANGE);
      return;
    }

    if (!state.hostConnected || state.backendState === "Stopped") {
      this.setIcon(OFFLINE_ICONS);
      this.clearBadge();
      return;
    }

    if (
      state.backendState === "NeedsLogin" ||
      state.backendState === "NeedsMachineAuth"
    ) {
      this.setIcon(OFFLINE_ICONS);
      this.setBadge("?", BADGE_COLOR_BLUE);
      return;
    }

    if (state.backendState === "Starting") {
      this.setIcon(OFFLINE_ICONS);
      this.setBadge("...", BADGE_COLOR_GRAY);
      return;
    }

    if (state.backendState === "Running") {
      this.setIcon(ONLINE_ICONS);
      if (state.exitNode !== null) {
        this.setBadge("EN", BADGE_COLOR_BLUE);
      } else {
        this.clearBadge();
      }
      return;
    }

    // Default: NoState, InUseOtherUser, or any unknown state
    this.setIcon(OFFLINE_ICONS);
    this.clearBadge();
  }

  private computeBadgeKey(state: TailscaleState): string {
    return [
      state.installError ? "install" : state.hostVersionMismatch ? "mismatch" : "",
      state.hostConnected ? "conn" : "disc",
      state.backendState,
      state.exitNode !== null ? "exit" : "noexit",
    ].join(":");
  }

  private setIcon(paths: IconPaths): void {
    chrome.action.setIcon({ path: paths }).catch(() => {
      if (paths === WARNING_ICONS) {
        chrome.action.setIcon({ path: OFFLINE_ICONS }).catch(() => {});
      }
    });
  }

  private setBadge(text: string, color: string): void {
    chrome.action.setBadgeText({ text });
    chrome.action.setBadgeBackgroundColor({ color });
  }

  private clearBadge(): void {
    chrome.action.setBadgeText({ text: "" });
  }
}
