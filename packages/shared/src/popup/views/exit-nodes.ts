import type { TailscaleState, PeerInfo } from "../../types";
import { addListKeyboardNav, formatLocationLabel, machineName } from "../utils";
import { sendMessage } from "../popup";
import { iconArrowLeft } from "../icons";
import { isMullvadExitNodePeer } from "../peer-filters";

interface MullvadCityGroup {
  city: string;
  cityCode: string;
  nodes: PeerInfo[];
}

interface MullvadCountryGroup {
  country: string;
  countryCode: string;
  cities: MullvadCityGroup[];
}

interface ExitNodeGrouping {
  own: PeerInfo[];
  mullvad: MullvadCountryGroup[];
  shared: PeerInfo[];
}

interface ApproxLocation {
  latitude: number;
  longitude: number;
  countryCode?: string;
}

const TIMEZONE_APPROX_LOCATIONS: Record<string, ApproxLocation> = {
  "America/New_York": { latitude: 40.7128, longitude: -74.006, countryCode: "US" },
  "America/Detroit": { latitude: 42.3314, longitude: -83.0458, countryCode: "US" },
  "America/Kentucky/Louisville": { latitude: 38.2527, longitude: -85.7585, countryCode: "US" },
  "America/Kentucky/Monticello": { latitude: 36.8298, longitude: -84.8491, countryCode: "US" },
  "America/Indiana/Indianapolis": { latitude: 39.7684, longitude: -86.1581, countryCode: "US" },
  "America/Indiana/Vincennes": { latitude: 38.6773, longitude: -87.5286, countryCode: "US" },
  "America/Indiana/Winamac": { latitude: 41.0514, longitude: -86.6031, countryCode: "US" },
  "America/Indiana/Marengo": { latitude: 38.369, longitude: -86.3436, countryCode: "US" },
  "America/Indiana/Petersburg": { latitude: 38.4914, longitude: -87.2786, countryCode: "US" },
  "America/Indiana/Vevay": { latitude: 38.7478, longitude: -85.0672, countryCode: "US" },
  "America/Chicago": { latitude: 41.8781, longitude: -87.6298, countryCode: "US" },
  "America/Indiana/Tell_City": { latitude: 37.9514, longitude: -86.7678, countryCode: "US" },
  "America/Indiana/Knox": { latitude: 41.2959, longitude: -86.625, countryCode: "US" },
  "America/Menominee": { latitude: 45.1078, longitude: -87.6143, countryCode: "US" },
  "America/North_Dakota/Center": { latitude: 47.1164, longitude: -101.2996, countryCode: "US" },
  "America/North_Dakota/New_Salem": { latitude: 46.8436, longitude: -101.4107, countryCode: "US" },
  "America/North_Dakota/Beulah": { latitude: 47.2633, longitude: -101.7779, countryCode: "US" },
  "America/Denver": { latitude: 39.7392, longitude: -104.9903, countryCode: "US" },
  "America/Boise": { latitude: 43.615, longitude: -116.2023, countryCode: "US" },
  "America/Phoenix": { latitude: 33.4484, longitude: -112.074, countryCode: "US" },
  "America/Los_Angeles": { latitude: 34.0522, longitude: -118.2437, countryCode: "US" },
  "America/Anchorage": { latitude: 61.2181, longitude: -149.9003, countryCode: "US" },
  "America/Juneau": { latitude: 58.3019, longitude: -134.4197, countryCode: "US" },
  "America/Sitka": { latitude: 57.0531, longitude: -135.33, countryCode: "US" },
  "America/Metlakatla": { latitude: 55.1292, longitude: -131.5764, countryCode: "US" },
  "America/Yakutat": { latitude: 59.5469, longitude: -139.7272, countryCode: "US" },
  "America/Nome": { latitude: 64.5011, longitude: -165.4064, countryCode: "US" },
  "America/Adak": { latitude: 51.88, longitude: -176.6581, countryCode: "US" },
  "Pacific/Honolulu": { latitude: 21.3069, longitude: -157.8583, countryCode: "US" },
};

/** Persists search query within a single exit node sub-view session. */
let exitNodeSearchQuery = "";

