import { requireSupabase } from './supabaseClient';
import { describeDatabaseError } from './authService';
import type { CouplePhoto } from '../types/database';

/**
 * Storage and data for the couple picture frame in the Home nook.
 *
 * Everything is couple-scoped and the database is what keeps it that way (see
 * `couple_photo` in supabase/migrations/202610180002_couple_photo.sql). The file
 * itself lives in the private `couple-photos` bucket under
 * `photos/{couple_id}/{photo_id}.jpg` — the folder name IS the couple id, which is
 * what the storage policies check — and is opened only through short-lived signed
 * URLs. There is deliberately no public link: a picture is never shareable outside
 * the couple.
 *
 * The rules the app keeps even where a bug might not:
 *   - one picture per couple, ever (the couple id is the primary key);
 *   - either partner may replace it, but the row's couple can never move (a
 *     database trigger refuses);
 *   - the phone resizes the picture to a 1600px JPEG before a single byte leaves
 *     it, so weak mobile data never carries a 12 MB camera roll original;
 *   - a replace uploads the new file first, then moves the row, then deletes the
 *     old file — so the frame never points at a file that is not there yet, and a
 *     failed replace leaves the old picture standing.
 */

/** The private bucket holding the couple's picture files. */
export const COUPLE_PHOTOS_BUCKET = 'couple-photos';

/** Signed URLs die quickly; the bytes are the browser's to cache after that. */
export const PHOTO_URL_TTL_SECONDS = 60 * 60;

/** The longest edge a framed picture is allowed to keep; the rest is scaled down. */
export const PHOTO_MAX_EDGE = 1600;

/** JPEG quality for the resized upload: photos stay crisp at frame size. */
export const PHOTO_JPEG_QUALITY = 0.86;

/** A camera-roll original larger than this is refused before any processing. */
export const PHOTO_MAX_SOURCE_BYTES = 25 * 1024 * 1024;

export const PHOTO_FILE_HELP = 'Please choose an image file.';

/**
 * The storage path is deterministic — photos/{couple_id}/{photo_id}.jpg — so the
 * file can be uploaded before the row moves, and the RLS folder check always reads
 * the owning couple straight off the object name.
 */
export function photoStoragePath(coupleId: string, photoId: string): string {
  return `photos/${coupleId}/${photoId}.jpg`;
}

/** Only images may be framed; anything else is refused before it uploads. */
export function isPhotoFile(value: Blob): boolean {
  return typeof value?.type === 'string' && value.type.startsWith('image/');
}

function toCouplePhoto(row: Record<string, unknown>): CouplePhoto {
  return {
    couple_id: String(row.couple_id),
    file_path: String(row.file_path ?? ''),
    uploaded_by: row.uploaded_by == null ? null : String(row.uploaded_by),
    created_at: String(row.created_at ?? ''),
    updated_at: String(row.updated_at ?? ''),
  };
}

/* -------------------------------------------------------------------------
   Storage: private bucket, short-lived signed URLs, no public link.
   ---------------------------------------------------------------------- */

function storageApi() {
  const client = requireSupabase() as unknown as {
    storage?: { from: (bucket: string) => unknown };
  };
  return client.storage ?? null;
}

/** Uploads the bytes. Returns nothing on success and throws a readable error on failure. */
async function uploadPhotoFile(filePath: string, file: Blob): Promise<void> {
  const storage = storageApi();
  if (!storage) throw new Error('Photo storage is unavailable right now.');
  const bucket = storage.from(COUPLE_PHOTOS_BUCKET) as {
    upload: (
      path: string,
      body: Blob,
      options?: { contentType?: string; upsert?: boolean },
    ) => Promise<{ error: { message: string } | null }>;
  };
  const { error } = await bucket.upload(filePath, file, {
    contentType: file.type && file.type.startsWith('image/') ? file.type : 'image/jpeg',
    upsert: true,
  });
  if (error) throw new Error(describeDatabaseError(error));
}

