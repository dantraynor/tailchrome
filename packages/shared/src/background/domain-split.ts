import type { DomainSplitConfig, DomainSplitMode } from "../types";
import { sanitizeDomain } from "./proxy-utils";

const STORAGE_KEY = "domainSplitConfig";
const VALID_MODES: ReadonlySet<DomainSplitMode> = new Set(["bypass", "only"]);

export const DEFAULT_DOMAIN_SPLIT: DomainSplitConfig = {
  mode: "bypass",
  domains: [],
};

export function defaultDomainSplit(): DomainSplitConfig {
  return { mode: DEFAULT_DOMAIN_SPLIT.mode, domains: [] };
}

export function normalizeDomainSplit(input: unknown): DomainSplitConfig {
  if (!input || typeof input !== "object") return defaultDomainSplit();
  const raw = input as { mode?: unknown; domains?: unknown };
  const mode: DomainSplitMode = VALID_MODES.has(raw.mode as DomainSplitMode)
    ? (raw.mode as DomainSplitMode)
    : DEFAULT_DOMAIN_SPLIT.mode;

  const seen = new Set<string>();
  const domains: string[] = [];
  if (Array.isArray(raw.domains)) {
    for (const entry of raw.domains) {
      if (typeof entry !== "string") continue;
      const cleaned = sanitizeDomain(entry);
      if (!cleaned || seen.has(cleaned)) continue;
      seen.add(cleaned);
      domains.push(cleaned);
    }
  }
  return { mode, domains };
}

export async function readDomainSplit(): Promise<DomainSplitConfig> {
  try {
    const result = await chrome.storage.local.get(STORAGE_KEY);
    return normalizeDomainSplit(result[STORAGE_KEY]);
  } catch {
    return defaultDomainSplit();
  }
}

export async function writeDomainSplit(config: DomainSplitConfig): Promise<void> {
  const normalized = normalizeDomainSplit(config);
  await chrome.storage.local.set({ [STORAGE_KEY]: normalized });
}

export const DOMAIN_SPLIT_STORAGE_KEY = STORAGE_KEY;
