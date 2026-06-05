/**
 * S3 workspace pull/push activities for the Temporal worker.
 *
 * Before a job starts, pullWorkspaceFromS3 downloads the user's workspace
 * from S3 to local disk. After the job finishes, pushWorkspaceToS3 uploads
 * results back to S3 so the Horizon frontend can read them.
 *
 * S3 path convention: {userId}/{relativePath}
 */

import {
  S3Client,
  ListObjectsV2Command,
  GetObjectCommand,
  PutObjectCommand,
  HeadObjectCommand,
  DeleteObjectsCommand,
} from '@aws-sdk/client-s3';
import { heartbeat } from '@temporalio/activity';
import { createHash } from 'crypto';
import { mkdir, readFile, writeFile, stat, readdir, unlink, rm } from 'fs/promises';
import { join, dirname, relative, posix, resolve, isAbsolute } from 'path';
import { Readable } from 'stream';

import { S3_SYNC_CONCURRENCY, SYNC_EXCLUDE_PATTERNS } from '../shared/constants.js';
import type {
  WorkspaceSyncParams,
  WorkspaceSyncResult,
  FileConflict,
} from '../shared/types.js';

let _s3: S3Client | undefined;
function getS3(): S3Client {
  if (!_s3) {
    _s3 = new S3Client({
      region: process.env.AWS_REGION || 'us-west-2',
      ...(process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY
        ? {
            credentials: {
              accessKeyId: process.env.AWS_ACCESS_KEY_ID,
              secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
              ...(process.env.AWS_SESSION_TOKEN ? { sessionToken: process.env.AWS_SESSION_TOKEN } : {}),
            },
          }
        : {}),
    });
  }
  return _s3;
}

// ─── Helpers ───────────────────────────────────────────────────────────────

/**
 * Check whether a relative path should be excluded from sync.
 * Uses simple matching: startsWith for directory names, endsWith for extensions,
 * and basic wildcard patterns like ".env.*.local".
 */
function patternToRegex(pattern: string): RegExp {
  // Escape regex specials except '*', then convert '*' → '.*'.
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
  return new RegExp(`^${escaped}$`);
}

export function shouldExclude(relativePath: string): boolean {
  const segments = relativePath.split('/');
  const fileName = segments[segments.length - 1];

  for (const pattern of SYNC_EXCLUDE_PATTERNS) {
    if (pattern.includes('*')) {
      // Glob — match against filename (e.g. '*.log', '.env.*.local', '*.temporal-*')
      if (patternToRegex(pattern).test(fileName)) return true;
    } else if (pattern.includes('/')) {
      // Multi-segment literal like '.claude/skills' — match a path-prefix.
      // The previous `segments.includes(pattern)` could NEVER match these
      // because the slash means it's not a single segment, so all of
      // .claude/skills, .claude/projects, .claude/EBP, .claude/debug
      // were silently un-excluded. Result: every periodic push uploaded
      // ~2k skill files, and the resulting cross-worker races on those
      // files were the source of the .temporal-<ts> backup proliferation.
      const patternSegs = pattern.split('/');
      let prefixMatch = patternSegs.length <= segments.length;
      for (let i = 0; prefixMatch && i < patternSegs.length; i++) {
        if (segments[i] !== patternSegs[i]) prefixMatch = false;
      }
      if (prefixMatch) return true;
    } else {
      // Single-segment literal — hits directory names like 'node_modules', '.git'
      if (segments.includes(pattern)) return true;
    }
  }

  return false;
}

/**
 * Whether a workspace-relative path is a doubled working-dir artifact — e.g.
 * `tne-website/tne-website/…` (an immediately-repeated top-level segment), or,
 * for a scoped sync, a path that already begins with the scope name and would
 * get the scope prepended again to form `<scope>/<scope>/…`.
 *
 * These come from a cwd-relative write that re-includes the project name (or a
 * Bash copy/clone). Left alone, push uploads a doubled S3 key and pull
 * recreates the bogus nested directory — and a wipe→re-pull cycle keeps
 * resurrecting it, bloating every sync. Skipping them at both ends breaks the
 * loop. (Existing doubled keys still need a one-time S3 cleanup.)
 */
