import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { tokens } from '../../tokens/designTokens';

/**
 * The "fit it to the frame" step between choosing a picture and framing it.
 *
 * A photo straight from the camera roll is almost never the shape of the frame's
 * mat window, and object-fit: cover would quietly crop it on its own — centred on
 * nobody's choice. So the chosen picture opens here first, in a crop stage locked
 * to the displayed photo window's measured aspect (see NookPhotoFrame):
 * drag to position, slide to zoom, then "Frame picture". Escape, Cancel or a tap
 * on the backdrop steps out without uploading a single byte.
 *
 * The crop maths lives in the exported pure helpers below so it can be tested
 * without a canvas. The crop itself is drawn on a canvas at confirm time; where a
 * canvas or a decodable preview is missing (very old browsers, the test DOM), the
 * original file travels on untouched rather than blocking the couple's picture.
 */

/** The crop window keeps this much of the stage for itself. */
const STAGE_FIT = 0.92;

/** How far the picture may be zoomed past covering the window. */
const MAX_ZOOM = 6;

/** The framed output never needs more than this on its long edge (see PHOTO_MAX_EDGE). */
const OUTPUT_MAX_EDGE = 1600;

export interface PhotoCropDialogProps {
  /** The picture the couple just chose, before anything is uploaded. */
  file: Blob;
  /** The displayed photo window's aspect (width ÷ height), so the crop is exactly what fits. */
  aspect: number;
  /** The fitted picture, as a JPEG file ready to upload. */
  onCropped: (file: File) => void;
  /** Steps out without uploading anything. */
  onCancel: () => void;
}

/** The largest crop window of `aspect` that fits comfortably inside the stage. */
export function cropWindowSize(
  stageW: number,
  stageH: number,
  aspect: number,
): { w: number; h: number } {
  const w = Math.min(stageW * STAGE_FIT, stageH * STAGE_FIT * aspect);
  return { w, h: w / aspect };
}

/** The scale at which the whole picture just covers the crop window. */
export function coverScale(
  imgW: number,
  imgH: number,
  winW: number,
  winH: number,
): number {
  if (!imgW || !imgH || !winW || !winH) return 1;
  return Math.max(winW / imgW, winH / imgH);
}

/** Keeps the window covered: the picture can slide only until its edge meets it. */
export function clampOffset(
  imgW: number,
  imgH: number,
  winW: number,
  winH: number,
  scale: number,
  ox: number,
  oy: number,
): { ox: number; oy: number } {
  const maxX = Math.max(0, (imgW * scale - winW) / 2);
  const maxY = Math.max(0, (imgH * scale - winH) / 2);
  return {
    ox: Math.min(maxX, Math.max(-maxX, ox)),
    oy: Math.min(maxY, Math.max(-maxY, oy)),
  };
}

/**
 * The crop window, mapped back into the picture's own pixels. The window sits at
 * the centre of the stage and the picture is offset by (ox, oy) display pixels, so
 * the window's centre in source pixels is the picture's centre minus ox/scale.
 */
export function cropRectInSource(
  imgW: number,
  imgH: number,
  winW: number,
  winH: number,
  scale: number,
  ox: number,
  oy: number,
): { sx: number; sy: number; sw: number; sh: number } {
  const cx = imgW / 2 - ox / scale;
  const cy = imgH / 2 - oy / scale;
  const sw = winW / scale;
  const sh = winH / scale;
  return { sx: cx - sw / 2, sy: cy - sh / 2, sw, sh };
}

/** The framed output size: the crop's own shape, capped on its long edge. */
export function outputSize(sw: number, sh: number): { w: number; h: number } {
  const factor = Math.min(1, OUTPUT_MAX_EDGE / Math.max(sw, sh));
  return { w: Math.max(1, Math.round(sw * factor)), h: Math.max(1, Math.round(sh * factor)) };
}

type Preview =
  | { state: 'decoding' }
  | { state: 'ready'; src: string; width: number; height: number; image: HTMLImageElement }
  | { state: 'unpreviewable' };

