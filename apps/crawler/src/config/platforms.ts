import type { PlatformScraper } from "../platforms/types.ts";

export type PlatformDefinition = {
  code: string;
  name: string;
  load: () => Promise<PlatformScraper>;
};

/**
 * 平台注册表。
 *
 * 迁移阶段只注册已经迁完的平台；daily 的 --platforms 只能选这里存在的 code，
 * 避免把还没迁的平台误当成可用平台。
 */
export const PLATFORM_DEFINITIONS: Record<string, PlatformDefinition> = {
  fake: {
    code: "fake",
    name: "Fake",
    load: async () => (await import("../platforms/fake/index.ts")).createFakeScraper(),
  },
  youtube: {
    code: "youtube",
    name: "YouTube",
    load: async () => (await import("../platforms/youtube/scraper.ts")).createYouTubeScraper(),
  },
  x: {
    code: "x",
    name: "X",
    load: async () => (await import("../platforms/x/scraper.ts")).createXScraper(),
  },
  instagram: {
    code: "instagram",
    name: "Instagram",
    load: async () => (await import("../platforms/instagram/scraper.ts")).createInstagramScraper(),
  },
  facebook: {
    code: "facebook",
    name: "Facebook",
    load: async () => (await import("../platforms/facebook/scraper.ts")).createFacebookScraper(),
  },
  tiktok: {
    code: "tiktok",
    name: "TikTok",
    load: async () => (await import("../platforms/tiktok/scraper.ts")).createTikTokScraper(),
  },
  linkedin: {
    code: "linkedin",
    name: "LinkedIn",
    load: async () => (await import("../platforms/linkedin/scraper.ts")).createLinkedInScraper(),
  },
};

export function getPlatformDefinition(code: string): PlatformDefinition {
  const definition = PLATFORM_DEFINITIONS[code];
  if (!definition) {
    throw new Error(`未知平台：${code}。已注册：${Object.keys(PLATFORM_DEFINITIONS).join(", ")}`);
  }
  return definition;
}

export function registeredPlatformCodes(): string[] {
  return Object.keys(PLATFORM_DEFINITIONS);
}
