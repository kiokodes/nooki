import React, { useRef, useState } from 'react';
import { Camera, Heart } from 'lucide-react';
import { tokens } from '../../tokens/designTokens';
import { PhotoCropDialog } from './PhotoCropDialog';

/** Fallback for an unmeasurable window (e.g. a hidden view or an older browser). */
export const PHOTO_WINDOW_ASPECT = 67 / 47;

export interface NookPhotoFrameProps {
  /**
   * A short-lived signed URL for the couple's framed picture, or null before the
   * first one is framed (the frame then simply invites the couple to upload it).
   */
  src: string | null;
  /** True while a chosen picture is being resized, uploaded and framed. */
  uploading?: boolean;
  /** A sentence from an upload the phone refused; cleared by the next attempt. */
  error?: string | null;
  /** Called with the chosen file. The frame handles picking and confirming itself. */
  onUpload: (file: File) => void;
  /** Alt text for the framed picture. Defaults to a warm "us". */
  altText?: string;
}

/**
 * The couple's picture fills the nook below its caption row. A thin coloured
 * border and one heart per partner replace the old wooden frame and bow.
 * Upload/replace stays a single control, with deliberate replacement and a
 * crop step measured from the actual responsive photo window.
 */
export const NookPhotoFrame: React.FC<NookPhotoFrameProps> = ({
  src,
  uploading = false,
  error = null,
  onUpload,
  altText,
}) => {
  const inputRef = useRef<HTMLInputElement>(null);
  const windowRef = useRef<HTMLDivElement>(null);
  const [cropAspect, setCropAspect] = useState(PHOTO_WINDOW_ASPECT);
  // The picture chosen but not yet fitted: it waits in the crop step, and nothing
  // uploads until the couple frames it (or steps out, which uploads nothing).
  const [pendingFile, setPendingFile] = useState<File | null>(null);
  const hasPhoto = Boolean(src);

  const handleFrameTap = () => {
    if (uploading) return;
    if (hasPhoto) {
      // A picture already stands in the frame; replacing it is a deliberate act.
      const confirmReplace = typeof window !== 'undefined' && typeof window.confirm === 'function'
        ? window.confirm('Replace the picture in the frame?')
        : true;
      if (!confirmReplace) return;
    }
    inputRef.current?.click();
  };

  const handleFileChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    // The value resets so the same picture can be re-picked right away (a retry).
    event.target.value = '';
    if (!file) return;
    const window = windowRef.current?.getBoundingClientRect();
    setCropAspect(window && window.width > 0 && window.height > 0
      ? window.width / window.height
      : PHOTO_WINDOW_ASPECT);
    setPendingFile(file);
  };

  return (
    <div
      data-component="nook-photo-frame"
      data-has-photo={hasPhoto ? 'true' : 'false'}
      data-uploading={uploading ? 'true' : 'false'}
      style={{
        position: 'relative',
        width: '100%',
        flex: 1,
        minHeight: 0,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
      }}
    >
      <div
        data-nooki-frame-stand
        className={`nooki-photo-frame-stand${uploading ? ' nooki-photo-frame-busy' : ''}`}
        style={{
          position: 'relative',
          width: '100%',
          flex: 1,
          minHeight: 0,
        }}
      >
        {/* One control for the whole frame: upload when empty, replace when framed. */}
        <button
          type="button"
          data-nooki-frame-button
          className="nooki-photo-frame-button"
          aria-label={hasPhoto ? 'Replace the picture in the frame' : 'Upload your couple picture'}
          aria-busy={uploading || undefined}
          onClick={handleFrameTap}
          style={{
            position: 'absolute',
            inset: 0,
            margin: 0,
            padding: 0,
            background: 'transparent',
            border: `5px solid ${tokens.colors.primaryPink}`,
            boxSizing: 'border-box',
            borderRadius: '16px',
            cursor: 'pointer',
            WebkitTapHighlightColor: 'transparent',
            touchAction: 'manipulation',
          }}
        >
          <div
            ref={windowRef}
            data-nooki-frame-window
            className="nooki-photo-frame-window"
            style={{
              position: 'absolute',
              inset: 0,
              overflow: 'hidden',
              borderRadius: '11px',
            }}
          >
            {hasPhoto ? (
              <img
                data-nooki-photo
                src={src ?? undefined}
                alt={altText ?? 'Us — our favourite picture together'}
                draggable={false}
                style={{
                  display: 'block',
                  width: '100%',
                  height: '100%',
                  objectFit: 'cover',
                  userSelect: 'none',
                  WebkitUserSelect: 'none',
                }}
              />
            ) : (
              <div
                data-nooki-frame-prompt
                style={{
                  width: '100%',
                  height: '100%',
                  display: 'flex',
                  flexDirection: 'column',
                  alignItems: 'center',
                  justifyContent: 'center',
                  gap: '3px',
                  padding: '6px',
                  textAlign: 'center',
                  background:
                    'linear-gradient(160deg, #FCE7F3 0%, #FFFDF6 46%, #ECFDF5 100%)',
                }}
              >
                <Camera size={28} strokeWidth={2.2} color={tokens.colors.primaryPinkDeep} />
                <span
                  style={{
                    fontSize: '13px',
                    fontWeight: 800,
                    lineHeight: 1.3,
                    color: tokens.colors.textPrimary,
                  }}
                >
                  Upload your couple picture
                </span>
                <span
                  style={{
                    fontSize: '11px',
                    fontWeight: 600,
                    lineHeight: 1.35,
                    color: tokens.colors.textMuted,
                  }}
                >
                  your favourite photo of the two of you
                </span>
              </div>
            )}

            {uploading && (
              <div
                data-nooki-frame-busy
                style={{
                  position: 'absolute',
                  inset: 0,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  padding: '6px',
                  textAlign: 'center',
                  background: 'rgba(255,251,242,0.86)',
                  fontSize: '12px',
                  fontWeight: 700,
                  lineHeight: 1.35,
                  color: tokens.colors.textSecondary,
                }}
              >
                Framing your picture…
              </div>
            )}
          </div>
          {(['pink', 'green'] as const).map((color) => (
            <Heart
              key={color}
              data-nooki-photo-heart={color}
              aria-hidden="true"
              size={28}
              fill={color === 'pink' ? tokens.colors.primaryPink : tokens.colors.primaryGreen}
              stroke={color === 'pink' ? tokens.colors.primaryPinkDeep : tokens.colors.primaryGreenDeep}
              strokeWidth={1.8}
              style={{
                position: 'absolute',
                ...(color === 'pink' ? { top: '12px', left: '12px' } : { bottom: '12px', right: '12px' }),
                transform: `rotate(${color === 'pink' ? '-14' : '14'}deg)`,
                filter: 'drop-shadow(0 1px 2px rgba(0,0,0,0.18))',
                pointerEvents: 'none',
              }}
            />
          ))}
        </button>
      </div>

      {error && (
        <span
          data-nooki-frame-error
          role="status"
          style={{
            position: 'absolute',
            bottom: '8px',
            left: '12px',
            right: '12px',
            textAlign: 'center',
            background: 'rgba(255,251,242,0.94)',
            borderRadius: '6px',
            padding: '4px 8px',
            fontSize: '11px',
            fontWeight: 600,
            lineHeight: 1.35,
            color: tokens.colors.textMuted,
            pointerEvents: 'none',
          }}
        >
          {error}
        </span>
      )}

      <input
        ref={inputRef}
        type="file"
        accept="image/*"
        aria-hidden="true"
        tabIndex={-1}
        onChange={handleFileChange}
        style={{ display: 'none' }}
      />

      {pendingFile && (
        <PhotoCropDialog
          file={pendingFile}
          aspect={cropAspect}
          onCropped={(fitted) => {
            setPendingFile(null);
            onUpload(fitted);
          }}
          onCancel={() => setPendingFile(null)}
        />
      )}
    </div>
  );
};

export default NookPhotoFrame;
