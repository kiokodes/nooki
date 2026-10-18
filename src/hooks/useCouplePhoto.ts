import { useCallback, useEffect, useRef, useState } from 'react';
import {
  fetchCouplePhoto,
  fetchCouplePhotoUrl,
  subscribeToCouplePhoto,
  uploadCouplePhoto,
  type CouplePhotoChannel,
} from '../lib/couplePhotoService';
import type { CouplePhoto } from '../types/database';

interface UseCouplePhotoOptions {
  /** The shared couple, or null while the account is still unpaired. */
  coupleId: string | null;
  /** The signed-in account (the one framing or replacing the picture). */
  userId: string | null;
}

export interface CouplePhotoState {
  /** The couple's framed picture row, or null before the first one is framed. */
  photo: CouplePhoto | null;
  /** A short-lived signed URL for the framed bytes, ready for an <img>. */
  url: string | null;
  /** True while the first read is in flight. */
  loading: boolean;
  /** True while a picture is being resized, uploaded and framed. */
  busy: boolean;
  /** A sentence from an upload that was refused; cleared by the next attempt. */
  error: string | null;
  /** Resizes, uploads and frames the chosen picture. False when it was refused. */
  upload: (file: Blob) => Promise<boolean>;
}

/**
 * The couple's framed picture for the Home nook.
 *
 * One picture per couple, standing in the frame on both phones. The row is read
 * once on load and then kept live by the `couple_photo` realtime channel, so a
 * picture framed on one phone appears on the other without a refresh — and the
 * upload path itself moves the row only after the new bytes are safely in the
 * private bucket (see src/lib/couplePhotoService.ts).
 */
export function useCouplePhoto({ coupleId, userId }: UseCouplePhotoOptions): CouplePhotoState {
  const [photo, setPhoto] = useState<CouplePhoto | null>(null);
  const [url, setUrl] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<{ scope: string; message: string } | null>(null);
  // The row the upload path replaces, read through a ref so `upload` never goes
  // stale and never re-subscribes the realtime channel.
  const photoRef = useRef<CouplePhoto | null>(null);

  const applyPhoto = useCallback((next: CouplePhoto | null) => {
    photoRef.current = next;
    setPhoto(next);
    if (!next) {
      setUrl(null);
      return;
    }
    void (async () => {
      try {
        setUrl(await fetchCouplePhotoUrl(next.file_path));
      } catch {
        // The row is still the truth; the frame simply waits for the next chance
        // to open it (a retry arrives with the next realtime event or app load).
        setUrl(null);
      }
    })();
  }, []);

  // Read the frame once per couple. A different couple starts from nothing.
  useEffect(() => {
    if (!coupleId) {
      photoRef.current = null;
      setPhoto(null);
      setUrl(null);
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    void (async () => {
      try {
        const row = await fetchCouplePhoto(coupleId);
        if (cancelled) return;
        applyPhoto(row);
      } catch (error) {
        if (cancelled) return;
        setFailure({
          scope: coupleId,
          message: error instanceof Error ? error.message : 'The picture could not be opened.',
        });
        photoRef.current = null;
        setPhoto(null);
        setUrl(null);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [coupleId, applyPhoto]);

  // Keep the frame live: a picture framed on the other phone replaces this one.
  useEffect(() => {
    if (!coupleId) return;
    let channel: CouplePhotoChannel | null = null;
    try {
      channel = subscribeToCouplePhoto(coupleId, {
        onPhotoChanged: (next) => {
          // This phone's own upload already applied the same row.
          if (next && photoRef.current?.file_path === next.file_path) return;
          applyPhoto(next);
        },
      });
    } catch {
      // Without the channel the frame still shows what it read on load.
    }
    return () => channel?.close();
  }, [coupleId, applyPhoto]);

  const upload = useCallback(async (file: Blob): Promise<boolean> => {
    if (!coupleId || !userId) return false;
    setBusy(true);
    setFailure(null);
    try {
      const row = await uploadCouplePhoto({
        coupleId,
        userId,
        file,
        previousPath: photoRef.current?.file_path ?? null,
      });
      applyPhoto(row);
      return true;
    } catch (error) {
      setFailure({
        scope: coupleId,
        message: error instanceof Error ? error.message : 'The picture could not be framed.',
      });
      return false;
    } finally {
      setBusy(false);
    }
  }, [coupleId, userId, applyPhoto]);

  // Errors are read the same way the frame is: only by the couple they belong to.
  const error = failure && failure.scope === coupleId ? failure.message : null;

  return { photo, url, loading, busy, error, upload };
}
