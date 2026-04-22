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
import { mkdir, readFile, writeFile, stat, readdir, unlink } from 'fs/promises';
import { join, dirname, relative, posix } from 'path';
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

function shouldExclude(relativePath: string): boolean {
  const segments = relativePath.split('/');
  const fileName = segments[segments.length - 1];

  for (const pattern of SYNC_EXCLUDE_PATTERNS) {
    if (pattern.includes('*')) {
      // Glob — match against filename (e.g. '*.log', '.env.*.local', '*.temporal-*')
      if (patternToRegex(pattern).test(fileName)) return true;
    } else {
      // Literal segment match — hits directory names like 'node_modules', '.git'
      if (segments.includes(pattern)) return true;
    }
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

  // 2. Filter out excluded files
  const toProcess = s3Objects.filter((obj) => {
    const relPath = obj.key.slice(prefix.length + 1); // strip "{prefix}/"
    return !shouldExclude(relPath);
  });

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
  const localFiles = await collectLocalFiles(scanDir);
  console.log(`[pushWorkspaceToS3] Found ${localFiles.length} files:`, localFiles);

  let fileCount = 0;
  let bytes = 0;
  const conflicts: FileConflict[] = [];

  const results = await batchProcess(localFiles, S3_SYNC_CONCURRENCY, async (relFile) => {
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

      if (s3Exists && s3LastModified && s3LastModified > localStat.mtime) {
        // S3 is newer — conflict! Upload to a side path so we never lose work.
        // Guard against chaining: if the key is already a backup, just overwrite
        // rather than producing `foo.temporal-X.temporal-Y` debris.
        if (/\.temporal-\d+/.test(s3Key)) {
          await getS3().send(
            new PutObjectCommand({ Bucket: bucket, Key: s3Key, Body: body }),
          );
          return { uploaded: true, bytes: body.length };
        }
        const timestamp = Date.now();
        const sidePath = `${s3Key}.temporal-${timestamp}`;

        await getS3().send(
          new PutObjectCommand({
            Bucket: bucket,
            Key: sidePath,
            Body: body,
          }),
        );

        conflicts.push({
          path: s3RelPath,
          resolution: 'renamed',
          renamedTo: sidePath,
          s3ETag,
          localModified: localStat.mtime.toISOString(),
        });

        return { uploaded: true, bytes: body.length };
      }

      // Upload (new file or local is newer)
      await getS3().send(
        new PutObjectCommand({
          Bucket: bucket,
          Key: s3Key,
          Body: body,
        }),
      );

      return { uploaded: true, bytes: body.length };
    } catch (err) {
      console.error(`[pushWorkspaceToS3] Failed to upload ${relFile}:`, err);
      return { uploaded: false, bytes: 0 };
    }
  });

  for (const r of results) {
    if (r.uploaded) fileCount++;
    bytes += r.bytes;
    heartbeat({ op: 'push', fileCount, bytes });
  }

  return { fileCount, conflicts, bytes };
}
