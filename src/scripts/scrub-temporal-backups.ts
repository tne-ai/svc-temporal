/**
 * One-shot: delete every `.temporal-<digits>[...].temporal-<digits>` conflict-
 * backup file across the configured S3 workspace bucket.
 *
 * Usage:
 *   cd svc-temporal
 *   yarn tsx scripts/scrub-temporal-backups.ts            # dry-run
 *   yarn tsx scripts/scrub-temporal-backups.ts --apply    # actually delete
 *
 * Reads AWS_BUCKET / AWS_REGION / AWS credentials from the standard env
 * (same as the worker). Optionally pass --prefix=<userId> to scope to a
 * single user; omit to scrub the whole bucket.
 */

import 'dotenv/config';
import {
  S3Client,
  ListObjectsV2Command,
  DeleteObjectsCommand,
} from '@aws-sdk/client-s3';

const TEMPORAL_BACKUP_RE = /\.temporal-\d+(?:\.temporal-\d+)*$/;

const apply = process.argv.includes('--apply');
const prefixArg = process.argv.find((a) => a.startsWith('--prefix='))?.split('=')[1];

const bucket = process.env.AWS_BUCKET;
if (!bucket) {
  console.error('AWS_BUCKET is not set');
  process.exit(1);
}

const s3 = new S3Client({
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

async function main() {
  console.log(
    `[scrub] bucket=${bucket} prefix=${prefixArg ?? '(entire bucket)'} mode=${apply ? 'APPLY' : 'DRY-RUN'}`,
  );

  let scanned = 0;
  let matched = 0;
  let deleted = 0;
  let bytesMatched = 0;

  const toDelete: { Key: string }[] = [];
  let continuationToken: string | undefined;

  do {
    const listRes = await s3.send(
      new ListObjectsV2Command({
        Bucket: bucket,
        Prefix: prefixArg ? `${prefixArg}/` : undefined,
        ContinuationToken: continuationToken,
      }),
    );

    for (const obj of listRes.Contents ?? []) {
      scanned++;
      if (obj.Key && TEMPORAL_BACKUP_RE.test(obj.Key)) {
        matched++;
        bytesMatched += obj.Size ?? 0;
        toDelete.push({ Key: obj.Key });
      }
    }

    continuationToken = listRes.IsTruncated ? listRes.NextContinuationToken : undefined;
    if (scanned % 10000 === 0) console.log(`[scrub] scanned=${scanned} matched=${matched}`);
  } while (continuationToken);

  console.log(
    `[scrub] scan done: scanned=${scanned} matched=${matched} totalBytes=${bytesMatched}`,
  );

  if (!apply) {
    console.log('[scrub] DRY-RUN — re-run with --apply to delete.');
    if (matched > 0) {
      console.log('[scrub] sample keys:');
      for (const k of toDelete.slice(0, 10)) console.log('   ', k.Key);
    }
    return;
  }

  for (let i = 0; i < toDelete.length; i += 1000) {
    const batch = toDelete.slice(i, i + 1000);
    const res = await s3.send(
      new DeleteObjectsCommand({
        Bucket: bucket,
        Delete: { Objects: batch, Quiet: true },
      }),
    );
    deleted += batch.length - (res.Errors?.length ?? 0);
    if (res.Errors?.length) {
      for (const e of res.Errors) console.error('[scrub] delete error:', e.Key, e.Message);
    }
    console.log(`[scrub] deleted ${Math.min(i + 1000, toDelete.length)}/${toDelete.length}`);
  }

  console.log(`[scrub] done. deleted=${deleted} / matched=${matched}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
