/** Highlight computation logic independent of VS Code. */
import { scanServerActions } from '../core/definitions';
import { scanCallSiteCandidates, collectImportedNames, collectLocalCallableNames, collectNamespaceImportNames } from '../core/calls';
import type { ResolveFn, ComputeOptions } from './types';

export type OffsetRange = { start: number; end: number };

/**
 * Given text and file name, compute offset ranges for definition and call-site highlights.
 * - Extraction: use core definitions/calls logic (AST-based).
 * - Filter: consider only imported or locally declared callables.
 * - Matching: keep only those that resolve to a Server Action via resolveFn (LSP-compatible).
 */
export async function computeHighlights(
  text: string,
  fileName: string,
  documentUri: string,
  resolveFn: ResolveFn,
  options?: ComputeOptions,
): Promise<{ bodyRanges: OffsetRange[]; iconRanges: OffsetRange[]; callRanges: OffsetRange[] }> {
  const spans = scanServerActions(text, fileName);
  const bodyRanges: OffsetRange[] = [];
  const iconRanges: OffsetRange[] = [];
  const localActionNames = new Set<string>();
  for (const s of spans) {
    const startLine = lineStartOffset(text, s.bodyStart);
    const endLine = lineEndOffset(text, s.bodyEnd);
    bodyRanges.push({ start: startLine, end: endLine });
    if (text[s.bodyStart] === '{') {
      const endOfBraceLine = lineEndOffset(text, s.bodyStart);
      iconRanges.push({ start: endOfBraceLine, end: endOfBraceLine });
    }
    if (s.name && s.name !== '(inline)' && s.name !== 'default') {
      localActionNames.add(s.name);
    }
  }

  const calls = scanCallSiteCandidates(text, fileName);
  const imported = collectImportedNames(text, fileName);
  const locals = collectLocalCallableNames(text, fileName);
  const nsImports = collectNamespaceImportNames(text, fileName);
  const callRanges: OffsetRange[] = [];
  const seen = new Set<string>();

  const add = (r: OffsetRange) => {
    const key = `${r.start}:${r.end}`;
    if (!seen.has(key)) { seen.add(key); callRanges.push(r); }
  };

  // Order call candidates: visible range first (if provided)
  const vr = options?.visibleRange;
  const inView: typeof calls = [];
  const outView: typeof calls = [];
  if (vr) {
    for (const c of calls) {
      if (c.start <= vr.end && c.end >= vr.start) { inView.push(c); } else { outView.push(c); }
    }
  }
  const orderedCalls = vr ? [...inView, ...outView] : calls;

  // Safety bounds applied only when caller passed options
  const { maxConcurrent = 6, perPassBudgetMs = 2000, resolveTimeoutMs = 1500, maxResolutions = 30 } = options?.bounds ?? {};
  const useBounds = !!options;

  const startedAt = Date.now();
  let resolutions = 0;
  let inFlight = 0;
  const queue: Promise<void>[] = [];

  const runWithTimeout = async (uri: string, off: number): Promise<boolean> => {
    if (!useBounds) { return resolveFn(uri, off); }
    return await Promise.race([
      resolveFn(uri, off),
      new Promise<boolean>(res => setTimeout(() => res(false), resolveTimeoutMs)),
    ]);
  };

  // Admit a task into a small concurrency pool.
  // - Limits concurrent resolve operations to avoid flooding the language server.
  // - When bounds are disabled, runs the task inline for simplicity.
  const schedule = async (task: () => Promise<void>) => {
    // Fast path: no bounds configured → execute immediately.
    if (!useBounds) { await task(); return; }

    // Backpressure: if the pool is full, wait until any in-flight task finishes.
    while (inFlight >= maxConcurrent) {
      // Wait for whichever promise settles first to free a slot.
      // eslint-disable-next-line no-await-in-loop
      await Promise.race(queue);
    }

    // Wrap the task to keep pool accounting correct.
    const p = (async () => {
      try {
        inFlight++; // Occupy a slot.
        await task();
      } finally {
        inFlight--; // Free the slot even if the task throws.
      }
    })();

    // Track the promise so Promise.race can observe progress.
    queue.push(p);

    // Remove the settled promise from the queue to avoid unbounded growth.
    p.finally(() => {
      const idx = queue.indexOf(p);
      if (idx >= 0) { queue.splice(idx, 1); }
    });
  };

  for (const orderedCall of orderedCalls) {
    const site: OffsetRange = { start: orderedCall.start, end: orderedCall.end };
    if (orderedCall.kind === 'jsxAction' || orderedCall.kind === 'jsxFormAction') {
      add(site);
      continue;
    }
    // Intra-file short-circuit: local server actions don't need LS
    if (orderedCall.calleeName && localActionNames.has(orderedCall.calleeName)) {
      add(site);
      continue;
    }
    if (orderedCall.calleeName && !imported.has(orderedCall.calleeName) && !locals.has(orderedCall.calleeName)) {
      // Allow property access off a namespace import: ns.fn()
      if (!orderedCall.qualifierName || !nsImports.has(orderedCall.qualifierName)) {
        continue;
      }
    }
    const inside = orderedCall.calleeName ? (orderedCall.start + Math.max(1, Math.floor(orderedCall.calleeName.length / 2))) : orderedCall.start;
    // Pre-check bounds before scheduling to avoid enqueuing no-op tasks
    if (useBounds && (resolutions >= maxResolutions || Date.now() - startedAt > perPassBudgetMs)) {
      break;
    }
    const resolveCallCandidate = async () => {
      const ok = await runWithTimeout(documentUri, inside);
      if (ok) { add(site); }
      resolutions++;
    };
    // eslint-disable-next-line no-await-in-loop
    await schedule(resolveCallCandidate);
    if (useBounds && (resolutions >= maxResolutions || Date.now() - startedAt > perPassBudgetMs)) {
      break;
    }
  }
  // Drain remaining scheduled tasks
  // eslint-disable-next-line no-await-in-loop
  for (const p of queue) { await p; }

  return { bodyRanges, iconRanges, callRanges };
}

function lineStartOffset(text: string, at: number): number {
  let i = at;
  while (i > 0 && text[i - 1] !== '\n') {i--;}
  return i;
}
function lineEndOffset(text: string, at: number): number {
  const idx = text.indexOf('\n', at);
  return idx === -1 ? text.length : idx;
}