// Persists expand/collapse state across sub-view re-renders.
const expandedCountries = new Set<string>();
let autoExpandDone = false;

/**
 * Renders the exit node picker overlay.
 * Replaces the root content with a list of available exit nodes.
 */
export function renderExitNodes(
  root: HTMLElement,
  state: TailscaleState,
  onBack: () => void
): void {
  // Only reset the search query on initial open (not on state-driven re-renders).
  const initialOpen = !root.querySelector(".exit-nodes-header");
  if (initialOpen) {
    exitNodeSearchQuery = "";
  }
  root.textContent = "";
  const view = document.createElement("div");
  view.className = "view";

  const header = document.createElement("div");
  header.className = "exit-nodes-header";

  const backBtn = document.createElement("button");
  backBtn.className = "btn btn-ghost";
  const backIcon = document.createElement("span");
  backIcon.className = "icon icon-sm";
  backIcon.appendChild(iconArrowLeft());
  backBtn.appendChild(backIcon);
  backBtn.appendChild(document.createTextNode(" Back"));
  backBtn.addEventListener("click", onBack);
  header.appendChild(backBtn);

  const title = document.createElement("h3");
  title.className = "exit-nodes-title";
  title.textContent = "Exit Nodes";
  header.appendChild(title);

  view.appendChild(header);

  const allExitNodes = state.peers.filter((p) => p.exitNodeOption);
  if (allExitNodes.length > 4) {
    const searchContainer = document.createElement("div");
    searchContainer.className = "peer-search-container";

    const searchInput = document.createElement("input");
    searchInput.type = "text";
    searchInput.className = "peer-search";
    searchInput.placeholder = "Search exit nodes\u2026";
    searchInput.value = exitNodeSearchQuery;
    searchInput.addEventListener("input", () => {
      exitNodeSearchQuery = searchInput.value;
      // Re-render the node list below the search
      const listContainer = view.querySelector<HTMLElement>(".exit-nodes-list");
      if (listContainer) {
        renderExitNodeList(listContainer, state, allExitNodes);
      }
    });
    searchContainer.appendChild(searchInput);
    view.appendChild(searchContainer);
  }

  const listContainer = document.createElement("div");
  listContainer.className = "exit-nodes-list";
  renderExitNodeList(listContainer, state, allExitNodes);
  view.appendChild(listContainer);

  const lanRow = document.createElement("div");
  lanRow.className = "setting-row exit-nodes-lan";

  const lanCheckbox = document.createElement("input");
  lanCheckbox.type = "checkbox";
  lanCheckbox.id = "allow-lan";
  lanCheckbox.checked = state.prefs?.exitNodeAllowLANAccess ?? false;
  lanCheckbox.addEventListener("change", () => {
    sendMessage({
      type: "set-pref",
      key: "exitNodeAllowLANAccess",
      value: lanCheckbox.checked,
    });
  });

  const lanLabel = document.createElement("label");
  lanLabel.htmlFor = "allow-lan";
  lanLabel.className = "setting-label";
  lanLabel.textContent = "Allow LAN access";

  lanRow.appendChild(lanCheckbox);
  lanRow.appendChild(lanLabel);
  view.appendChild(lanRow);

  root.appendChild(view);
}

function filterExitNodes(nodes: PeerInfo[], query: string): PeerInfo[] {
  if (!query) return nodes;
  const lower = query.toLowerCase();
  return nodes.filter((n) =>
    machineName(n).toLowerCase().includes(lower) ||
    n.hostname.toLowerCase().includes(lower) ||
    (n.location?.city && n.location.city.toLowerCase().includes(lower)) ||
    (n.location?.country && n.location.country.toLowerCase().includes(lower)) ||
    (n.location?.countryCode && n.location.countryCode.toLowerCase().includes(lower))
  );
}

