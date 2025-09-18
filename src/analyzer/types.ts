export type ResolveFn = (uri: string, offset: number) => Promise<boolean>;

export type ComputeOptions = {
  // Resolve only within this visible range first, then optionally a few outside.
  visibleRange?: { start: number; end: number };
  // Internal safety bounds (applied if provided by caller). If omitted, behaves like legacy (no limits).
  bounds?: {
    maxConcurrent?: number; // default 6
    perPassBudgetMs?: number; // default 2000
    resolveTimeoutMs?: number; // default 1500
    maxResolutions?: number; // default 30
  };
};