export const PhotoCropDialog: React.FC<PhotoCropDialogProps> = ({
  file,
  aspect,
  onCropped,
  onCancel,
}) => {
  const [preview, setPreview] = useState<Preview>({ state: 'decoding' });
  const [zoom, setZoom] = useState(1);
  const [offset, setOffset] = useState({ ox: 0, oy: 0 });
  const [stageSize, setStageSize] = useState({ w: 320, h: 300 });
  const stageRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<{ pointerId: number; startX: number; startY: number; ox: number; oy: number } | null>(null);

  // A narrowed copy of the preview, so the maths and the JSX read one shape.
  const readyPreview = preview.state === 'ready' ? preview : null;

  // Measure the stage for the crop maths (a non-layout DOM, like the test one,
  // simply keeps the default size).
  useLayoutEffect(() => {
    const measure = () => {
      const el = stageRef.current;
      if (!el) return;
      const w = el.clientWidth;
      const h = el.clientHeight;
      if (w > 0 && h > 0) setStageSize({ w, h });
    };
    measure();
    if (typeof window === 'undefined' || typeof window.addEventListener !== 'function') return undefined;
    window.addEventListener('resize', measure);
    return () => window.removeEventListener('resize', measure);
  }, []);

  // Decode the chosen picture for the stage. Without object URLs (or when the
  // format will not preview) the picture can still be framed as-is.
  useEffect(() => {
    let revoked = false;
    let url: string | null = null;
    setPreview({ state: 'decoding' });
    if (
      typeof window === 'undefined'
      || typeof Image === 'undefined'
      || typeof URL === 'undefined'
      || typeof URL.createObjectURL !== 'function'
    ) {
      setPreview({ state: 'unpreviewable' });
      return undefined;
    }
    try {
      url = URL.createObjectURL(file);
    } catch {
      setPreview({ state: 'unpreviewable' });
      return undefined;
    }
    const image = new Image();
    image.onload = () => {
      if (revoked) return;
      if (!image.naturalWidth || !image.naturalHeight) {
        setPreview({ state: 'unpreviewable' });
        return;
      }
      setPreview({
        state: 'ready',
        src: url as string,
        width: image.naturalWidth,
        height: image.naturalHeight,
        image,
      });
    };
    image.onerror = () => {
      if (!revoked) setPreview({ state: 'unpreviewable' });
    };
    image.src = url;
    return () => {
      revoked = true;
      if (url && typeof URL.revokeObjectURL === 'function') URL.revokeObjectURL(url);
    };
  }, [file]);

  // Reset the framing whenever a new picture arrives.
  useEffect(() => {
    setZoom(1);
    setOffset({ ox: 0, oy: 0 });
  }, [file]);

  // Escape steps out without uploading anything, exactly like the calendar modal.
  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.addEventListener !== 'function') return undefined;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onCancel();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onCancel]);

  const cropWin = cropWindowSize(stageSize.w, stageSize.h, aspect);
  const scale = readyPreview
    ? coverScale(readyPreview.width, readyPreview.height, cropWin.w, cropWin.h) * zoom
    : 1;

  const applyOffset = useCallback((ox: number, oy: number) => {
    if (!readyPreview) return;
    setOffset(clampOffset(readyPreview.width, readyPreview.height, cropWin.w, cropWin.h, scale, ox, oy));
  }, [readyPreview, cropWin.w, cropWin.h, scale]);

  const handleZoom = (nextZoom: number) => {
    const clamped = Math.min(MAX_ZOOM, Math.max(1, nextZoom));
    setZoom(clamped);
    if (!readyPreview) return;
    const nextScale = coverScale(readyPreview.width, readyPreview.height, cropWin.w, cropWin.h) * clamped;
    setOffset((current) => clampOffset(
      readyPreview.width,
      readyPreview.height,
      cropWin.w,
      cropWin.h,
      nextScale,
      current.ox,
      current.oy,
    ));
  };

  const handlePointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    if (!readyPreview) return;
    dragRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      ox: offset.ox,
      oy: offset.oy,
    };
    try {
      event.currentTarget.setPointerCapture(event.pointerId);
    } catch {
      // Pointer capture is a convenience, not a requirement.
    }
  };

  const handlePointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    applyOffset(
      drag.ox + (event.clientX - drag.startX),
      drag.oy + (event.clientY - drag.startY),
    );
  };

  const endDrag = (event: React.PointerEvent<HTMLDivElement>) => {
    if (dragRef.current?.pointerId === event.pointerId) dragRef.current = null;
  };

  /** Where a canvas (or a preview) is missing, the original travels on untouched. */
  const passthrough = (): File => {
    // File-like (a name and a type) is returned as-is: realms differ between the
    // app and its test DOM, so instanceof would needlessly rewrap a real File.
    const maybe = file as Partial<File>;
    if (maybe && typeof maybe.name === 'string' && typeof maybe.type === 'string') return file as File;
    return new File([file], 'couple-picture', { type: file.type || 'image/jpeg' });
  };

  const handleConfirm = () => {
    if (!readyPreview || typeof document === 'undefined') {
      onCropped(passthrough());
      return;
    }
    const rect = cropRectInSource(
      readyPreview.width,
      readyPreview.height,
      cropWin.w,
      cropWin.h,
      scale,
      offset.ox,
      offset.oy,
    );
    if (!Number.isFinite(rect.sx) || !Number.isFinite(rect.sy) || rect.sw <= 0 || rect.sh <= 0) {
      onCropped(passthrough());
      return;
    }
    const out = outputSize(rect.sw, rect.sh);
    const canvas = document.createElement('canvas');
    canvas.width = out.w;
    canvas.height = out.h;
    const ctx = canvas.getContext('2d');
    if (!ctx) {
      onCropped(passthrough());
      return;
    }
    ctx.drawImage(readyPreview.image, rect.sx, rect.sy, rect.sw, rect.sh, 0, 0, out.w, out.h);
    canvas.toBlob((blob) => {
      if (blob && blob.size > 0) {
        onCropped(new File([blob], 'couple-picture.jpg', { type: 'image/jpeg' }));
      } else {
        onCropped(passthrough());
      }
    }, 'image/jpeg', 0.92);
  };

  return (
    <div
      data-component="photo-crop-dialog"
      role="dialog"
      aria-modal="true"
      aria-label="Fit the picture to the frame"
      onClick={(event) => {
        if (event.target === event.currentTarget) onCancel();
      }}
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 60,
        background: 'rgba(37,28,24,0.45)',
        backdropFilter: 'blur(2px)',
        WebkitBackdropFilter: 'blur(2px)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: '16px',
      }}
    >
      <div
        data-crop-card
        style={{
          width: 'min(420px, 100%)',
          backgroundColor: tokens.colors.bgSurface,
          borderRadius: tokens.radii.card,
          boxShadow: tokens.shadows.card,
          padding: '18px 16px 16px 16px',
          display: 'flex',
          flexDirection: 'column',
          gap: '14px',
        }}
      >
        <div style={{ textAlign: 'center' }}>
          <div
            style={{
              fontFamily: tokens.typography.fontFamily,
              fontSize: '15px',
              fontWeight: 800,
              color: tokens.colors.textPrimary,
            }}
          >
            Fit it to the frame
          </div>
          <div
            style={{
              fontFamily: tokens.typography.fontFamily,
              fontSize: '10.5px',
              fontWeight: 600,
              color: tokens.colors.textMuted,
              marginTop: '2px',
            }}
          >
            {readyPreview ? 'Drag to position · slide to zoom' : 'Opening your picture…'}
          </div>
        </div>

        {/* The crop stage: the window sits at its centre, the picture behind it. */}
        <div
          ref={stageRef}
          data-crop-stage
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={endDrag}
          onPointerCancel={endDrag}
          style={{
            position: 'relative',
            width: '100%',
            height: 'min(46vh, 320px)',
            borderRadius: tokens.radii.md,
            backgroundColor: '#F7F2E9',
            overflow: 'hidden',
            touchAction: 'none',
            cursor: readyPreview ? 'grab' : 'default',
            userSelect: 'none',
            WebkitUserSelect: 'none',
          }}
        >
          {readyPreview && (
            <img
              data-crop-image
              src={readyPreview.src}
              alt=""
              draggable={false}
              style={{
                position: 'absolute',
                left: '50%',
                top: '50%',
                width: readyPreview.width * scale,
                height: readyPreview.height * scale,
                maxWidth: 'none',
                maxHeight: 'none',
                transform: `translate(calc(-50% + ${offset.ox}px), calc(-50% + ${offset.oy}px))`,
                transformOrigin: 'center',
                pointerEvents: 'none',
              }}
            />
          )}

          {/* The mat window itself: exactly the shape of the frame's opening. */}
          <div
            data-crop-window
            aria-hidden="true"
            style={{
              position: 'absolute',
              left: '50%',
              top: '50%',
              width: cropWin.w,
              height: cropWin.h,
              transform: 'translate(-50%, -50%)',
              borderRadius: '8px',
              border: '2px solid rgba(255,253,246,0.95)',
              boxShadow: '0 0 0 9999px rgba(37,28,24,0.55)',
              pointerEvents: 'none',
            }}
          />

          {!readyPreview && (
            <div
              data-crop-notice
              style={{
                position: 'absolute',
                inset: 0,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                padding: '18px',
                textAlign: 'center',
                fontFamily: tokens.typography.fontFamily,
                fontSize: '11px',
                fontWeight: 600,
                lineHeight: 1.5,
                color: tokens.colors.textSecondary,
              }}
            >
              {preview.state === 'unpreviewable'
                ? 'This picture can’t be previewed here, but it can still be framed as-is.'
                : 'Opening your picture…'}
            </div>
          )}
        </div>

        {/* Zoom: one slider, keyboard-reachable, thumb-friendly on a phone. */}
        <div style={{ display: 'flex', alignItems: 'center', gap: '10px', padding: '0 2px' }}>
          <span aria-hidden="true" style={{ fontSize: '12px', color: tokens.colors.textMuted }}>−</span>
          <input
            data-crop-slider
            type="range"
            min={1}
            max={MAX_ZOOM}
            step={0.01}
            value={zoom}
            aria-label="Zoom the picture"
            disabled={!readyPreview}
            onChange={(event) => handleZoom(Number(event.target.value))}
            style={{ flex: 1, accentColor: tokens.colors.primaryPinkDeep }}
          />
          <span aria-hidden="true" style={{ fontSize: '12px', color: tokens.colors.textMuted }}>+</span>
        </div>

        <div style={{ display: 'flex', gap: '10px' }}>
          <button
            type="button"
            data-action="crop-cancel"
            onClick={onCancel}
            style={{
              flex: 1,
              padding: '11px 14px',
              border: 'none',
              borderRadius: tokens.radii.pill,
              backgroundColor: tokens.colors.bgSurfaceSubtle,
              color: tokens.colors.textSecondary,
              fontFamily: tokens.typography.fontFamily,
              fontSize: '12.5px',
              fontWeight: 700,
              cursor: 'pointer',
              WebkitTapHighlightColor: 'transparent',
            }}
          >
            Cancel
          </button>
          <button
            type="button"
            data-action="crop-confirm"
            onClick={handleConfirm}
            style={{
              flex: 1.4,
              padding: '11px 14px',
              border: 'none',
              borderRadius: tokens.radii.pill,
              backgroundColor: tokens.colors.primaryPinkDeep,
              color: tokens.colors.textWhite,
              fontFamily: tokens.typography.fontFamily,
              fontSize: '12.5px',
              fontWeight: 800,
              cursor: 'pointer',
              WebkitTapHighlightColor: 'transparent',
            }}
          >
            Frame picture
          </button>
        </div>
      </div>
    </div>
  );
};

export default PhotoCropDialog;