function renderExitNodeList(
  container: HTMLElement,
  state: TailscaleState,
  allExitNodes: PeerInfo[],
): void {
  if (!container.dataset.kbnav) {
    addListKeyboardNav(container, ".exit-node-row");
    container.dataset.kbnav = "1";
  }
  container.textContent = "";

  const filtered = filterExitNodes(allExitNodes, exitNodeSearchQuery);
  const recommendedMullvad = selectRecommendedMullvadExitNode(allExitNodes);
  const selectedExitNodeID = effectiveSelectedExitNodeID(state);
  const selectedExitNode = selectedExitNodeID
    ? allExitNodes.find((node) => node.id === selectedExitNodeID) ??
      (state.exitNode?.id === selectedExitNodeID ? state.exitNode : null)
    : null;

  // Recommended Mullvad exit node (hidden when searching)
  if (!exitNodeSearchQuery && recommendedMullvad) {
    const suggestSection = document.createElement("div");
    suggestSection.className = "exit-nodes-section exit-nodes-section--suggested";

    const suggestHeader = document.createElement("div");
    suggestHeader.className = "section-header";
    suggestHeader.textContent = "Recommended";
    suggestSection.appendChild(suggestHeader);

    const suggestLabel = formatLocationLabel(
      recommendedMullvad.location,
      machineName(recommendedMullvad),
    );
    const isSelected =
      selectedExitNodeID === recommendedMullvad.id ||
      sameExitNodeLocation(recommendedMullvad, selectedExitNode);
    const suggestRow = createExitNodeRow(
      suggestLabel,
      recommendedMullvad,
      isSelected,
      () => selectExitNode(recommendedMullvad.id),
      "Best available Mullvad VPN",
    );
    suggestSection.appendChild(suggestRow);
    container.appendChild(suggestSection);
  }

  // "None" option (hidden when searching)
  if (!exitNodeSearchQuery) {
    const noneRow = createExitNodeRow(
      "None (direct connection)",
      null,
      selectedExitNodeID == null,
      () => clearExitNode()
    );
    container.appendChild(noneRow);
  }

  // Group exit nodes into own/mullvad/shared
  const { own, mullvad, shared } = groupExitNodes(filtered);
  const hasAnyNodes = own.length > 0 || mullvad.length > 0 || shared.length > 0;

  if (!hasAnyNodes && exitNodeSearchQuery) {
    const noResults = document.createElement("div");
    noResults.className = "empty-state";
    const noResultsTitle = document.createElement("div");
    noResultsTitle.className = "empty-state-title";
    noResultsTitle.textContent = "No matching exit nodes";
    noResults.appendChild(noResultsTitle);
    container.appendChild(noResults);
    return;
  }

  if (!hasAnyNodes && !recommendedMullvad) {
    const emptyState = document.createElement("div");
    emptyState.className = "empty-state";

    const emptyTitle = document.createElement("div");
    emptyTitle.className = "empty-state-title";
    emptyTitle.textContent = "No exit nodes available";
    emptyState.appendChild(emptyTitle);

    const emptyText = document.createElement("div");
    emptyText.className = "empty-state-text";
    emptyText.textContent = "To use an exit node, enable it on a device in your tailnet via the admin console or run \"tailscale set --advertise-exit-node\" on the device.";
    emptyState.appendChild(emptyText);

    container.appendChild(emptyState);
    return;
  }

  // "My Devices" section
  if (own.length > 0) {
    renderFlatSection(container, "My Devices", own, state);
  }

  // "Mullvad VPN" section
  if (mullvad.length > 0) {
    // Auto-expand the country containing the active exit node on first render only
    if (!autoExpandDone && selectedExitNodeID) {
      autoExpandDone = true;
      const activeNode = allExitNodes.find((n) => n.id === selectedExitNodeID);
      if (
        activeNode &&
        isMullvadExitNodePeer(activeNode) &&
        activeNode.location?.countryCode
      ) {
        expandedCountries.add(activeNode.location.countryCode);
      }
    }
    renderMullvadSection(container, mullvad, state);
  }

  // "Shared" section
  if (shared.length > 0) {
    renderFlatSection(container, "Shared", shared, state);
  }
}

export function selectRecommendedMullvadExitNode(
  nodes: PeerInfo[],
  clientLocation: ApproxLocation | null = currentApproxLocation(),
): PeerInfo | null {
  const candidates = nodes.filter(
    (node) =>
      node.exitNodeOption &&
      isMullvadExitNodePeer(node) &&
      hasLocationLabel(node.location),
  );

  candidates.sort((a, b) => compareRecommendedMullvadExitNodes(a, b, clientLocation));
  return candidates[0] ?? null;
}

