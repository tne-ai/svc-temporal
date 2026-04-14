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
} from '@aws-sdk/client-s3';
import { heartbeat } from '@temporalio/activity';
import { mkdir, readFile, writeFile, stat, readdir } from 'fs/promises';
import { join, dirname, relative, posix } from 'path';
import { Readable } from 'stream';

import { S3_SYNC_CONCURRENCY, SYNC_EXCLUDE_PATTERNS } from '../shared/constants.js';
import type {
  WorkspaceSyncParams,
  WorkspaceSyncResult,
  FileConflict,
} from '../shared/types.js';

const s3 = new S3Client({});

// ─── Helpers ───────────────────────────────────────────────────────────────

/**
 * Check whether a relative path should be excluded from sync.
 * Uses simple matching: startsWith for directory names, endsWith for extensions,
 * and basic wildcard patterns like ".env.*.local".
 */
function shouldExclude(relativePath: string): boolean {
  const segments = relativePath.split('/');

  for (const pattern of SYNC_EXCLUDE_PATTERNS) {
    if (pattern.startsWith('*.')) {
      // Extension pattern like "*.pyc" or "*.log"
      const ext = pattern.slice(1); // ".pyc"
      const fileName = segments[segments.length - 1];
      if (fileName.endsWith(ext)) return true;
    } else if (pattern.includes('*.')) {
      // Wildcard in the middle, e.g. ".env.*.local"
      const [prefix, suffix] = pattern.split('*');
      const fileName = segments[segments.length - 1];
      if (fileName.startsWith(prefix) && fileName.endsWith(suffix)) return true;
    } else {
      // Directory or exact filename pattern
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
export async function pullWorkspaceFromS3(
  params: WorkspaceSyncParams,
): Promise<WorkspaceSyncResult> {
  const { bucket, prefix, localPath, scopePath } = params;

  const s3Prefix = scopePath
    ? `${prefix}/${scopePath}/`
    : `${prefix}/`;

  // 1. List all objects under the prefix (handle pagination)
  const s3Objects: { key: string; lastModified: Date; size: number }[] = [];
  let continuationToken: string | undefined;

  do {
    const listRes = await s3.send(
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
      const getRes = await s3.send(
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
  const localFiles = await collectLocalFiles(scanDir);

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
        const headRes = await s3.send(
          new HeadObjectCommand({ Bucket: bucket, Key: s3Key }),
        );
        s3Exists = true;
        s3LastModified = headRes.LastModified;
        s3ETag = headRes.ETag;
      } catch {
        // Object doesn't exist in S3 — will upload
      }

      if (s3Exists && s3LastModified && s3LastModified > localStat.mtime) {
        // S3 is newer — conflict! Upload to a side path so we never lose work
        const timestamp = Date.now();
        const sidePath = `${s3Key}.temporal-${timestamp}`;

        await s3.send(
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
      await s3.send(
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
