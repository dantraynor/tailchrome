import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import type { StatusUpdate, TailscaleState } from "../types";
import { baseState, makePeer } from "../__test__/fixtures";
import { RoutingProtection, ROUTING_STORAGE_KEY } from "./routing-protection";

const prefs = {
  exitNodeID: "exit1",
  exitNodeAllowLANAccess: false,
  corpDNS: true,
  shieldsUp: false,
};
function connected(overrides: Partial<TailscaleState> = {}): TailscaleState {
  return baseState({
    selfNode: { ...makePeer(), keyExpiry: null, id: "self1" },
    prefs,
    exitNode: {
      id: "exit1",
      hostname: "exit",
      dnsName: "exit.example.ts.net",
      online: true,
      location: null,
    },
    ...overrides,
  });
}
function status(state: TailscaleState): StatusUpdate {
  return {
    ...state,
    running: state.backendState === "Running",
    needsLogin: false,
    browseToURL: "",
    magicDNSSuffix: state.magicDNSSuffix || "",
  };
}
const offline = () =>
  connected({
    hostConnected: false,
    proxyEnabled: false,
    proxyPort: null,
    backendState: "NoState",
  });
const flush = async () => {
  for (let i = 0; i < 10; i++) await Promise.resolve();
};

describe("routing protection", () => {
  let saved: Record<string, unknown>;
  beforeEach(() => {
    saved = {};
    vi.spyOn(chrome.storage.local, "get").mockImplementation(async (key) => ({
      [key as string]: saved[key as string],
    }));
    vi.spyOn(chrome.storage.local, "set").mockImplementation(async (value) => {
      Object.assign(saved, value);
    });
  });
  afterEach(() => vi.restoreAllMocks());
  it("blocks during startup before storage resolves", () => {
    const routing = new RoutingProtection();
    expect(routing.decorate(baseState()).routingPolicy).toMatchObject({
      mode: "blocked",
      domainSplit: { mode: "bypass", domains: [] },
    });
  });
  it("preserves selection when the selected node disappears from status", async () => {
    const routing = new RoutingProtection();
    await routing.restore();
    routing.confirmStatus(status(connected()), connected());
    const missing = connected({ exitNode: null });
    routing.confirmStatus(status(missing), missing);
    expect(routing.decorate(missing)).toMatchObject({
      selectedExitNodeID: "exit1",
      routingPolicy: { mode: "blocked" },
    });
  });
  it("restores protection across worker and browser restarts without a stale port", async () => {
    const routing = new RoutingProtection();
    await routing.restore();
    routing.confirmStatus(status(connected()), connected());
    await flush();
    expect(JSON.stringify(saved)).not.toContain("proxyPort");
    const restored = new RoutingProtection();
    await restored.restore();
    expect(restored.decorate(offline()).routingPolicy).toMatchObject({
      mode: "blocked",
      selectedExitNodeID: "exit1",
      proxyPort: null,
    });
  });
  it("does not release protection on Stopped, login, or helper errors", async () => {
    const routing = new RoutingProtection();
    await routing.restore();
    routing.confirmStatus(status(connected()), connected());
    for (const backendState of [
      "Stopped",
      "NeedsLogin",
      "NoState",
      "Starting",
    ] as const) {
      const state = connected({ backendState });
      routing.confirmStatus(status(state), state);
      expect(routing.decorate(state).routingPolicy?.mode).toBe("blocked");
    }
  });
  it("does not apply one account's saved selection to another", async () => {
    const routing = new RoutingProtection();
    await routing.restore();
    routing.confirmStatus(status(connected()), connected());
    const other = connected({
      selfNode: { ...makePeer(), keyExpiry: null, id: "self2" },
      prefs: { ...prefs, exitNodeID: "" },
      exitNode: null,
    });
    routing.confirmStatus(status(other), other);
    expect(routing.decorate(other).selectedExitNodeID).toBeNull();
    const returned = connected({
      prefs: { ...prefs, exitNodeID: "" },
      exitNode: null,
    });
    routing.confirmStatus(status(returned), returned);
    expect(routing.decorate(returned).selectedExitNodeID).toBe("exit1");
  });
  it("scopes saved selection to the coordination server too", async () => {
    const routing = new RoutingProtection();
    await routing.restore();
    routing.confirmStatus(status(connected()), connected());
    const other = connected({
      prefs: {
        ...prefs,
        exitNodeID: "",
        controlURL: "https://headscale.example",
      },
      exitNode: null,
    });
    routing.confirmStatus(status(other), other);
    expect(routing.decorate(other).selectedExitNodeID).toBeNull();
  });
  it("keeps protection until None is confirmed by the helper", async () => {
    const routing = new RoutingProtection();
    await routing.restore();
    routing.confirmStatus(status(connected()), connected());
    routing.selectExitNode("");
    expect(routing.decorate(offline()).selectedExitNodeID).toBe("exit1");
    const cleared = connected({
      prefs: { ...prefs, exitNodeID: "" },
      exitNode: null,
    });
    routing.confirmStatus(status(cleared), cleared);
    expect(routing.decorate(cleared).selectedExitNodeID).toBeNull();
  });
  it("blocks while a newly selected node is not confirmed", async () => {
    const routing = new RoutingProtection();
    await routing.restore();
    routing.confirmStatus(status(connected()), connected());
    routing.selectExitNode("exit2");
    routing.confirmStatus(status(connected()), connected());
    expect(routing.decorate(connected()).routingPolicy).toMatchObject({
      mode: "blocked",
      selectedExitNodeID: "exit2",
    });
  });
  it("keeps split-tunnel exclusions while the helper is unavailable", async () => {
    const state = connected({
      domainSplit: { mode: "only", domains: ["work.example"] },
      peers: [makePeer({ subnets: ["10.10.0.0/16"] })],
    });
    const routing = new RoutingProtection();
    await routing.restore();
    routing.confirmStatus(status(state), state);
    expect(
      routing.decorate({
        ...state,
        ...offline(),
        domainSplit: state.domainSplit,
      }).routingPolicy,
    ).toMatchObject({
      mode: "blocked",
      subnetCIDRs: ["10.10.0.0/16"],
      domainSplit: { mode: "only", domains: ["work.example"] },
    });
  });
  it.each(["Stopped", "NeedsLogin"] as const)("releases a requested disconnect after %s is confirmed", async (backendState) => {
    const routing = new RoutingProtection();
    await routing.restore();
    routing.confirmStatus(status(connected()), connected());
    routing.requestDisconnect();
    const stopped = connected({ backendState });
    routing.confirmStatus(status(stopped), stopped);
    expect(routing.decorate(stopped).routingPolicy?.mode).toBe("direct");
  });
  it("allows an explicit local release when the helper cannot respond", async () => {
    const routing = new RoutingProtection();
    await routing.restore();
    routing.confirmStatus(status(connected()), connected());
    routing.release();
    await flush();
    expect(routing.decorate(offline()).routingPolicy?.mode).toBe("direct");
    expect(saved[ROUTING_STORAGE_KEY]).toMatchObject({ released: true });
  });
  it("blocks if the saved protection cannot be read", async () => {
    vi.mocked(chrome.storage.local.get).mockRejectedValue(
      new Error("storage unavailable"),
    );
    const routing = new RoutingProtection();
    await routing.restore();
    expect(routing.decorate(offline()).routingPolicy?.mode).toBe("blocked");
  });
  it("keeps an explicit disconnect released after a worker restart", async () => {
    const routing = new RoutingProtection();
    await routing.restore();
    routing.confirmStatus(status(connected()), connected());
    routing.release();
    await flush();
    const restored = new RoutingProtection();
    await restored.restore();
    const stopped = connected({ backendState: "Stopped" });
    restored.confirmStatus(status(stopped), stopped);
    expect(restored.decorate(stopped).routingPolicy?.mode).toBe("direct");
  });
  it("does not carry pending commands across an account change", async () => {
    const routing = new RoutingProtection();
    await routing.restore();
    routing.confirmStatus(status(connected()), connected());
    routing.selectExitNode("other-exit");
    routing.requestDisconnect();
    const other = connected({
      selfNode: { ...makePeer(), keyExpiry: null, id: "self2" },
      prefs: { ...prefs, exitNodeID: "" },
      exitNode: null,
    });
    routing.confirmStatus(status(other), other);
    expect(routing.decorate(other).routingPolicy).toMatchObject({
      mode: "active",
      selectedExitNodeID: null,
    });
  });

  it("restores protection before reconnecting a previously released account", async () => {
    const routing = new RoutingProtection();
    await routing.restore();
    routing.confirmStatus(status(connected()), connected());
    routing.release();
    await flush();
    const restored = new RoutingProtection();
    await restored.restore();
    restored.reconnect();
    expect(restored.decorate(offline()).routingPolicy).toMatchObject({
      mode: "blocked",
      selectedExitNodeID: "exit1",
    });
  });
  it("blocks an account switch immediately and ignores status from the old account", async () => {
    const routing = new RoutingProtection();
    await routing.restore();
    routing.confirmStatus(status(connected()), connected());
    routing.switchProfile();
    routing.confirmStatus(status(connected()), connected());
    expect(routing.decorate(connected()).routingPolicy).toMatchObject({
      mode: "blocked",
      blockAll: true,
    });
  });

  it("does not discard protected routes on restore", async () => {
    const peers = [
      makePeer({
        subnets: Array.from(
          { length: 4097 },
          (_, i) => `10.${Math.floor(i / 256)}.${i % 256}.0/24`,
        ),
      }),
    ];
    const state = connected({
      peers,
      prefs: { ...prefs, exitNodeID: "" },
      exitNode: null,
    });
    const routing = new RoutingProtection();
    await routing.restore();
    routing.confirmStatus(status(state), state);
    await flush();
    const restored = new RoutingProtection();
    await restored.restore();
    expect(
      restored.decorate(offline()).routingPolicy?.subnetCIDRs,
    ).toHaveLength(4097);
  });
  it("blocks all traffic for malformed saved constraints", async () => {
    const routing = new RoutingProtection();
    await routing.restore();
    routing.confirmStatus(status(connected()), connected());
    await flush();
    const value = saved[ROUTING_STORAGE_KEY] as {
      active: { subnetCIDRs: unknown[] };
    };
    value.active.subnetCIDRs.push("invalid/24");
    const restored = new RoutingProtection();
    await restored.restore();
    expect(restored.decorate(offline()).routingPolicy).toMatchObject({
      mode: "blocked",
      blockAll: true,
    });
  });

  it("preserves a pending None confirmation across a worker restart", async () => {
    const routing = new RoutingProtection();
    await routing.restore();
    routing.confirmStatus(status(connected()), connected());
    routing.selectExitNode("");
    await flush();
    const restored = new RoutingProtection();
    await restored.restore();
    const cleared = connected({
      prefs: { ...prefs, exitNodeID: "" },
      exitNode: null,
    });
    restored.confirmStatus(status(cleared), cleared);
    expect(restored.decorate(cleared).selectedExitNodeID).toBeNull();
  });
  it("preserves a pending disconnect confirmation across a worker restart", async () => {
    const routing = new RoutingProtection();
    await routing.restore();
    routing.confirmStatus(status(connected()), connected());
    routing.requestDisconnect();
    await flush();
    const restored = new RoutingProtection();
    await restored.restore();
    const stopped = connected({ backendState: "Stopped" });
    restored.confirmStatus(status(stopped), stopped);
    expect(restored.decorate(stopped).routingPolicy?.mode).toBe("direct");
  });
});
