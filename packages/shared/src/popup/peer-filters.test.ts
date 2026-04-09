import { describe, expect, it } from "vitest";
import type { PeerInfo } from "../types";
import {
  isMullvadExitNodePeer,
  peersForDeviceList,
  MULLVAD_EXIT_NODE_TAG,
} from "./peer-filters";

function basePeer(overrides: Partial<PeerInfo> = {}): PeerInfo {
  return {
    id: "id1",
    hostname: "host",
    dnsName: "host.ts.net",
    tailscaleIPs: ["100.1.1.1"],
    os: "linux",
    online: true,
    active: true,
    exitNode: false,
    exitNodeOption: false,
    isSubnetRouter: false,
    subnets: [],
    tags: [],
    rxBytes: 0,
    txBytes: 0,
    lastSeen: null,
    lastHandshake: null,
    location: null,
    taildropTarget: false,
    sshHost: false,
    userId: 1,
    userName: "",
    userLoginName: "",
    userProfilePicURL: "",
    ...overrides,
  };
}

describe("peer-filters", () => {
  it("detects Mullvad exit peers by tag", () => {
    const m = basePeer({
      tags: [MULLVAD_EXIT_NODE_TAG],
      hostname: "ar-bue-wg-001",
    });
    const home = basePeer({ tags: [], hostname: "imac" });
    expect(isMullvadExitNodePeer(m)).toBe(true);
    expect(isMullvadExitNodePeer(home)).toBe(false);
  });

  it("peersForDeviceList removes Mullvad exit infrastructure", () => {
    const peers = [
      basePeer({ id: "a", tags: [MULLVAD_EXIT_NODE_TAG] }),
      basePeer({ id: "b", tags: [], hostname: "phone" }),
    ];
    expect(peersForDeviceList(peers)).toHaveLength(1);
    expect(peersForDeviceList(peers)[0]!.hostname).toBe("phone");
  });
});
