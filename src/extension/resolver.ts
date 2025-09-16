import * as vscode from 'vscode';
import { scanServerActions } from '../core/definitions';
import type { ResolveFn } from '../analyzer/types';

/**
 * Create a ResolveFn backed by VS Code's TypeScript Language Service.
 * Keeps the VS Code dependency isolated here; upper layers (highlight/updater) receive it via DI.
 */
export function makeVsCodeResolveFn(): ResolveFn {
  return async (uri: string, offset: number): Promise<boolean> => {
    type QueueItem = { uri: string; offset: number };
    const visited = new Set<string>();
    const queue: QueueItem[] = [{ uri, offset }];
    let hops = 0;
    while (queue.length && hops < 3) {
      hops++;
      const { uri: curUri, offset: curOffset } = queue.shift()!;
      const key = `${curUri}@${curOffset}`;
      if (visited.has(key)) { continue; }
      visited.add(key);

      const doc = await vscode.workspace.openTextDocument(vscode.Uri.parse(curUri));
      const position = doc.positionAt(curOffset);

      const defs = await vscode.commands.executeCommand<vscode.Location[] | undefined>('vscode.executeDefinitionProvider', doc.uri, position);
      const tdefs = await vscode.commands.executeCommand<vscode.Location[] | undefined>('vscode.executeTypeDefinitionProvider', doc.uri, position);
      const impls = await vscode.commands.executeCommand<vscode.Location[] | undefined>('vscode.executeImplementationProvider', doc.uri, position);
      const all: vscode.Location[] = [];
      if (defs?.length) {all.push(...defs);}
      if (tdefs?.length) {all.push(...tdefs);}
      if (impls?.length) {all.push(...impls);}
      if (!all.length) {continue;}

      for (const loc of all) {
        try {
          const targetDoc = await vscode.workspace.openTextDocument(loc.uri);
          const targetText = targetDoc.getText();
          const actions = scanServerActions(targetText, targetDoc.fileName);
          const defOffset = targetDoc.offsetAt(loc.range.start);
          for (const a of actions) {
            const inName = a.nameStart !== undefined && a.nameEnd !== undefined && defOffset >= a.nameStart && defOffset <= a.nameEnd;
            const inBody = defOffset >= a.bodyStart && defOffset <= a.bodyEnd;
            if (inName || inBody) {return true;}
          }
          queue.push({ uri: loc.uri.toString(), offset: defOffset });
        } catch {
          // ignore
        }
      }
    }
    return false;
  };
}