function renderFlatSection(
  parent: HTMLElement,
  label: string,
  nodes: PeerInfo[],
  state: TailscaleState
): void {
  const section = document.createElement("div");
  section.className = "exit-nodes-section";

  const sectionHeader = document.createElement("div");
  sectionHeader.className = "section-header";
  sectionHeader.textContent = label;
  section.appendChild(sectionHeader);
  const selectedExitNodeID = effectiveSelectedExitNodeID(state);

  for (const node of nodes) {
    const nodeLabel = formatLocationLabel(node.location, machineName(node));
    const isSelected = selectedExitNodeID === node.id;
    const row = createExitNodeRow(nodeLabel, node, isSelected, () =>
      selectExitNode(node.id)
    );
    section.appendChild(row);
  }

  parent.appendChild(section);
}

function renderMullvadSection(
  parent: HTMLElement,
  groups: MullvadCountryGroup[],
  state: TailscaleState
): void {
  const section = document.createElement("div");
  section.className = "exit-nodes-section exit-nodes-section--mullvad";

  const sectionHeader = document.createElement("div");
  sectionHeader.className = "section-header";
  sectionHeader.textContent = "Mullvad VPN";
  section.appendChild(sectionHeader);
  const selectedExitNodeID = effectiveSelectedExitNodeID(state);

  for (const country of groups) {
    const isExpanded = expandedCountries.has(country.countryCode);

    const countryContainer = document.createElement("div");
    countryContainer.className = "mullvad-country";

    // Country header row
    const countryRow = document.createElement("div");
    countryRow.className = "mullvad-country-row";
    countryRow.setAttribute("role", "button");
    countryRow.setAttribute("aria-expanded", String(isExpanded));
    countryRow.setAttribute("tabindex", "0");

    const flag = document.createElement("span");
    flag.className = "mullvad-country-flag";
    flag.textContent = countryCodeToEmoji(country.countryCode);

    const name = document.createElement("span");
    name.className = "mullvad-country-name";
    name.textContent = country.country;

    const count = document.createElement("span");
    count.className = "mullvad-country-count";
    const totalCities = country.cities.length;
    count.textContent = `${totalCities}`;

    const chevron = document.createElement("span");
    chevron.className =
      "mullvad-country-chevron" +
      (isExpanded ? " mullvad-country-chevron--expanded" : "");
    chevron.textContent = "\u203A";

    countryRow.appendChild(flag);
    countryRow.appendChild(name);
    countryRow.appendChild(count);
    countryRow.appendChild(chevron);

    // City list (shown when expanded)
    const cityList = document.createElement("div");
    cityList.className = "mullvad-city-list";
    cityList.style.display = isExpanded ? "block" : "none";

    for (const city of country.cities) {
      const bestNode = city.nodes.find((n) => n.online) ?? city.nodes[0];
      if (!bestNode) continue;
      const cityHasSelection = city.nodes.some(
        (n) => selectedExitNodeID === n.id
      );

      const row = createExitNodeRow(city.city, bestNode, cityHasSelection, () =>
        selectExitNode(bestNode.id)
      );
      row.classList.add("mullvad-city-row");
      cityList.appendChild(row);
    }

    // Toggle expand/collapse
    const toggle = () => {
      const nowExpanded = expandedCountries.has(country.countryCode);
      if (nowExpanded) {
        expandedCountries.delete(country.countryCode);
      } else {
        expandedCountries.add(country.countryCode);
      }
      cityList.style.display = nowExpanded ? "none" : "block";
      chevron.classList.toggle("mullvad-country-chevron--expanded");
      countryRow.setAttribute("aria-expanded", String(!nowExpanded));
    };

    countryRow.addEventListener("click", toggle);
    countryRow.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        toggle();
      }
    });

    countryContainer.appendChild(countryRow);
    countryContainer.appendChild(cityList);
    section.appendChild(countryContainer);
  }

  parent.appendChild(section);
}

