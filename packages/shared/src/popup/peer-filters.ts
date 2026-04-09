import type { PeerInfo } from "../types";

/** Tag on Mullvad-provided exit nodes; they should not appear as normal tailnet "devices". */
export const MULLVAD_EXIT_NODE_TAG = "tag:mullvad-exit-node";

export function isMullvadExitNodePeer(peer: PeerInfo): boolean {
  return peer.tags.includes(MULLVAD_EXIT_NODE_TAG);
}

/**
 * Peers shown in the main popup list (online/offline devices).
 * Omits Mullvad exit infrastructure — those are only reachable via Exit Node.
 */
export function peersForDeviceList(peers: PeerInfo[]): PeerInfo[] {
  return peers.filter((p) => !isMullvadExitNodePeer(p));
}