/** Best-effort: a stray file must never fail the flow that superseded it. */
async function removePhotoFile(filePath: string): Promise<void> {
  const storage = storageApi();
  if (!storage || !filePath) return;
  try {
    const bucket = storage.from(COUPLE_PHOTOS_BUCKET) as {
      remove: (paths: string[]) => Promise<{ error: { message: string } | null }>;
    };
    await bucket.remove([filePath]);
  } catch {
    // The file is unreadable to everyone outside the couple whatever happens here.
  }
}

/** A one-hour signed URL — the only way a picture ever leaves the private bucket. */
export async function fetchCouplePhotoUrl(filePath: string): Promise<string> {
  const storage = storageApi();
  if (!storage) throw new Error('Photo storage is unavailable right now.');
  const bucket = storage.from(COUPLE_PHOTOS_BUCKET) as {
    createSignedUrl: (path: string, ttl: number) => Promise<{ data: { signedUrl: string } | null; error: { message: string } | null }>;
  };
  const { data, error } = await bucket.createSignedUrl(filePath, PHOTO_URL_TTL_SECONDS);
  if (error || !data?.signedUrl) {
    throw new Error(error ? describeDatabaseError(error) : 'The picture could not be opened.');
  }
  return data.signedUrl;
}

/* -------------------------------------------------------------------------
   Resizing: the phone does the heavy lifting before anything uploads.
   ---------------------------------------------------------------------- */

type DecodedImage = {
  width: number;
  height: number;
  source: CanvasImageSource;
};

/** Decodes via ImageBitmap (EXIF-aware) when available, else via an HTMLImageElement. */
async function decodeImage(file: Blob): Promise<DecodedImage | null> {
  try {
    if (typeof createImageBitmap === 'function') {
      const bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' } as ImageBitmapOptions);
      return { width: bitmap.width, height: bitmap.height, source: bitmap };
    }
  } catch {
    // Fall through to the <img> path; some browsers refuse exotic formats here.
  }
  if (
    typeof document === 'undefined'
    || typeof Image === 'undefined'
    || typeof URL === 'undefined'
    || typeof URL.createObjectURL !== 'function'
  ) {
    return null;
  }
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    await new Promise<void>((resolve, reject) => {
      img.onload = () => resolve();
      img.onerror = () => reject(new Error('decode failed'));
      img.src = url;
    });
    if (!img.naturalWidth || !img.naturalHeight) return null;
    return { width: img.naturalWidth, height: img.naturalHeight, source: img };
  } catch {
    return null;
  } finally {
    URL.revokeObjectURL(url);
  }
}

/**
 * Resizes the chosen picture to a 1600px JPEG before it leaves the phone. When the
 * browser cannot decode or draw it (or in the test DOM, which has no canvas), the
 * original file is returned unchanged and the upload proceeds with that instead.
 */
export async function preparePhotoForUpload(file: Blob): Promise<Blob> {
  if (file.size > PHOTO_MAX_SOURCE_BYTES) {
    throw new Error('That picture is too large. Please choose one under 25 MB.');
  }
  const image = await decodeImage(file);
  if (!image || !image.width || !image.height) return file;
  const scale = Math.min(1, PHOTO_MAX_EDGE / Math.max(image.width, image.height));
  const targetWidth = Math.max(1, Math.round(image.width * scale));
  const targetHeight = Math.max(1, Math.round(image.height * scale));
  if (typeof document === 'undefined') return file;
  const canvas = document.createElement('canvas');
  canvas.width = targetWidth;
  canvas.height = targetHeight;
  const ctx = canvas.getContext('2d');
  if (!ctx) return file;
  ctx.drawImage(image.source, 0, 0, targetWidth, targetHeight);
  const blob = await new Promise<Blob | null>((resolve) => {
    canvas.toBlob(resolve, 'image/jpeg', PHOTO_JPEG_QUALITY);
  });
  return blob && blob.size > 0 ? blob : file;
}

/* -------------------------------------------------------------------------
   The row: one picture per couple, readable by both, movable by neither.
   ---------------------------------------------------------------------- */