function createExitNodeRow(
  label: string,
  node: PeerInfo | null,
  isSelected: boolean,
  onSelect: () => void,
  subLabelOverride?: string,
): HTMLElement {
  const row = document.createElement("div");
  row.className = "exit-node-row" + (isSelected ? " exit-node-row--selected" : "");
  row.setAttribute("role", "radio");
  row.setAttribute("aria-checked", String(isSelected));
  row.setAttribute("tabindex", "0");

  const radio = document.createElement("div");
  radio.className = "exit-node-radio" + (isSelected ? " exit-node-radio--selected" : "");
  row.appendChild(radio);

  const info = document.createElement("div");
  info.className = "exit-node-info";

  const nameEl = document.createElement("span");
  nameEl.className = "exit-node-name";
  nameEl.textContent = label;
  info.appendChild(nameEl);

  if (subLabelOverride) {
    const sub = document.createElement("span");
    sub.className = "exit-node-status";
    sub.textContent = subLabelOverride;
    info.appendChild(sub);
  } else if (node) {
    const status = document.createElement("span");
    status.className = "exit-node-status";
    const dot = document.createElement("span");
    dot.className = `status-dot status-dot--${node.online ? "online" : "offline"}`;
    status.appendChild(dot);
    status.appendChild(document.createTextNode(node.online ? " online" : " offline"));
    info.appendChild(status);
  }

  row.appendChild(info);

  if (node?.location?.countryCode) {
    const flagEl = document.createElement("span");
    flagEl.className = "exit-node-flag";
    flagEl.textContent = countryCodeToEmoji(node.location.countryCode);
    row.appendChild(flagEl);
  }

  const handleSelect = () => {
    if (!isSelected) {
      // Show loading spinner for immediate feedback
      const spinner = document.createElement("div");
      spinner.className = "spinner spinner-sm";
      row.appendChild(spinner);
      row.classList.add("exit-node-row--selected");
      radio.classList.add("exit-node-radio--selected");
      row.setAttribute("aria-checked", "true");
    }
    onSelect();
  };
  row.addEventListener("click", handleSelect);
  row.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      handleSelect();
    }
  });
  return row;
}

function selectExitNode(nodeID: string): void {
  sendMessage({ type: "set-exit-node", nodeID });
}

function clearExitNode(): void {
  sendMessage({ type: "clear-exit-node" });
}

function effectiveSelectedExitNodeID(state: TailscaleState): string | null {
  if (state.pendingExitNodeID !== null) {
    return state.pendingExitNodeID || null;
  }

  return state.exitNode?.id ?? state.prefs?.exitNodeID ?? null;
}

function sameExitNodeLocation(
  a: Pick<PeerInfo, "location">,
  b: Pick<PeerInfo, "location"> | null,
): boolean {
  if (!a.location || !b?.location) return false;

  const aCountry = (
    locationPart(a.location.countryCode) ?? locationPart(a.location.country)
  )?.toUpperCase();
  const bCountry = (
    locationPart(b.location.countryCode) ?? locationPart(b.location.country)
  )?.toUpperCase();
  if (!aCountry || !bCountry || aCountry !== bCountry) return false;

  const aCity = (
    locationPart(a.location.cityCode) ?? locationPart(a.location.city)
  )?.toLowerCase();
  const bCity = (
    locationPart(b.location.cityCode) ?? locationPart(b.location.city)
  )?.toLowerCase();

  return Boolean(aCity && bCity && aCity === bCity);
}

function groupExitNodes(nodes: PeerInfo[]): ExitNodeGrouping {
  const own: PeerInfo[] = [];
  const mullvadRaw: PeerInfo[] = [];
  const shared: PeerInfo[] = [];

  for (const node of nodes) {
    if (isMullvadExitNodePeer(node)) {
      if (node.location && hasLocationLabel(node.location)) {
        mullvadRaw.push(node);
      } else {
        // Mullvad node without location — show in shared as fallback
        shared.push(node);
      }
    } else if (node.tags.length > 0) {
      shared.push(node);
    } else {
      own.push(node);
    }
  }

  return { own, mullvad: groupMullvadByCountry(mullvadRaw), shared };
}