export function isDoubledDirArtifact(relPath: string, scopePath?: string): boolean {
  const segs = relPath.split('/').filter(Boolean);
  if (segs.length >= 2 && segs[0] === segs[1]) return true;
  if (scopePath) {
    const sp = scopePath.replace(/^\/+|\/+$/g, '');
    if (sp && (relPath === sp || relPath.startsWith(sp + '/'))) return true;
  }
  return false;
}

/**
 * Process items in batches of `concurrency`.
 */
async function batchProcess<T, R>(
  items: T[],
  concurrency: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = [];
  for (let i = 0; i < items.length; i += concurrency) {
    const batch = items.slice(i, i + concurrency);
    const batchResults = await Promise.allSettled(batch.map(fn));
    for (const r of batchResults) {
      if (r.status === 'fulfilled') {
        results.push(r.value);
      }
      // Rejected items are swallowed — individual file failures don't abort sync
    }
  }
  return results;
}

/**
 * Convert an S3 Body stream into a Buffer.
 */
async function streamToBuffer(stream: Readable | ReadableStream | Blob | undefined): Promise<Buffer> {
  if (!stream) return Buffer.alloc(0);

  if (stream instanceof Readable) {
    const chunks: Buffer[] = [];
    for await (const chunk of stream) {
      chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
    }
    return Buffer.concat(chunks);
  }

  // ReadableStream (web) or Blob
  if ('arrayBuffer' in stream) {
    const ab = await (stream as Blob).arrayBuffer();
    return Buffer.from(ab);
  }

  // Web ReadableStream
  const reader = (stream as ReadableStream).getReader();
  const chunks: Uint8Array[] = [];
  let done = false;
  while (!done) {
    const result = await reader.read();
    done = result.done;
    if (result.value) chunks.push(result.value);
  }
  return Buffer.from(Buffer.concat(chunks));
}

/**
 * Recursively collect all files under a directory.
 * Returns paths relative to `baseDir`.
 */
async function collectLocalFiles(baseDir: string): Promise<string[]> {
  const files: string[] = [];

  async function walk(dir: string): Promise<void> {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return; // directory doesn't exist or not readable
    }

    for (const entry of entries) {
      const fullPath = join(dir, entry.name);
      const relPath = relative(baseDir, fullPath);

      if (shouldExclude(relPath)) continue;

      if (entry.isDirectory()) {
        await walk(fullPath);
      } else if (entry.isFile()) {
        files.push(relPath);
      }
    }
  }

  await walk(baseDir);
  return files;
}

/**
 * Walk a workspace and compute a cheap fingerprint plus the file list, in
 * a single pass. The fingerprint is `count|totalBytes|maxMtimeMs` — enough
 * to detect "nothing has changed since the last sync" without HEADing
 * anything in S3. Mtime resolution on macOS/Linux is millisecond-level for
 * the relevant filesystems we run on, so the max-mtime check catches every
 * write-since-last-sync that matters.
 *
 * Returns the file list (relative paths) AND the fingerprint string, so
 * callers don't have to walk twice.
 */
async function collectLocalFilesWithFingerprint(
  baseDir: string,
): Promise<{ files: string[]; fingerprint: string; sigs: Map<string, string> }> {
  const files: string[] = [];
  // Per-file signature `mtimeMs:size` — lets the push process only the delta
  // (files changed since the last confirmed push) instead of HEAD-checking
  // every file in the workspace on every tick.
  const sigs = new Map<string, string>();
  let totalBytes = 0;
  let maxMtimeMs = 0;

  async function walk(dir: string): Promise<void> {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      const fullPath = join(dir, entry.name);
      const relPath = relative(baseDir, fullPath);

      if (shouldExclude(relPath)) continue;

      if (entry.isDirectory()) {
        await walk(fullPath);
      } else if (entry.isFile()) {
        files.push(relPath);
        try {
          const st = await stat(fullPath);
          totalBytes += st.size;
          const mtimeMs = st.mtime.getTime();
          if (mtimeMs > maxMtimeMs) maxMtimeMs = mtimeMs;
          sigs.set(relPath, `${mtimeMs}:${st.size}`);
        } catch {
          // unreadable file — skip its stat contribution; the upload pass
          // will surface a per-file error if it matters.
        }
      }
    }
  }

  await walk(baseDir);
  return { files, fingerprint: `${files.length}|${totalBytes}|${maxMtimeMs}`, sigs };
}

