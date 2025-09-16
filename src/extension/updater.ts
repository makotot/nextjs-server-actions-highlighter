import * as vscode from 'vscode';
import type { Decorations } from './decorator';
import type { ResolveFn } from '../analyzer/types';
import { computeHighlights } from '../analyzer/compute';

const SUPPORTED = new Set(['typescript', 'typescriptreact']);

/**
 * Build a function that updates decorations for the active editor.
 * - Definitions: highlight whole lines covering the Server Action body.
 * - Call sites: extract candidates → pre-filter (imports/locals) → resolve via LS → if it matches a Server Action, highlight the expression range (with 🚪).
 * - Merge duplicate ranges to avoid double drawing.
 */
export function buildUpdateEditor(getDecorations: () => Decorations, resolveFn: ResolveFn) {
  return async function updateEditor(editor?: vscode.TextEditor): Promise<void> {
    if (!editor) {return;}
    const { document } = editor;
    const { body, call, icon } = getDecorations();
    if (!SUPPORTED.has(document.languageId)) {
      editor.setDecorations(body, []);
      editor.setDecorations(call, []);
      editor.setDecorations(icon, []);
      return;
    }

    const text = document.getText();
    const { bodyRanges, iconRanges, callRanges } = await computeHighlights(
      text,
      document.fileName,
      document.uri.toString(),
      resolveFn,
    );
    editor.setDecorations(
      body,
      bodyRanges.map(r => new vscode.Range(document.positionAt(r.start), document.positionAt(r.end)))
    );
    editor.setDecorations(
      icon,
      iconRanges.map(r => new vscode.Range(document.positionAt(r.start), document.positionAt(r.end)))
    );
    editor.setDecorations(
      call,
      callRanges.map(r => new vscode.Range(document.positionAt(r.start), document.positionAt(r.end)))
    );
  };
}