function groupMullvadByCountry(nodes: PeerInfo[]): MullvadCountryGroup[] {
  const countryMap = new Map<string, Map<string, PeerInfo[]>>();
  const countryNames = new Map<string, string>();
  const cityNames = new Map<string, string>();

  for (const node of nodes) {
    const loc = node.location;
    if (!loc) continue;
    const cc = locationPart(loc.countryCode) ?? locationPart(loc.country) ?? node.id;
    const cityKey =
      locationPart(loc.cityCode) ?? locationPart(loc.city) ?? machineName(node);

    countryNames.set(
      cc,
      locationPart(loc.country) ?? locationPart(loc.countryCode) ?? "Unknown",
    );
    cityNames.set(cityKey, locationPart(loc.city) ?? machineName(node));

    if (!countryMap.has(cc)) countryMap.set(cc, new Map());
    const cityMap = countryMap.get(cc)!;
    if (!cityMap.has(cityKey)) cityMap.set(cityKey, []);
    cityMap.get(cityKey)!.push(node);
  }

  const result: MullvadCountryGroup[] = [];
  for (const [cc, cityMap] of countryMap) {
    const cities: MullvadCityGroup[] = [];
    for (const [cityKey, cityNodes] of cityMap) {
      cities.push({
        city: cityNames.get(cityKey) || cityKey,
        cityCode: cityKey,
        nodes: cityNodes,
      });
    }
    cities.sort((a, b) => a.city.localeCompare(b.city));

    result.push({
      country: countryNames.get(cc) || cc,
      countryCode: cc,
      cities,
    });
  }

  result.sort((a, b) => a.country.localeCompare(b.country));
  return result;
}

function locationPart(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

function hasLocationLabel(location: PeerInfo["location"]): boolean {
  return Boolean(
    locationPart(location?.city) ||
    locationPart(location?.country) ||
    locationPart(location?.countryCode),
  );
}

function currentApproxLocation(): ApproxLocation | null {
  try {
    const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    return timeZone ? TIMEZONE_APPROX_LOCATIONS[timeZone] ?? null : null;
  } catch {
    return null;
  }
}

function compareRecommendedMullvadExitNodes(
  a: PeerInfo,
  b: PeerInfo,
  clientLocation: ApproxLocation | null,
): number {
  const online = Number(b.online) - Number(a.online);
  if (online !== 0) return online;

  if (clientLocation) {
    const sameCountry =
      Number(normalizedCountryCode(b.location) === clientLocation.countryCode) -
      Number(normalizedCountryCode(a.location) === clientLocation.countryCode);
    if (sameCountry !== 0) return sameCountry;

    const aDistance = distanceKm(clientLocation, a.location);
    const bDistance = distanceKm(clientLocation, b.location);
    if (aDistance != null && bDistance != null) {
      const distance = aDistance - bDistance;
      if (distance !== 0) return distance;
    } else if (aDistance != null || bDistance != null) {
      return aDistance != null ? -1 : 1;
    }
  }

  const priority = (b.location?.priority ?? 0) - (a.location?.priority ?? 0);
  if (priority !== 0) return priority;

  return formatLocationLabel(a.location, machineName(a)).localeCompare(
    formatLocationLabel(b.location, machineName(b)),
  );
}

function normalizedCountryCode(location: PeerInfo["location"]): string | undefined {
  return locationPart(location?.countryCode)?.toUpperCase();
}

function distanceKm(
  origin: ApproxLocation,
  destination: PeerInfo["location"],
): number | null {
  const destLat = destination?.latitude;
  const destLon = destination?.longitude;
  if (
    typeof destLat !== "number" ||
    typeof destLon !== "number" ||
    !Number.isFinite(destLat) ||
    !Number.isFinite(destLon)
  ) {
    return null;
  }

  const toRadians = (degrees: number) => (degrees * Math.PI) / 180;
  const earthRadiusKm = 6371;
  const dLat = toRadians(destLat - origin.latitude);
  const dLon = toRadians(destLon - origin.longitude);
  const lat1 = toRadians(origin.latitude);
  const lat2 = toRadians(destLat);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;

  return earthRadiusKm * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function countryCodeToEmoji(code: string): string {
  const upper = code.toUpperCase();
  if (upper.length !== 2) return "";
  const a = 0x1f1e6;
  return String.fromCodePoint(
    a + upper.charCodeAt(0) - 65,
    a + upper.charCodeAt(1) - 65
  );
}
