/** Highlight computation logic independent of VS Code. */
import { scanServerActions } from '../core/definitions';
import { scanCallSiteCandidates, collectImportedNames, collectLocalCallableNames, collectNamespaceImportNames } from '../core/calls';
import type { ResolveFn } from './types';

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
): Promise<{ bodyRanges: OffsetRange[]; iconRanges: OffsetRange[]; callRanges: OffsetRange[] }> {
  const spans = scanServerActions(text, fileName);
  const bodyRanges: OffsetRange[] = [];
  const iconRanges: OffsetRange[] = [];
  for (const s of spans) {
    const startLine = lineStartOffset(text, s.bodyStart);
    const endLine = lineEndOffset(text, s.bodyEnd);
    bodyRanges.push({ start: startLine, end: endLine });
    if (text[s.bodyStart] === '{') {
      const endOfBraceLine = lineEndOffset(text, s.bodyStart);
      iconRanges.push({ start: endOfBraceLine, end: endOfBraceLine });
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

  for (const c of calls) {
    const site: OffsetRange = { start: c.start, end: c.end };
    if (c.kind === 'jsxAction' || c.kind === 'jsxFormAction') {
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
    const ok = await resolveFn(documentUri, inside);
    if (!ok) {continue;}
    add(site);
  }

  return { bodyRanges, iconRanges, callRanges };
}
