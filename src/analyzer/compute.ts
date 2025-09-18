/** Highlight computation logic independent of VS Code. */
import { scanServerActions } from '../core/definitions';
import { scanCallSiteCandidates, collectImportedNames, collectLocalCallableNames, collectNamespaceImportNames } from '../core/calls';
import type { ResolveFn, ComputeOptions } from './types';

export type OffsetRange = { start: number; end: number };

function lineStartOffset(text: string, at: number): number {
  let i = at;
  while (i > 0 && text[i - 1] !== '\n') {i--;}
  return i;
}
function lineEndOffset(text: string, at: number): number {
  const idx = text.indexOf('\n', at);
  return idx === -1 ? text.length : idx;
}

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
  const bounds = options?.bounds;
  const maxConcurrent = bounds?.maxConcurrent ?? 6;
  const perPassBudgetMs = bounds?.perPassBudgetMs ?? 2000;
  const resolveTimeoutMs = bounds?.resolveTimeoutMs ?? 1500;
  const maxResolutions = bounds?.maxResolutions ?? 30;
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

  const schedule = async (task: () => Promise<void>) => {
    if (!useBounds) { await task(); return; }
    while (inFlight >= maxConcurrent) { // naive throttle
      // eslint-disable-next-line no-await-in-loop
      await Promise.race(queue);
    }
    const p = (async () => { try { inFlight++; await task(); } finally { inFlight--; } })();
    queue.push(p);
    p.finally(() => {
      const idx = queue.indexOf(p);
      if (idx >= 0) { queue.splice(idx, 1); }
    });
  };

  for (const c of orderedCalls) {
    const site: OffsetRange = { start: c.start, end: c.end };
    if (c.kind === 'jsxAction' || c.kind === 'jsxFormAction') {
      add(site);
      continue;
    }
    // Intra-file short-circuit: local server actions don't need LS
    if (c.calleeName && localActionNames.has(c.calleeName)) {
      add(site);
      continue;
    }
    if (c.calleeName && !imported.has(c.calleeName) && !locals.has(c.calleeName)) {
      // Allow property access off a namespace import: ns.fn()
      if (!c.qualifierName || !nsImports.has(c.qualifierName)) {
        continue;
      }
    }
    const inside = c.calleeName ? (c.start + Math.max(1, Math.floor(c.calleeName.length / 2))) : c.start;
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
