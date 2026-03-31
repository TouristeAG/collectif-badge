import type { VCardSettings } from "./badgeIllustratorVcardTypes";

export type BadgePersonType = "benevole" | "salarie" | "invite" | "externe" | "autre";

export const BADGE_ILLUSTRATOR_STORAGE_KEY = "collectif-badge-illustrator-defaults-v1";

export const FACTORY_ROLE_EDGE_CQW: Record<BadgePersonType, number> = {
  benevole: 0,
  salarie: 0,
  invite: 0,
  externe: 0,
  autre: 0,
};

/** Shipped defaults (before any user-saved defaults). */
export const ILLUSTRATOR_FACTORY_DEFAULTS = {
  cardBackgroundColor: "#1b1b1b",
  logoZoom: 132,
  logoOffsetX: -280,
  logoOffsetY: 126,
  logoOffsetZ: 0,
  showQrCode: false,
  showNfcMark: false,
  qrTopPct: 5.5,
  qrRightPct: 4,
  qrWidthPct: 20,
  qrOffsetX: 0,
  qrOffsetY: 0,
  qrOffsetZ: 0,
  qrZoom: 100,
  nfcBottomPct: 5.8,
  nfcRightPct: 5.2,
  nfcWidthPct: 12,
  nfcOffsetX: 0,
  nfcOffsetY: 0,
  nfcOffsetZ: 0,
  nfcZoom: 100,
  personType: "benevole" as BadgePersonType,
  customRoleLabel: "",
  accentColor: "#ffd699",
  secondaryColor: "#ffffff",
  photoFrameShape: "circle" as "circle" | "rounded",
  photoZoom: 100,
  photoOffsetX: 0,
  photoOffsetY: 0,
  photoRotation: 0,
  photoGrayscale: false,
  photoInvert: false,
  showBackQr: true,
  roleSizeAdjust: 100,
  roleEdgeAdjustCqwByType: { ...FACTORY_ROLE_EDGE_CQW },
};

export type IllustratorPersistedSnapshot = typeof ILLUSTRATOR_FACTORY_DEFAULTS & {
  vCardSettings?: VCardSettings;
};

let defaultsCache: IllustratorPersistedSnapshot | null = null;

function mergeRoleEdge(
  base: Record<BadgePersonType, number>,
  patch?: Partial<Record<BadgePersonType, number>>
): Record<BadgePersonType, number> {
  return { ...base, ...patch };
}

export function deepMergeIllustratorSnapshot(
  base: IllustratorPersistedSnapshot,
  patch: Partial<IllustratorPersistedSnapshot>
): IllustratorPersistedSnapshot {
  const out = { ...base, ...patch } as IllustratorPersistedSnapshot;
  if (patch.roleEdgeAdjustCqwByType) {
    out.roleEdgeAdjustCqwByType = mergeRoleEdge(base.roleEdgeAdjustCqwByType, patch.roleEdgeAdjustCqwByType);
  }
  if (patch.vCardSettings !== undefined) {
    out.vCardSettings = patch.vCardSettings;
  }
  return out;
}

export function loadBadgeIllustratorDefaults(): IllustratorPersistedSnapshot {
  try {
    const raw = localStorage.getItem(BADGE_ILLUSTRATOR_STORAGE_KEY);
    if (!raw) {
      return {
        ...ILLUSTRATOR_FACTORY_DEFAULTS,
        roleEdgeAdjustCqwByType: { ...FACTORY_ROLE_EDGE_CQW },
      };
    }
    const parsed = JSON.parse(raw) as Partial<IllustratorPersistedSnapshot>;
    const base: IllustratorPersistedSnapshot = {
      ...ILLUSTRATOR_FACTORY_DEFAULTS,
      ...parsed,
      roleEdgeAdjustCqwByType: mergeRoleEdge(FACTORY_ROLE_EDGE_CQW, parsed.roleEdgeAdjustCqwByType),
    };
    return base;
  } catch {
    return {
      ...ILLUSTRATOR_FACTORY_DEFAULTS,
      roleEdgeAdjustCqwByType: { ...FACTORY_ROLE_EDGE_CQW },
    };
  }
}

export function readIllustratorDefaultsCached(): IllustratorPersistedSnapshot {
  if (!defaultsCache) {
    defaultsCache = loadBadgeIllustratorDefaults();
  }
  return defaultsCache;
}

export function persistIllustratorPartial(partial: Partial<IllustratorPersistedSnapshot>): IllustratorPersistedSnapshot {
  const current = readIllustratorDefaultsCached();
  const next = deepMergeIllustratorSnapshot(current, partial);
  defaultsCache = next;
  try {
    localStorage.setItem(BADGE_ILLUSTRATOR_STORAGE_KEY, JSON.stringify(next));
  } catch {
    // ignore quota / private mode
  }
  return next;
}

export function resetIllustratorDefaultsStorageToFactory(): void {
  try {
    localStorage.removeItem(BADGE_ILLUSTRATOR_STORAGE_KEY);
  } catch {
    /* empty */
  }
  defaultsCache = {
    ...ILLUSTRATOR_FACTORY_DEFAULTS,
    roleEdgeAdjustCqwByType: { ...FACTORY_ROLE_EDGE_CQW },
  };
}
