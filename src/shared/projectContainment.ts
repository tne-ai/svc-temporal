/**
 * Project containment — decides whether a path reaches into ANOTHER of the same
 * user's projects. Mirror of orion/backend/src/lib/projectContainment.ts (the
 * two repos can't share code); keep them in sync.
 *
 * Isolation model: a user has one workspace with many sibling project dirs. A
 * job scoped to project A must not read/write inside project B. Everything else
 * (repos, dependencies, .claude, plugins) is allowed. So this is a DENY-list of
 * the user's OTHER project directories, done correctly: every path form
 * (relative, `..`, absolute, symlink) is resolved to a real absolute path before
 * the check, matches are separator-safe, and the current project always wins.
 */
import { realpathSync } from 'fs';
import path from 'path';

/** Resolve a (possibly relative/`..`/symlinked) target to an absolute real path anchored at `cwd`. */
export function resolveRealPath(cwd: string, target: string): string {
  const abs = path.isAbsolute(target) ? target : path.resolve(cwd, target);
  const normalized = path.normalize(abs);
  let existing = normalized;
  const tail: string[] = [];
  for (let i = 0; i < 4096; i++) {
    try {
      const real = realpathSync(existing);
      return tail.length ? path.join(real, ...tail.reverse()) : real;
    } catch {
      const parent = path.dirname(existing);
      if (parent === existing) break;
      tail.push(path.basename(existing));
      existing = parent;
    }
  }
  return normalized;
}

/** True if `child` is `parent` itself or lives underneath it (separator-safe). */
export function isWithin(child: string, parent: string): boolean {
  if (!parent) return false;
  const c = path.normalize(child);
  const p = path.normalize(parent);
  return c === p || c.startsWith(p.endsWith(path.sep) ? p : p + path.sep);
}

/**
 * `resolvedPath` (already absolute+real) lands in a DIFFERENT project of the
 * same user → block. The current project always wins (a path inside it is
 * allowed even if it is nested under one of `otherProjectDirs`).
 */
export function isCrossProjectAccess(
  resolvedPath: string,
  currentProjectDir: string,
  otherProjectDirs: string[],
): boolean {
  if (isWithin(resolvedPath, currentProjectDir)) return false;
  for (const other of otherProjectDirs) {
    if (!other) continue;
    if (isWithin(resolvedPath, other)) return true;
  }
  return false;
}

/**
 * Build absolute, realpath'd OTHER-project dirs (+ the current project dir) from
 * the user's project working-dirs. An empty current working-dir yields an empty
 * `currentProjectDir` sentinel (no project shadows the deny-list, so an unscoped
 * job cannot silently enter any project).
 */
export function otherProjectDirsAbs(
  workspaceRoot: string,
  currentWorkingDir: string,
  allWorkingDirs: string[],
): { currentProjectDir: string; otherProjectDirs: string[] } {
  const clean = (wd: string) => (wd || '').replace(/^[/\\]+|[/\\]+$/g, '');
  const toAbs = (wd: string) => resolveRealPath(workspaceRoot, clean(wd));
  const curClean = clean(currentWorkingDir);
  const currentProjectDir = curClean ? toAbs(curClean) : '';
  const others = new Set<string>();
  for (const wd of allWorkingDirs) {
    const c = clean(wd);
    if (!c || c === curClean) continue;
    others.add(toAbs(c));
  }
  const filtered = currentProjectDir
    ? [...others].filter((o) => !isWithin(currentProjectDir, o))
    : [...others];
  return { currentProjectDir, otherProjectDirs: filtered };
}
