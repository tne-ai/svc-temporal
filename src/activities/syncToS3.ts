/**
 * S3 sync activity — uploads workspace output files to S3.
 */

import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { readFileSync, readdirSync, statSync } from 'fs';
import { join, relative } from 'path';
import { heartbeat } from '@temporalio/activity';

const s3 = new S3Client({});
const BUCKET = process.env.S3_BUCKET || '';

interface SyncParams {
  workspacePath: string;
  outputDir: string;
  prefix: string;
}

/**
 * Sync output files from workspace to S3.
 */
export async function syncToS3(params: SyncParams): Promise<{ uploaded: number }> {
  if (!BUCKET) {
    return { uploaded: 0 };
  }

  const { workspacePath, outputDir, prefix } = params;
  const dir = join(workspacePath, outputDir);
  let uploaded = 0;

  try {
    const files = collectFiles(dir);

    for (const file of files) {
      const key = `${prefix}/${relative(dir, file)}`;
      const body = readFileSync(file);

      await s3.send(new PutObjectCommand({
        Bucket: BUCKET,
        Key: key,
        Body: body,
      }));

      uploaded++;
      heartbeat({ status: 'uploading', uploaded, total: files.length });
    }
  } catch (err) {
    // Non-fatal: log but don't fail the workflow
    console.error('S3 sync error:', err);
  }

  return { uploaded };
}

function collectFiles(dir: string): string[] {
  const files: string[] = [];
  try {
    for (const entry of readdirSync(dir)) {
      const path = join(dir, entry);
      const stat = statSync(path);
      if (stat.isFile() && !entry.startsWith('.') && !entry.startsWith('_')) {
        files.push(path);
      } else if (stat.isDirectory() && !entry.startsWith('.')) {
        files.push(...collectFiles(path));
      }
    }
  } catch { /* directory doesn't exist or not readable */ }
  return files;
}
