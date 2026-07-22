import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, symlinkSync, realpathSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { resolveRealPath, isCrossProjectAccess, otherProjectDirsAbs } from './projectContainment.js';

let ws: string;
beforeAll(() => {
  ws = realpathSync(mkdtempSync(path.join(tmpdir(), 'svct-containment-')));
  for (const p of ['ProjectA', 'ProjectB', 'App', 'AppData', 'clients/Nexus', 'clients/AML', 'node_modules/x']) {
    mkdirSync(path.join(ws, p), { recursive: true });
  }
  symlinkSync(path.join(ws, 'ProjectB'), path.join(ws, 'ProjectA', 'escape'));
});
afterAll(() => rmSync(ws, { recursive: true, force: true }));

const dirs = (cur: string, all: string[]) => otherProjectDirsAbs(ws, cur, all);
const blocked = (cur: string, all: string[], target: string) => {
  const { currentProjectDir, otherProjectDirs } = dirs(cur, all);
  const base = currentProjectDir || ws;
  return isCrossProjectAccess(resolveRealPath(base, target), currentProjectDir, otherProjectDirs);
};

describe('svc-temporal projectContainment — confine a job to its project', () => {
  it('allows own project + deps', () => {
    expect(blocked('ProjectA', ['ProjectA', 'ProjectB'], 'own.txt')).toBe(false);
    expect(blocked('ProjectA', ['ProjectA', 'ProjectB'], path.join(ws, 'node_modules/x'))).toBe(false);
  });
  it('blocks relative ../ into a sibling', () => {
    expect(blocked('ProjectA', ['ProjectA', 'ProjectB'], '../ProjectB/secret')).toBe(true);
  });
  it('blocks absolute into a sibling', () => {
    expect(blocked('ProjectA', ['ProjectA', 'ProjectB'], path.join(ws, 'ProjectB/secret'))).toBe(true);
  });
  it('blocks a symlink out to a sibling', () => {
    expect(blocked('ProjectA', ['ProjectA', 'ProjectB'], 'escape/secret')).toBe(true);
  });
  it('blocks prefix-name sibling (App -> AppData)', () => {
    expect(blocked('App', ['App', 'AppData'], path.join(ws, 'AppData/x'))).toBe(true);
  });
  it('blocks nested sibling clients/Nexus -> clients/AML', () => {
    expect(blocked('clients/Nexus', ['clients/Nexus', 'clients/AML'], '../AML/x')).toBe(true);
  });
  it('empty workingDir cannot enter a project', () => {
    expect(blocked('', ['ProjectA', 'ProjectB'], 'ProjectB/secret')).toBe(true);
  });
});
