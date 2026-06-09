/**
 * Guard: nothing reachable from the workflow bundle may touch `process` (or other
 * Node-only globals) at MODULE SCOPE.
 *
 * Temporal runs workflow code in a deterministic V8 sandbox with no `process`
 * global. `fsmProcess.workflow.ts` imports timeout constants from
 * `shared/constants.ts`, which pulls the WHOLE module into the bundle — so an
 * unguarded module-level `process.env` there throws `ReferenceError: process is
 * not defined` at bundle init, the workflow never instantiates, and FSM runs
 * stick on INIT with zero step output (this happened live on edge-lucas-fsm).
 *
 * `bundleWorkflowCode` does NOT catch this (it's a runtime-sandbox error, not a
 * bundle error), and evaluating the bundle in a bare VM false-positives on the
 * webpack runtime. So we statically walk the workflow import graph and fail if
 * any reachable module references `process` outside a function body and outside
 * a `typeof process !== 'undefined'` guard. References inside function bodies are
 * fine — they only run if called, and the workflow never calls them.
 */
import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const WORKFLOWS_DIR = dirname(fileURLToPath(import.meta.url));

/** Entry points whose transitive (runtime) imports form the workflow bundle. */
function workflowEntryPoints(): string[] {
  const idx = resolve(WORKFLOWS_DIR, 'index.ts');
  const entries = existsSync(idx) ? [idx] : [];
  // Defensive: include every *.workflow.ts even if index.ts misses one.
  for (const f of ts.sys.readDirectory(WORKFLOWS_DIR, ['.ts'])) {
    if (f.endsWith('.workflow.ts')) entries.push(resolve(f));
  }
  return [...new Set(entries)];
}

const isFunctionLike = (n: ts.Node): boolean =>
  ts.isFunctionDeclaration(n) || ts.isFunctionExpression(n) || ts.isArrowFunction(n) ||
  ts.isMethodDeclaration(n) || ts.isConstructorDeclaration(n) ||
  ts.isGetAccessorDeclaration(n) || ts.isSetAccessorDeclaration(n);

/** True if a `typeof process` guard wraps this node (the safe codebase idiom). */
function isGuarded(node: ts.Node, src: ts.SourceFile): boolean {
  for (let p: ts.Node | undefined = node.parent; p; p = p.parent) {
    if (ts.isConditionalExpression(p) && /typeof\s+process/.test(p.condition.getText(src))) return true;
    if (ts.isBinaryExpression(p) &&
        (p.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken ||
         p.operatorToken.kind === ts.SyntaxKind.BarBarToken) &&
        /typeof\s+process/.test(p.left.getText(src))) return true;
  }
  return false;
}

/** Resolve a relative import specifier (which uses .js) to its .ts source in src/. */
function resolveLocalImport(fromFile: string, spec: string): string | null {
  if (!spec.startsWith('.')) return null; // bare/node_modules import — not bundled from our src
  const base = resolve(dirname(fromFile), spec);
  for (const cand of [base.replace(/\.js$/, '.ts'), base + '.ts', resolve(base, 'index.ts')]) {
    if (existsSync(cand)) return cand;
  }
  return null;
}

/** Files reachable via runtime (non-`import type`) imports from the entries. */
function reachableModules(entries: string[]): string[] {
  const seen = new Set<string>();
  const stack = [...entries];
  while (stack.length) {
    const file = stack.pop()!;
    if (seen.has(file) || !existsSync(file)) continue;
    seen.add(file);
    const src = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
    src.forEachChild((node) => {
      if (ts.isImportDeclaration(node) &&
          !node.importClause?.isTypeOnly && // `import type {…}` is fully erased
          ts.isStringLiteral(node.moduleSpecifier)) {
        const target = resolveLocalImport(file, node.moduleSpecifier.text);
        if (target) stack.push(target);
      }
    });
  }
  return [...seen];
}

function moduleScopeProcessRefs(file: string): string[] {
  const src = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
  const hits: string[] = [];
  const visit = (node: ts.Node, fnDepth: number) => {
    if (isFunctionLike(node)) { node.forEachChild((c) => visit(c, fnDepth + 1)); return; }
    if (fnDepth === 0 &&
        ts.isPropertyAccessExpression(node) &&
        ts.isIdentifier(node.expression) && node.expression.text === 'process' &&
        !isGuarded(node, src)) {
      const { line } = src.getLineAndCharacterOfPosition(node.getStart(src));
      hits.push(`${file}:${line + 1}  ${node.parent.getText(src).replace(/\s+/g, ' ').slice(0, 90)}`);
    }
    node.forEachChild((c) => visit(c, fnDepth));
  };
  visit(src, 0);
  return hits;
}

describe('workflow sandbox safety', () => {
  it('no workflow-bundled module references `process` at module scope', () => {
    const modules = reachableModules(workflowEntryPoints());
    expect(modules.length).toBeGreaterThan(0); // sanity: we actually walked the graph
    const violations = modules.flatMap(moduleScopeProcessRefs);
    expect(
      violations,
      `Module-scope \`process\` in workflow-bundled code breaks the Temporal sandbox ` +
      `(ReferenceError: process is not defined → workflow stuck on INIT). ` +
      `Guard with \`typeof process !== 'undefined' ? (process.env.X || d) : d\`:\n  ` +
      violations.join('\n  '),
    ).toEqual([]);
  });
});