/**
 * In-memory record of the last successful push per (bucket, prefix, scanDir).
 * Reset on process restart. Each tne-fsm-queue worker keeps its own copy —
 * different pods don't share, so in multi-pod prod a sibling pod can still
 * push the same workspace once before its own fingerprint catches up. This
 * is fine: pushWorkspaceToS3 is content-idempotent (the per-file MD5
 * fast-path inside the upload pass skips identical bytes), the fingerprint
 * just avoids the directory walk + 781-HEAD scan when the local-pod state
 * is unchanged.
 */
const LAST_PUSH_FINGERPRINT = new Map<string, string>();

/**
 * Per-file signatures (`mtimeMs:size`) confirmed in S3 after the last push,
 * keyed the same way as LAST_PUSH_FINGERPRINT. When the workspace fingerprint
 * changes (some file was written) we don't re-HEAD every file — only the ones
 * whose signature differs from this snapshot. A fanout child that touches a
 * handful of files then does HEAD/upload work proportional to that handful,
 * not to the whole 800-file project. Files that error during upload are
 * dropped from the snapshot so they're retried next push. Process-local and
 * reset on restart (a cold push falls back to the full scan, which is correct).
 */
const LAST_PUSH_FILE_SIGS = new Map<string, Map<string, string>>();

function fingerprintKey(bucket: string, prefix: string, scanDir: string): string {
  return `${bucket}|${prefix}|${scanDir}`;
}

// ─── Pull ──────────────────────────────────────────────────────────────────

/**
 * Pull a user's workspace from S3 to local disk.
 *
 * - Lists all objects under `{prefix}/{scopePath}/` (or `{prefix}/` if no scopePath)
 * - Skips files matching SYNC_EXCLUDE_PATTERNS
 * - Downloads missing files; skips local files that are newer (in-progress work wins)
 * - Creates directories as needed
 * - Heartbeats progress
 */
/**
 * Delete any residual `.temporal-{timestamp}` conflict-backup files — both
 * locally and in S3 under the workspace prefix. Prior versions of the sync
 * code could chain suffixes (`foo.temporal-X.temporal-Y.…`) so workspaces can
 * accumulate tens of thousands of these; we scrub them on every pull so that
 * each fresh run starts clean.
 *
 * Safe: only matches the exact `.temporal-<digits>` pattern we generate. User
 * files like `foo.tempfile.md` or `something.temporal-notes` are untouched.
 */
const TEMPORAL_BACKUP_RE = /\.temporal-\d+(?:\.temporal-\d+)*$/;

