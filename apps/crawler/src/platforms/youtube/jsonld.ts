export function parseJsonLdBlocks(rawBlocks: string[]): any[] {
  const out: any[] = [];
  for (const raw of rawBlocks || []) {
    if (!String(raw).trim()) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(String(raw));
    } catch {
      continue;
    }
    if (Array.isArray(parsed)) out.push(...parsed);
    else out.push(parsed);
  }
  return out.filter((b) => b && typeof b === "object" && !Array.isArray(b));
}

export function extractVideoUploadDate(rawBlocks: string[]): string {
  const video = parseJsonLdBlocks(rawBlocks).find((b) => b["@type"] === "VideoObject");
  return video ? String(video.uploadDate || "") : "";
}

export function extractVideoDescription(rawBlocks: string[]): string {
  const blocks = parseJsonLdBlocks(rawBlocks);
  for (const block of blocks) {
    if (block["@type"] !== "VideoObject") continue;
    const description = block.description;
    if (typeof description === "string" && description.trim()) return description;
  }
  return "";
}

export function applyVideoUploadDate(metrics: Record<string, any>, uploadDate: string): Record<string, any> {
  if (!uploadDate) return { ...metrics };
  return {
    ...metrics,
    publishDate: metrics.publishDate || uploadDate.slice(0, 10),
    uploadDate: metrics.uploadDate || uploadDate,
  };
}
