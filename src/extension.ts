import * as vscode from 'vscode';
import { registerHighlighter } from './extension/controller';

export function activate(context: vscode.ExtensionContext) {
  console.log('nextjs-server-actions-highlighter activated');
  registerHighlighter(context);
}

export function deactivate() {}