/** The couple's framed picture, or null before the first one is uploaded. */
export async function fetchCouplePhoto(coupleId: string): Promise<CouplePhoto | null> {
  const client = requireSupabase() as unknown as {
    from: (table: string) => {
      select: (columns: string) => {
        eq: (column: string, value: string) => {
          maybeSingle: () => Promise<{ data: Record<string, unknown> | null; error: { message: string } | null }>;
        };
      };
    };
  };
  const { data, error } = await client
    .from('couple_photo')
    .select('couple_id, file_path, uploaded_by, created_at, updated_at')
    .eq('couple_id', coupleId)
    .maybeSingle();
  if (error) throw new Error(describeDatabaseError(error));
  return data ? toCouplePhoto(data) : null;
}

/** Points the couple's one row at its file. Creates the row on the first picture. */
async function upsertCouplePhotoRow(
  coupleId: string,
  userId: string,
  filePath: string,
): Promise<CouplePhoto> {
  const client = requireSupabase() as unknown as {
    from: (table: string) => {
      upsert: (
        row: Record<string, unknown>,
        options?: { onConflict?: string },
      ) => {
        select: () => Promise<{ data: Record<string, unknown>[] | null; error: { message: string } | null }>;
      };
    };
  };
  const { data, error } = await client
    .from('couple_photo')
    .upsert(
      { couple_id: coupleId, file_path: filePath, uploaded_by: userId },
      { onConflict: 'couple_id' },
    )
    .select();
  if (error || !data?.length) {
    throw new Error(error ? describeDatabaseError(error) : 'The picture could not be framed.');
  }
  return toCouplePhoto(data[0]);
}

/**
 * Frames (or replaces) the couple's picture:
 * resize on the phone → upload the new file → move the row → delete the old file.
 * The row only ever moves after the new bytes are safely in the bucket, and the old
 * file only goes once nothing points at it.
 */
export async function uploadCouplePhoto(input: {
  coupleId: string;
  userId: string;
  file: Blob;
  /** The path the frame currently shows, so a replace can tidy up its predecessor. */
  previousPath?: string | null;
}): Promise<CouplePhoto> {
  if (!isPhotoFile(input.file)) throw new Error(PHOTO_FILE_HELP);
  const prepared = await preparePhotoForUpload(input.file);
  const photoId = typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : String(Date.now());
  const filePath = photoStoragePath(input.coupleId, photoId);

  await uploadPhotoFile(filePath, prepared);
  try {
    const row = await upsertCouplePhotoRow(input.coupleId, input.userId, filePath);
    if (input.previousPath && input.previousPath !== filePath) {
      await removePhotoFile(input.previousPath);
    }
    return row;
  } catch (error) {
    // The row still points at the old picture; do not leave the new bytes orphaned.
    await removePhotoFile(filePath);
    throw error;
  }
}

/* -------------------------------------------------------------------------
   Realtime: a picture framed on one phone appears on the other.
   ---------------------------------------------------------------------- */

export interface CouplePhotoSubscriptionHandlers {
  /** Called for any change to this couple's framed picture row. */
  onPhotoChanged: (photo: CouplePhoto | null) => void;
  /** Optional channel status callback, mirroring the other subscriptions. */
  onStatus?: (status: string) => void;
}

export interface CouplePhotoChannel {
  close: () => void;
}

function couplePhotoTopic(coupleId: string): string {
  return `nooki-couple-photo-${coupleId}`;
}

export function subscribeToCouplePhoto(
  coupleId: string,
  handlers: CouplePhotoSubscriptionHandlers,
): CouplePhotoChannel {
  const client = requireSupabase();
  const channel = client.channel(couplePhotoTopic(coupleId), {
    config: { broadcast: { self: false } },
  });

  channel
    .on(
      'postgres_changes',
      { event: '*', schema: 'public', table: 'couple_photo', filter: `couple_id=eq.${coupleId}` },
      (payload: { eventType: string; new: Record<string, unknown> | null; old: Record<string, unknown> | null }) => {
        if (payload.eventType === 'DELETE') {
          handlers.onPhotoChanged(null);
        } else if (payload.new) {
          handlers.onPhotoChanged(toCouplePhoto(payload.new));
        }
      },
    )
    .subscribe((status: string) => handlers.onStatus?.(status));

  return {
    close: () => {
      const removed = client.removeChannel(channel);
      if (removed && typeof removed.catch === 'function') removed.catch(() => {});
    },
  };
}