async function cleanupTemporalBackups(
  bucket: string,
  prefix: string,
  localPath: string,
  scopePath?: string,
): Promise<{ localDeleted: number; s3Deleted: number }> {
  let localDeleted = 0;
  let s3Deleted = 0;

  // Local scrub
  const scanDir = scopePath ? join(localPath, scopePath) : localPath;
  async function walkAndDelete(dir: string): Promise<void> {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        await walkAndDelete(full);
      } else if (entry.isFile() && TEMPORAL_BACKUP_RE.test(entry.name)) {
        try {
          await unlink(full);
          localDeleted++;
        } catch {
          // ignore
        }
      }
    }
  }
  await walkAndDelete(scanDir);

  // S3 scrub — list objects under prefix and delete any ending in `.temporal-<ts>…`
  const s3Prefix = scopePath ? `${prefix}/${scopePath}/` : `${prefix}/`;
  let continuationToken: string | undefined;
  const toDelete: { Key: string }[] = [];
  do {
    const listRes = await getS3().send(
      new ListObjectsV2Command({
        Bucket: bucket,
        Prefix: s3Prefix,
        ContinuationToken: continuationToken,
      }),
    );
    for (const obj of listRes.Contents ?? []) {
      if (obj.Key && TEMPORAL_BACKUP_RE.test(obj.Key)) {
        toDelete.push({ Key: obj.Key });
      }
    }
    continuationToken = listRes.IsTruncated ? listRes.NextContinuationToken : undefined;
  } while (continuationToken);

  // S3 DeleteObjects caps at 1000 keys per call
  for (let i = 0; i < toDelete.length; i += 1000) {
    const batch = toDelete.slice(i, i + 1000);
    try {
      await getS3().send(
        new DeleteObjectsCommand({
          Bucket: bucket,
          Delete: { Objects: batch, Quiet: true },
        }),
      );
      s3Deleted += batch.length;
    } catch (err) {
      console.error('[cleanupTemporalBackups] DeleteObjects failed:', err);
    }
  }

  if (localDeleted > 0 || s3Deleted > 0) {
    console.log(`[cleanupTemporalBackups] Purged ${localDeleted} local + ${s3Deleted} S3 backup files`);
  }
  return { localDeleted, s3Deleted };
}

export async function pullWorkspaceFromS3(
  params: WorkspaceSyncParams,
): Promise<WorkspaceSyncResult> {
  const { bucket, prefix, localPath, scopePath } = params;

  // Scrub conflict-backup debris before pulling — keeps workspaces lean and
  // prevents old `.temporal-*` files from being re-pulled on every run.
  await cleanupTemporalBackups(bucket, prefix, localPath, scopePath).catch(err =>
    console.error('[pullWorkspaceFromS3] cleanup failed (non-fatal):', err),
  );

  const s3Prefix = scopePath
    ? `${prefix}/${scopePath}/`
    : `${prefix}/`;

  // 1. List all objects under the prefix (handle pagination)
  const s3Objects: { key: string; lastModified: Date; size: number }[] = [];
  let continuationToken: string | undefined;

  do {
    const listRes = await getS3().send(
      new ListObjectsV2Command({
        Bucket: bucket,
        Prefix: s3Prefix,
        ContinuationToken: continuationToken,
      }),
    );

    for (const obj of listRes.Contents ?? []) {
      if (!obj.Key || !obj.LastModified || obj.Key.endsWith('/')) continue;
      s3Objects.push({
        key: obj.Key,
        lastModified: obj.LastModified,
        size: obj.Size ?? 0,
      });
    }

    continuationToken = listRes.IsTruncated
      ? listRes.NextContinuationToken
      : undefined;
  } while (continuationToken);

  // 2. Filter out excluded files + doubled-dir artifacts (so a wipe→re-pull
  //    cycle stops resurrecting tne-website/tne-website/… locally).
  let doubledSkipped = 0;
  const toProcess = s3Objects.filter((obj) => {
    const relPath = obj.key.slice(prefix.length + 1); // strip "{prefix}/"
    if (shouldExclude(relPath)) return false;
    if (isDoubledDirArtifact(relPath)) { doubledSkipped++; return false; }
    return true;
  });
  if (doubledSkipped > 0) {
    console.warn(`[pullWorkspaceFromS3] skipped ${doubledSkipped} doubled-dir S3 key(s)`);
  }

  // 3. Download files in batches
  let fileCount = 0;
  let bytes = 0;
  const conflicts: FileConflict[] = [];

  const results = await batchProcess(toProcess, S3_SYNC_CONCURRENCY, async (obj) => {
    const relPath = obj.key.slice(prefix.length + 1);
    const localFile = join(localPath, relPath);

    try {
      // Check if local file exists and compare timestamps
      let shouldDownload = true;
      try {
        const localStat = await stat(localFile);
        if (localStat.mtime > obj.lastModified) {
          // Local file is newer — skip (it's in-progress work)
          conflicts.push({
            path: relPath,
            resolution: 'skipped',
            localModified: localStat.mtime.toISOString(),
          });
          shouldDownload = false;
        }
      } catch {
        // File doesn't exist locally — download it
      }

      if (!shouldDownload) return { downloaded: false, bytes: 0 };

      // Ensure parent directory exists
      await mkdir(dirname(localFile), { recursive: true });

      // Download from S3
      const getRes = await getS3().send(
        new GetObjectCommand({ Bucket: bucket, Key: obj.key }),
      );

      const body = await streamToBuffer(getRes.Body as Readable);
      await writeFile(localFile, body);

      return { downloaded: true, bytes: body.length };
    } catch (err) {
      console.error(`[pullWorkspaceFromS3] Failed to download ${obj.key}:`, err);
      return { downloaded: false, bytes: 0 };
    }
  });

  for (const r of results) {
    if (r.downloaded) fileCount++;
    bytes += r.bytes;
    heartbeat({ op: 'pull', fileCount, bytes });
  }

  return { fileCount, conflicts, bytes };
}

