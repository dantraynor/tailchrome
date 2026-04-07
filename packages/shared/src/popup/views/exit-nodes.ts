import type { TailscaleState, PeerInfo } from "../../types";
import { addListKeyboardNav } from "../utils";
import { sendMessage } from "../popup";
import { iconArrowLeft } from "../icons";

const MULLVAD_TAG = "tag:mullvad-exit-node";

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

/** Persists search query within a single exit node sub-view session. */
let exitNodeSearchQuery = "";

// Persists expand/collapse state across sub-view re-renders.
const expandedCountries = new Set<string>();
let autoExpandDone = false;

function isMullvadNode(peer: PeerInfo): boolean {
  return peer.tags.includes(MULLVAD_TAG);
}

/**
 * Renders the exit node picker overlay.
 * Replaces the root content with a list of available exit nodes.
 */
export function renderExitNodes(
  root: HTMLElement,
  state: TailscaleState,
  onBack: () => void
): void {
  // Only reset the search query on initial open (not on state-driven re-renders)
  if (!root.querySelector(".exit-nodes-header")) {
    exitNodeSearchQuery = "";
  }
  root.textContent = "";
  const view = document.createElement("div");
  view.className = "view";

  // --- Header ---
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

  // --- Search ---
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

  // --- Exit node list container ---
  const listContainer = document.createElement("div");
  listContainer.className = "exit-nodes-list";
  renderExitNodeList(listContainer, state, allExitNodes);
  view.appendChild(listContainer);

  // --- Allow LAN access ---
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

  // Suggested exit node (hidden when searching)
  if (!exitNodeSearchQuery && state.exitNodeSuggestion) {
    const suggestSection = document.createElement("div");
    suggestSection.className = "exit-nodes-section exit-nodes-section--suggested";

    const suggestHeader = document.createElement("div");
    suggestHeader.className = "section-header";
    suggestHeader.textContent = "Suggested";
    suggestSection.appendChild(suggestHeader);

    const suggestion = state.exitNodeSuggestion;
    const suggestLabel = suggestion.location
      ? `${suggestion.location.city}, ${suggestion.location.country}`
      : suggestion.hostname;
    const isSelected =
      state.exitNode != null && state.exitNode.id === state.exitNodeSuggestion.id;
    const suggestRow = createExitNodeRow(suggestLabel, null, isSelected, () =>
      sendMessage({ type: "set-exit-node", nodeID: state.exitNodeSuggestion!.id })
    );
    suggestSection.appendChild(suggestRow);
    container.appendChild(suggestSection);
  }

  // "None" option (hidden when searching)
  if (!exitNodeSearchQuery) {
    const noneRow = createExitNodeRow(
      "None (direct connection)",
      null,
      state.exitNode == null,
      () => sendMessage({ type: "clear-exit-node" })
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

  if (!hasAnyNodes && !state.exitNodeSuggestion) {
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
    if (!autoExpandDone && state.exitNode) {
      autoExpandDone = true;
      const activeNode = allExitNodes.find((n) => n.id === state.exitNode!.id);
      if (activeNode && isMullvadNode(activeNode) && activeNode.location) {
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

  for (const node of nodes) {
    const nodeLabel = node.location
      ? `${node.location.city}, ${node.location.country}`
      : node.hostname;
    const isSelected = state.exitNode != null && state.exitNode.id === node.id;
    const row = createExitNodeRow(nodeLabel, node, isSelected, () =>
      sendMessage({ type: "set-exit-node", nodeID: node.id })
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
        (n) => state.exitNode != null && state.exitNode.id === n.id
      );

      const row = createExitNodeRow(city.city, bestNode, cityHasSelection, () =>
        sendMessage({ type: "set-exit-node", nodeID: bestNode.id })
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
  onSelect: () => void
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

  if (node) {
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

function groupExitNodes(nodes: PeerInfo[]): ExitNodeGrouping {
  const own: PeerInfo[] = [];
  const mullvadRaw: PeerInfo[] = [];
  const shared: PeerInfo[] = [];

  for (const node of nodes) {
    if (isMullvadNode(node)) {
      if (node.location) {
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
    const cc = loc.countryCode;
    const cityKey = loc.cityCode || loc.city;

    countryNames.set(cc, loc.country);
    cityNames.set(cityKey, loc.city);

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

function countryCodeToEmoji(code: string): string {
  const upper = code.toUpperCase();
  if (upper.length !== 2) return "";
  const a = 0x1f1e6;
  return String.fromCodePoint(
    a + upper.charCodeAt(0) - 65,
    a + upper.charCodeAt(1) - 65
  );
}
