import { StepStatus, type Step } from '../shared/types.js';

/**
 * Dependency reference from a step's `dependsOn` list.
 *   • `num`  — bare number (e.g. `"4"`). Resolves against this phase first,
 *              then any other phase with a matching step number in state.
 *   • `qual` — phase-qualified (e.g. `"generator.4"`). Resolves directly
 *              against `state.steps["generator.4"]`.
 *   • `all`  — wildcard meaning "every other step in this phase".
 */
export type ParsedDep =
  | { kind: 'num'; number: string }
  | { kind: 'qual'; phase: string; number: string }
  | { kind: 'all' };

export function parseDep(raw: string): ParsedDep | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  if (trimmed.toLowerCase() === 'all') return { kind: 'all' };
  const parts = trimmed.split('.').map(p => p.trim()).filter(Boolean);
  if (parts.length === 0) return null;
  if (parts.length >= 2) return { kind: 'qual', phase: parts[0], number: parts.slice(1).join('.') };
  return { kind: 'num', number: parts[0] };
}

export function formatDep(dep: ParsedDep): string {
  if (dep.kind === 'all') return 'all';
  if (dep.kind === 'qual') return `${dep.phase}.${dep.number}`;
  return dep.number;
}

/**
 * Pure dependency-satisfaction predicate for the parallel runner. Exported for
 * unit testing. A bare-number dep resolves against THIS phase first: if the
 * number names a step in `phaseSteps`, ONLY this phase's `completed` set counts
 * (no cross-phase fallback). Step numbers reset per phase, so without that guard
 * a same-numbered step in an earlier phase (preamble.1 / generator.1 / …) would
 * spuriously satisfy a postamble dep on "1" and let dependents fan out and race.
 */
export function isDepSatisfied(
  dep: ParsedDep,
  selfNumber: string,
  phaseSteps: Step[],
  completed: Set<string>,
  stateSteps: Record<string, { status: StepStatus } | undefined>,
): boolean {
  if (dep.kind === 'all') {
    return phaseSteps.every(s => s.number === selfNumber || completed.has(s.number));
  }
  if (dep.kind === 'qual') {
    return stateSteps[`${dep.phase}.${dep.number}`]?.status === StepStatus.COMPLETE;
  }
  if (completed.has(dep.number)) return true;
  // Intra-phase dep: this number is a step in the current phase → same-phase only.
  if (phaseSteps.some(s => s.number === dep.number)) return false;
  // Cross-phase fallback: a bare number NOT in this phase refers to another phase.
  for (const [key, st] of Object.entries(stateSteps)) {
    if (st?.status === StepStatus.COMPLETE && key.endsWith(`.${dep.number}`)) return true;
  }
  return false;
}

/**
 * Pure failure-block predicate (mirror of isDepSatisfied). A bare-number dep is
 * blocked only by failures of the matching step in THIS phase when that number
 * names a local step; otherwise by a cross-phase same-numbered failed step.
 */
export function isDepBlockedByFailure(
  dep: ParsedDep,
  selfNumber: string,
  phaseSteps: Step[],
  failed: Set<string>,
  cancelledSteps: Set<string>,
  stateSteps: Record<string, { status: StepStatus } | undefined>,
): boolean {
  if (dep.kind === 'all') {
    return phaseSteps.some(s =>
      s.number !== selfNumber && (failed.has(s.number) || cancelledSteps.has(s.number)),
    );
  }
  if (dep.kind === 'qual') {
    return stateSteps[`${dep.phase}.${dep.number}`]?.status === StepStatus.FAILED;
  }
  if (failed.has(dep.number) || cancelledSteps.has(dep.number)) return true;
  if (phaseSteps.some(s => s.number === dep.number)) return false;
  for (const [key, st] of Object.entries(stateSteps)) {
    if (st?.status === StepStatus.FAILED && key.endsWith(`.${dep.number}`)) return true;
  }
  return false;
}