// ─── Push ──────────────────────────────────────────────────────────────────

/**
 * Push local workspace files to S3.
 *
 * - Recursively scans `{localPath}/{scopePath}/` for files
 * - Skips files matching SYNC_EXCLUDE_PATTERNS
 * - Uploads new or locally-newer files
 * - On conflict (S3 is newer), saves to a side path to preserve both versions
 * - Heartbeats progress
 */
export async function pushWorkspaceToS3(
  params: WorkspaceSyncParams,
): Promise<WorkspaceSyncResult> {
  const { bucket, prefix, localPath, scopePath } = params;

  const scanDir = scopePath ? join(localPath, scopePath) : localPath;
  console.log(`[pushWorkspaceToS3] bucket=${bucket}, prefix=${prefix}, scanDir=${scanDir}`);

  // Walk + fingerprint in one pass. The fingerprint encodes file count,
  // total bytes, and max mtime; if it's identical to the last successful
  // push for this scope we can short-circuit before doing 781 HEAD calls
  // against S3. invokeSkill's per-step periodic timer + the workflow's
  // terminal sync routinely produce 3-4 push calls per run; without this
  // they all walk and HEAD-check an unchanged workspace.
  const { files: localFiles, fingerprint, sigs } = await collectLocalFilesWithFingerprint(scanDir);
  const fpKey = fingerprintKey(bucket, prefix, scanDir);
  const lastSigs = LAST_PUSH_FILE_SIGS.get(fpKey) ?? new Map<string, string>();
  const lastFp = LAST_PUSH_FINGERPRINT.get(fpKey);
  if (lastFp && lastFp === fingerprint) {
    console.log(
      `[pushWorkspaceToS3] no changes since last push (${localFiles.length} files, fingerprint=${fingerprint}) — skipping`,
    );
    return { fileCount: 0, bytes: 0, conflicts: [] };
  }
  // Truncated file listing: dumping 781 paths to the console on every
  // sync drowned the worker log. Show count + a sample; if a caller
  // needs the full list they can re-scan offline.
  // Don't push doubled-dir artifacts to S3 (a cwd-relative write or copy that
  // re-included the project name). Uploading them creates `<scope>/<scope>/…`
  // keys that pull then resurrects on every wipe→re-pull cycle.
  const pushable = localFiles.filter((relFile) => !isDoubledDirArtifact(relFile, scopePath));
  const doubledSkipped = localFiles.length - pushable.length;
  if (doubledSkipped > 0) {
    console.warn(`[pushWorkspaceToS3] skipped ${doubledSkipped} doubled-dir path(s)`);
  }
  const sample = pushable.slice(0, 10);
  const tail = pushable.length > sample.length ? ` (+${pushable.length - sample.length} more)` : '';
  console.log(`[pushWorkspaceToS3] Found ${pushable.length} files; sample: ${sample.join(', ')}${tail}`);

  let fileCount = 0;
  let bytes = 0;
  const conflicts: FileConflict[] = [];

  let deltaSkipped = 0;
  const results = await batchProcess(pushable, S3_SYNC_CONCURRENCY, async (relFile) => {
    // Delta fast-path: if this file's signature (mtime:size) matches what we
    // confirmed in S3 on the last push, it's unchanged and already in sync —
    // skip the read + HEAD entirely. A fanout child that wrote 3 files does
    // HEAD/upload work for ~3 files, not all 800.
    const sig = sigs.get(relFile);
    if (sig !== undefined && lastSigs.get(relFile) === sig) {
      deltaSkipped++;
      return { uploaded: false, bytes: 0, relFile, inSync: true };
    }

    // relFile is relative to scanDir; the S3 key needs to include scopePath
    const s3RelPath = scopePath
      ? posix.join(scopePath, relFile.split('/').join('/'))
      : relFile.split('/').join('/');
    const s3Key = `${prefix}/${s3RelPath}`;
    const localFile = join(scanDir, relFile);

    try {
      const localStat = await stat(localFile);
      const body = await readFile(localFile);

      // Check if S3 object already exists
      let s3Exists = false;
      let s3LastModified: Date | undefined;
      let s3ETag: string | undefined;

      try {
        const headRes = await getS3().send(
          new HeadObjectCommand({ Bucket: bucket, Key: s3Key }),
        );
        s3Exists = true;
        s3LastModified = headRes.LastModified;
        s3ETag = headRes.ETag;
      } catch {
        // Object doesn't exist in S3 — will upload
      }

      // Content-identical fast path. S3 ETag for single-part PutObjectCommand
      // uploads is the MD5 of the body wrapped in quotes. Compare hashes
      // before looking at timestamps — we push every 30s during a run, and
      // without this check unchanged files would trip the "S3 newer than
      // local mtime" branch below on every tick, exploding the workspace
      // with `.temporal-<ts>` backup debris.
      //
      // For multipart uploads (ETag of form "md5-N", with a dash) and
      // SSE-KMS objects, the ETag isn't plain MD5 so we can't shortcut on
      // it. Without a fallback, every periodic push of those files would
      // hit the conflict branch below and write a `.temporal-<ts>` side
      // file — which is exactly what was accumulating for users on a
      // KMS-encrypted bucket (1+ backup file per file per 30s sync). Pay
      // a GET-and-compare for those cases; for small workspace files it's
      // a millisecond and it eliminates the spurious side-writes.
      if (s3Exists && s3ETag) {
        const s3Hash = s3ETag.replace(/^"|"$/g, '');
        if (!s3Hash.includes('-')) {
          const localMd5 = createHash('md5').update(body).digest('hex');
          if (localMd5 === s3Hash) {
            return { uploaded: false, bytes: 0, relFile, inSync: true };
          }
        } else {
          try {
            const remote = await getS3().send(new GetObjectCommand({ Bucket: bucket, Key: s3Key }));
            const remoteBuf = await streamToBuffer(remote.Body as any);
            if (Buffer.compare(remoteBuf, body) === 0) {
              return { uploaded: false, bytes: 0, relFile, inSync: true };
            }
          } catch {
            // Fall through to the existing branches; not worse than before.
          }
        }
      }

      if (s3Exists && s3LastModified && s3LastModified > localStat.mtime) {
        // Local is older than S3 AND content differs → we hold a stale copy.
        // This happens routinely with multi-pod fanout: pod A pulled at T0,
        // wrote locally at T1; pod B pulled, wrote, pushed at T2 > T1; pod A's
        // periodic 30s push then sees S3 newer than its T1 local mtime. Pod A
        // has nothing useful to contribute — the canonical S3 already reflects
        // a later writer. Previously we wrote a `.temporal-${timestamp}` side
        // file with our stale content. That was theatre: side files are
        // excluded from re-pull/re-collect (see shouldExclude), so they were
        // never visible to any agent and only ever scrubbed by
        // cleanupTemporalBackups on next pull. Net effect: permanent S3 litter
        // (one new file per stale pod per 30s tick) with zero recoverable
        // data. Skip the upload entirely; record the skip in conflicts so the
        // count is still surfaced.
        conflicts.push({
          path: s3RelPath,
          resolution: 'skipped',
          s3ETag,
          localModified: localStat.mtime.toISOString(),
        });
        // S3 holds a newer/different version — our local copy isn't canonical,
        // so don't record it as in sync (next push should re-examine it).
        return { uploaded: false, bytes: 0, relFile, inSync: false };
      }

      // Upload (new file or local is newer)
      await getS3().send(
        new PutObjectCommand({
          Bucket: bucket,
          Key: s3Key,
          Body: body,
        }),
      );

      return { uploaded: true, bytes: body.length, relFile, inSync: true };
    } catch (err) {
      console.error(`[pushWorkspaceToS3] Failed to upload ${relFile}:`, err);
      return { uploaded: false, bytes: 0, relFile, inSync: false };
    }
  });

  // Rebuild the per-file snapshot from this push: a file is "confirmed in S3
  // with our content" only if it uploaded, matched byte-for-byte, or was a
  // delta-skip of an already-confirmed file. Errors and S3-newer conflicts are
  // omitted so the next push re-examines them.
  const confirmedSigs = new Map<string, string>();
  for (const r of results) {
    if (r.uploaded) fileCount++;
    bytes += r.bytes;
    if (r.inSync) {
      const s = sigs.get(r.relFile);
      if (s !== undefined) confirmedSigs.set(r.relFile, s);
    }
    heartbeat({ op: 'push', fileCount, bytes });
  }
  LAST_PUSH_FILE_SIGS.set(fpKey, confirmedSigs);
  if (deltaSkipped > 0) {
    console.log(`[pushWorkspaceToS3] delta: skipped HEAD/upload for ${deltaSkipped} unchanged file(s)`);
  }

  // Stamp the fingerprint after the push completes so the next call for
  // this scope can short-circuit. Only stamp on the no-conflict success
  // path — a partial push (some files failed) leaves a divergence that
  // a future call needs to actually re-examine, so we explicitly DO want
  // the next push to redo the scan in that case.
  if (conflicts.length === 0) {
    LAST_PUSH_FINGERPRINT.set(fpKey, fingerprint);
  }

  return { fileCount, conflicts, bytes };
}

