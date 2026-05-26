/**
 * checkFreshness — on workflow resume, walk every previously-COMPLETE
 * step's recorded mtimes and detect:
 *
 *   • **External modification**: the step's output file's current mtime
 *     diverges from what was recorded at completion. Treated
 *     conservatively per the Python engine — the step itself is marked
 *     stale, then `propagateForward` (in workflow code) marks every
 *     transitive dependent stale too. Same model as
 *     `propagation.check_freshness()` (tne-plugins/plugins/tne/engine/propagation.py).
 *
 *   • **Inputs newer than output**: any declared input's current mtime
 *     exceeds the step's recorded output mtime — meaning someone (or
 *     something) edited an upstream artifact since this step last ran.
 *     Same staleness verdict.
 *
 * I/O lives here so the workflow stays deterministic; the workflow calls
 * this activity once on resume and feeds the result to `propagateForward`.
 */

import { existsSync, statSync } from 'fs';
import { isAbsolute, join } from 'path';
import type { FreshnessCheckParams, FreshnessCheckResult } from '../shared/types.js';

/** Tolerance for mtime drift (ms). Matches the Python engine's >1s
 *  threshold — sub-second jitter from S3 sync round-tripping shouldn't
 *  trigger spurious staleness. */
const MTIME_TOLERANCE_MS = 1000;

export async function checkFreshness(params: FreshnessCheckParams): Promise<FreshnessCheckResult> {
  const { workspacePath, workingDir, recorded } = params;
  const cwdRoot = workingDir ? join(workspacePath, workingDir) : workspacePath;

  const externallyModified: string[] = [];
  const inputsNewer: string[] = [];

  for (const [stepKey, snap] of Object.entries(recorded)) {
    // Output drift — did someone edit the file outside the workflow?
    if (snap.outputPath && snap.outputMtime != null) {
      const abs = isAbsolute(snap.outputPath) ? snap.outputPath : join(cwdRoot, snap.outputPath);
      if (existsSync(abs)) {
        try {
          const current = statSync(abs).mtimeMs;
          if (Math.abs(current - snap.outputMtime) > MTIME_TOLERANCE_MS) {
            externallyModified.push(stepKey);
          }
        } catch {
          // unreadable — punt on this step
        }
      }
    }

    // Inputs newer than the step's last output — anything upstream changed?
    if (snap.outputMtime != null && snap.inputMtimes) {
      for (const [inputRel, recordedInputMt] of Object.entries(snap.inputMtimes)) {
        const inpAbs = isAbsolute(inputRel) ? inputRel : join(cwdRoot, inputRel);
        if (!existsSync(inpAbs)) continue;
        try {
          const current = statSync(inpAbs).mtimeMs;
          // The conservative test: an input mtime now exceeds the step's
          // recorded output mtime. The recorded-input mtime is informational
          // (lets us tell apart "input changed since this step ran" vs
          // "input was always newer for some other reason") but the
          // operative comparison is input-vs-output, exactly mirroring
          // Python's `check_freshness` (propagation.py:148).
          if (current > snap.outputMtime + MTIME_TOLERANCE_MS) {
            inputsNewer.push(stepKey);
            // Reference the recorded-input mtime so static analyzers don't
            // flag the variable as unused; it's also useful in debug logs.
            void recordedInputMt;
            break;
          }
        } catch {
          // unreadable — punt
        }
      }
    }
  }

  return { externallyModified, inputsNewer };
}
