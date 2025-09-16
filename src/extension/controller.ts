import * as vscode from 'vscode';
import { createDecorations, disposeDecorations, type Decorations } from './decorator';
import { buildUpdateEditor } from './updater';
import { makeVsCodeResolveFn } from './resolver';

/**
 * Register highlighting and wire the decoration lifecycle and events.
 * - Reacts to initial render, active editor changes, text edits, document open, theme changes, and configuration changes.
 * - Recreates decorations on theme/config changes to reflect updates immediately.
 */
export function registerHighlighter(context: vscode.ExtensionContext) {
  let decorations: Decorations = createDecorations();
  context.subscriptions.push(decorations.body, decorations.call, decorations.icon);

  const getDecorations = () => decorations;
  const resolveFn = makeVsCodeResolveFn();
  const updateEditor = buildUpdateEditor(getDecorations, resolveFn);

  const doUpdateActive = () => { void updateEditor(vscode.window.activeTextEditor); };

  // Initial render
  doUpdateActive();

  // Wire events
  context.subscriptions.push(
    vscode.window.onDidChangeActiveTextEditor(() => doUpdateActive()),
    vscode.workspace.onDidChangeTextDocument(e => {
      const active = vscode.window.activeTextEditor;
      if (active && e.document === active.document) {doUpdateActive();}
    }),
    vscode.workspace.onDidOpenTextDocument(doc => {
      const active = vscode.window.activeTextEditor;
      if (active && doc === active.document) {doUpdateActive();}
    }),
    vscode.window.onDidChangeActiveColorTheme(() => {
      disposeDecorations(decorations);
      decorations = createDecorations();
      context.subscriptions.push(decorations.body, decorations.call, decorations.icon);
      doUpdateActive();
    }),
    vscode.workspace.onDidChangeConfiguration(e => {
      if (
        e.affectsConfiguration('nextjs-server-actions-highlighter.highlight.definition') ||
        e.affectsConfiguration('nextjs-server-actions-highlighter.highlight.call')
      ) {
        disposeDecorations(decorations);
        decorations = createDecorations();
        context.subscriptions.push(decorations.body, decorations.call, decorations.icon);
        doUpdateActive();
      }
    })
  );
}