// ─── Wipe ──────────────────────────────────────────────────────────────────

export interface WipeWorkspaceParams {
  localPath: string;
  /**
   * Optional subdirectory (relative to `localPath`) to wipe. When omitted,
   * the entire `localPath` tree is cleared. Must be a relative path; absolute
   * or parent-escaping values are refused.
   */
  scopePath?: string;
}

export interface WipeWorkspaceResult {
  wipedPath: string;
  existed: boolean;
}

/**
 * Remove the local workspace directory (or a subpath under it) so a fresh
 * workflow starts from a clean slate. Called before `pullWorkspaceFromS3` at
 * workflow start — otherwise ghost files left behind by previous workflows on
 * the same worker pod shadow S3 state non-deterministically.
 *
 * No-op if the target doesn't exist yet. Caller is expected to re-create the
 * directory via `pullWorkspaceFromS3` (which `mkdir -p`s as needed).
 */
export async function wipeWorkspace(
  params: WipeWorkspaceParams,
): Promise<WipeWorkspaceResult> {
  const { localPath, scopePath } = params;

  let target = localPath;
  if (scopePath) {
    if (isAbsolute(scopePath) || scopePath.split(/[\\/]+/).includes('..')) {
      throw new Error(`wipeWorkspace: refusing unsafe scopePath "${scopePath}"`);
    }
    target = resolve(localPath, scopePath);
    const root = resolve(localPath);
    if (!target.startsWith(root + '/') && target !== root) {
      throw new Error(`wipeWorkspace: scopePath "${scopePath}" escapes localPath`);
    }
  }

  let existed = false;
  try {
    await stat(target);
    existed = true;
  } catch {
    // nothing to do
  }

  if (existed) {
    await rm(target, { recursive: true, force: true });
    console.log(`[wipeWorkspace] Cleared ${target}`);
  }

  return { wipedPath: target, existed };
}
