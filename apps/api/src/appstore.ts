import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, type ReadStream } from 'node:fs';
import { mkdir, rename, stat, unlink } from 'node:fs/promises';
import { once } from 'node:events';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { createWriteStream } from 'node:fs';
import type { Readable } from 'node:stream';

/**
 * The blob half of the app library: content-addressed files on the API host's disk.
 *
 * A filesystem, not MinIO, and not a bytea column. The plan puts an S3-compatible artifact store in
 * Phase 3 and this is the same phase — but the store does not exist yet, and this farm is one box.
 * Everything about the interface below is chosen so that swapping the implementation later is a
 * change to this file only: nothing outside it ever learns a path, because the digest IS the key.
 *
 * Why not Postgres. A 200 MB APK in a bytea column is read into the API's heap on every download,
 * and lands in every archive the backup sidecar writes every 6 hours — turning a 30 MB dump into
 * gigabytes, and an RPO conversation into a disk-space one. Blobs and rows have different
 * durability needs and belong in different places.
 *
 * Content addressing does three things at once, which is why the digest is the only key here:
 * uploading the same build twice costs one copy, a corrupted download is detectable by the worker
 * without asking anyone, and a caller cannot name a file it did not upload.
 */

export class BlobTooLargeError extends Error {
  readonly limit: number;

  constructor(limit: number) {
    super(`Upload exceeds the ${limit} byte limit.`);
    this.name = 'BlobTooLargeError';
    this.limit = limit;
  }
}

export interface StoredBlob {
  sha256: string;
  sizeBytes: number;
  /** Absolute path. Inside this process only — it never reaches a response or a database row. */
  path: string;
  /** False when an identical blob was already stored, which is the common case for a re-upload. */
  created: boolean;
}

export class AppStore {
  readonly root: string;

  constructor(root: string) {
    this.root = root;
  }

  /**
   * `<root>/<first two hex chars>/<full digest>`.
   *
   * The two-character fan-out is not premature: ext4 handles large directories, but `ls` on the one
   * holding every build a farm has ever seen is a thing an operator does at 2am, and 256 buckets
   * keeps it answerable.
   */
  pathFor(sha256: string): string {
    return join(this.root, sha256.slice(0, 2), sha256);
  }

  /**
   * Stream an upload to disk, hashing as it goes, and refuse to exceed `maxBytes`.
   *
   * The limit is enforced ON THE STREAM rather than from Content-Length, because a client that lies
   * about its length — or omits it, which chunked encoding does by definition — would otherwise
   * write until the disk was full. Buffering first to measure it would make the check itself the
   * memory exhaustion it exists to prevent.
   *
   * Written to a temp file and renamed, never written at the final path. A crash mid-upload
   * otherwise leaves a truncated blob AT the name of its own digest, which is the one file in the
   * store nothing would ever re-verify.
   */
  async put(source: Readable, maxBytes: number): Promise<StoredBlob> {
    const tmpDir = join(this.root, 'tmp');
    await mkdir(tmpDir, { recursive: true });
    const tmp = join(tmpDir, `${randomUUID()}.part`);

    const hash = createHash('sha256');
    let sizeBytes = 0;
    let tooLarge = false;

    /**
     * HELD, RATHER THAN CONSTRUCTED INLINE IN THE `pipeline()` CALL, and the reason is a race that
     * leaks disk (found 2026-09-07 by a full-suite run, invisible on a quiet machine).
     *
     * `createWriteStream` opens the file ASYNCHRONOUSLY. An oversized upload throws on the very
     * first chunk — before the open has completed — so the `unlink` in the catch below finds
     * nothing to remove, and the open then lands and creates the `.part` file that was just
     * "cleaned up". Nothing ever removes it.
     *
     * That is not cosmetic. This path is reachable by anyone with an API key, and its own test
     * calls the leak what it is: **a disk-fill primitive.** Send oversized uploads in a loop and
     * every one leaves a file behind.
     *
     * The fix is to wait for the sink to actually close before unlinking. `pipeline` destroys it on
     * error, so `close` is guaranteed to fire — and by then the open has either completed (the file
     * exists and the unlink removes it) or failed (there is nothing to remove).
     */
    const sink = createWriteStream(tmp);

    try {
      await pipeline(
        source,
        async function* (chunks: AsyncIterable<Buffer>) {
          for await (const chunk of chunks) {
            sizeBytes += chunk.length;
            if (sizeBytes > maxBytes) {
              tooLarge = true;
              throw new BlobTooLargeError(maxBytes);
            }
            hash.update(chunk);
            yield chunk;
          }
        },
        sink,
      );
    } catch (err) {
      // Guarded: `once` on a stream that has already closed never resolves, which would turn a
      // rejected upload into a hung request — a considerably worse bug than the one being fixed.
      if (!sink.closed) await once(sink, 'close').catch(() => {});
      await unlink(tmp).catch(() => {});
      throw tooLarge ? new BlobTooLargeError(maxBytes) : err;
    }

    if (sizeBytes === 0) {
      await unlink(tmp).catch(() => {});
      throw new Error('Upload was empty.');
    }

    const sha256 = hash.digest('hex');
    const finalPath = this.pathFor(sha256);
    const existing = await stat(finalPath).catch(() => null);
    if (existing) {
      // Identical bytes by construction — the name is their digest. Drop the copy we just made.
      await unlink(tmp).catch(() => {});
      return { sha256, sizeBytes: existing.size, path: finalPath, created: false };
    }

    await mkdir(join(this.root, sha256.slice(0, 2)), { recursive: true });
    await rename(tmp, finalPath);
    return { sha256, sizeBytes, path: finalPath, created: true };
  }

  /** Size of a stored blob, or null when it is not there. */
  async size(sha256: string): Promise<number | null> {
    const s = await stat(this.pathFor(sha256)).catch(() => null);
    return s ? s.size : null;
  }

  read(sha256: string): ReadStream {
    return createReadStream(this.pathFor(sha256));
  }

  /**
   * Remove a blob. Only safe once no `app_builds` row references the digest — two orgs that upload
   * the same file share one blob, which is the point of addressing it by content.
   */
  async remove(sha256: string): Promise<void> {
    await unlink(this.pathFor(sha256)).catch(() => {});
  }
}

/**
 * One store per root, cached.
 *
 * A single slot keyed on the last root was correct while `APP_STORE_DIR` was the only caller. There
 * are two roots now — apps and artifacts (`ARTIFACT_DIR`) — and a one-slot cache alternating
 * between them evicts on every call, so the cache stops being one. A Map is the same code with the
 * bug removed; `AppStore` holds no state beyond its root, so this is about allocation, not
 * correctness.
 */
const stores = new Map<string, AppStore>();

/** The process-wide store for a root. See `config.ts` for why production must set the directories. */
export function appStore(root: string): AppStore {
  let s = stores.get(root);
  if (!s) { s = new AppStore(root); stores.set(root, s); }
  return s;
}
