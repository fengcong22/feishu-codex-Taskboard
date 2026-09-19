import type { FeishuPackageSummary } from "./types";

export function packageDisplayName(value: Pick<FeishuPackageSummary, "name" | "identity">): string {
  return value.identity?.displayName || value.name;
}
