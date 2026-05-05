// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PeerInfo } from "../../types";
import { baseState, makePeer } from "../../__test__/fixtures";
import { MULLVAD_EXIT_NODE_TAG } from "../peer-filters";
import { sendMessage } from "../popup";
import { renderExitNodes, selectRecommendedMullvadExitNode } from "./exit-nodes";

vi.mock("../popup", () => ({
  sendMessage: vi.fn(),
}));

afterEach(() => {
  vi.clearAllMocks();
});

function mullvadPeer(overrides: Partial<PeerInfo> = {}) {
  return makePeer({
    id: "mullvad-1",
    hostname: "de-fra-wg-001",
    exitNodeOption: true,
    tags: [MULLVAD_EXIT_NODE_TAG],
    location: {
      city: "Frankfurt",
      cityCode: "FRA",
      country: "Germany",
      countryCode: "DE",
    },
    ...overrides,
  });
}

describe("selectRecommendedMullvadExitNode", () => {
  it("ignores non-Mullvad exit nodes", () => {
    const homeExit = makePeer({
      id: "home",
      hostname: "apple-tv",
      exitNodeOption: true,
      online: true,
      location: { city: "New York", country: "United States", countryCode: "US" },
    });
    const mullvad = mullvadPeer({ id: "mullvad" });

    expect(selectRecommendedMullvadExitNode([homeExit, mullvad])?.id).toBe(
      "mullvad",
    );
  });

  it("prefers online Mullvad nodes", () => {
    const offlineHighPriority = mullvadPeer({
      id: "offline",
      online: false,
      location: { city: "Paris", country: "France", countryCode: "FR", priority: 100 },
    });
    const onlineLowPriority = mullvadPeer({
      id: "online",
      online: true,
      location: { city: "Berlin", country: "Germany", countryCode: "DE", priority: 1 },
    });

    expect(
      selectRecommendedMullvadExitNode(
        [offlineHighPriority, onlineLowPriority],
        null,
      )?.id,
    ).toBe("online");
  });

  it("uses location priority among online Mullvad nodes", () => {
    const lower = mullvadPeer({
      id: "lower",
      location: { city: "Berlin", country: "Germany", countryCode: "DE", priority: 10 },
    });
    const higher = mullvadPeer({
      id: "higher",
      location: { city: "Frankfurt", country: "Germany", countryCode: "DE", priority: 20 },
    });

    expect(selectRecommendedMullvadExitNode([lower, higher], null)?.id).toBe(
      "higher",
    );
  });

  it("prefers nearby US Mullvad nodes for a US client", () => {
    const adelaide = mullvadPeer({
      id: "adelaide",
      location: {
        city: "Adelaide",
        country: "Australia",
        countryCode: "AU",
        latitude: -34.9285,
        longitude: 138.6007,
        priority: 100,
      },
    });
    const newYork = mullvadPeer({
      id: "new-york",
      location: {
        city: "New York",
        country: "United States",
        countryCode: "US",
        latitude: 40.7128,
        longitude: -74.006,
      },
    });

    expect(
      selectRecommendedMullvadExitNode([adelaide, newYork], {
        latitude: 40.7128,
        longitude: -74.006,
        countryCode: "US",
      })?.id,
    ).toBe("new-york");
  });

  it("returns null when no Mullvad node has a displayable location", () => {
    const coordinatesOnly = mullvadPeer({
      location: { latitude: 50.1, longitude: 8.6 },
    });

    expect(selectRecommendedMullvadExitNode([coordinatesOnly])).toBeNull();
  });

  it("sends set-exit-node when the recommended row is clicked", () => {
    const root = document.createElement("div");
    const recommended = mullvadPeer({
      id: "new-york",
      hostname: "us-nyc-wg-001",
      location: {
        city: "New York, NY, USA",
        country: "United States",
        countryCode: "US",
        latitude: 40.7128,
        longitude: -74.006,
      },
    });

    renderExitNodes(
      root,
      baseState({ peers: [recommended] }),
      () => {},
    );

    const row = root.querySelector<HTMLElement>(
      ".exit-nodes-section--suggested .exit-node-row",
    );
    expect(row).not.toBeNull();

    row!.click();

    expect(sendMessage).toHaveBeenCalledWith({
      type: "set-exit-node",
      nodeID: "new-york",
    });
  });

  it("marks the recommended radio selected immediately when clicked", () => {
    const root = document.createElement("div");
    const recommended = mullvadPeer({
      id: "new-york",
      hostname: "us-nyc-wg-001",
      location: {
        city: "New York, NY, USA",
        country: "United States",
        countryCode: "US",
        latitude: 40.7128,
        longitude: -74.006,
      },
    });

    renderExitNodes(root, baseState({ peers: [recommended] }), () => {});

    const row = root.querySelector<HTMLElement>(
      ".exit-nodes-section--suggested .exit-node-row",
    )!;
    const radio = row.querySelector<HTMLElement>(".exit-node-radio")!;

    row.click();

    expect(row.getAttribute("aria-checked")).toBe("true");
    expect(radio.classList.contains("exit-node-radio--selected")).toBe(true);
  });

  it("keeps the recommended radio selected across an intermediate status update", () => {
    const root = document.createElement("div");
    const recommended = mullvadPeer({
      id: "new-york",
      hostname: "us-nyc-wg-001",
      location: {
        city: "New York, NY, USA",
        country: "United States",
        countryCode: "US",
        latitude: 40.7128,
        longitude: -74.006,
      },
    });

    renderExitNodes(root, baseState({ peers: [recommended] }), () => {});
    root
      .querySelector<HTMLElement>(".exit-nodes-section--suggested .exit-node-row")!
      .click();

    renderExitNodes(
      root,
      baseState({ peers: [recommended], pendingExitNodeID: "new-york" }),
      () => {},
    );

    const rerenderedRadio = root.querySelector<HTMLElement>(
      ".exit-nodes-section--suggested .exit-node-radio",
    )!;
    expect(rerenderedRadio.classList.contains("exit-node-radio--selected")).toBe(
      true,
    );
  });

  it("keeps the recommended radio selected when the host reports another peer in the same city", () => {
    const root = document.createElement("div");
    const recommended = mullvadPeer({
      id: "new-york-a",
      hostname: "us-nyc-wg-001",
      location: {
        city: "New York, NY, USA",
        cityCode: "NYC",
        country: "United States",
        countryCode: "US",
        latitude: 40.7128,
        longitude: -74.006,
      },
    });
    const selectedSameCity = mullvadPeer({
      id: "new-york-b",
      hostname: "us-nyc-wg-002",
      location: {
        city: "New York, NY, USA",
        cityCode: "NYC",
        country: "United States",
        countryCode: "US",
        latitude: 40.7128,
        longitude: -74.006,
      },
    });

    renderExitNodes(
      root,
      baseState({
        peers: [recommended, selectedSameCity],
        exitNode: {
          id: "new-york-b",
          hostname: "us-nyc-wg-002",
          location: selectedSameCity.location,
          online: true,
        },
      }),
      () => {},
    );

    const radio = root.querySelector<HTMLElement>(
      ".exit-nodes-section--suggested .exit-node-radio",
    )!;
    expect(radio.classList.contains("exit-node-radio--selected")).toBe(true);
  });

  it("still sends set-exit-node when the recommended row is already selected", () => {
    const root = document.createElement("div");
    const recommended = mullvadPeer({
      id: "new-york",
      hostname: "us-nyc-wg-001",
      location: {
        city: "New York, NY, USA",
        country: "United States",
        countryCode: "US",
        latitude: 40.7128,
        longitude: -74.006,
      },
    });

    renderExitNodes(
      root,
      baseState({
        peers: [recommended],
        exitNode: {
          id: "new-york",
          hostname: "us-nyc-wg-001",
          location: recommended.location,
          online: true,
        },
      }),
      () => {},
    );

    root
      .querySelector<HTMLElement>(".exit-nodes-section--suggested .exit-node-row")!
      .click();

    expect(sendMessage).toHaveBeenCalledWith({
      type: "set-exit-node",
      nodeID: "new-york",
    });
  });
});
