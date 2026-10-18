import React, { useRef, useState } from 'react';
import { Camera } from 'lucide-react';
import { tokens } from '../../tokens/designTokens';
import { PhotoCropDialog } from './PhotoCropDialog';

/**
 * The frame's mat window, as width ÷ height. The window in the frame SVG below is
 * 134×94 in a 200×160 viewBox (inset "20.6% 16.5%"), which is 67/47 — keep the two
 * in step so a picture fitted in the crop step is exactly the picture framed.
 */
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
 * NookPhotoFrame — the couple's own picture, standing in the nook.
 *
 * A gift-wrapped frame (honey wood, stitched mat, pink-and-green ribbon bow — the
 * same duo as the racing splash dots) replaces the drawn companions in the Home
 * nook. A real photo of the couple is the higher form of personalisation: opening
 * the app shows the two of you, from when you were last together or simply your
 * favourite picture. Before one is framed, the window carries a soft prompt to
 * upload it.
 *
 * Rules:
 * 1. The whole frame is one button: upload when empty, replace (behind a confirm)
 *    when a picture already stands in it — replacing is a couple decision, not an
 *    accident waiting for a pocket tap.
 * 2. A chosen picture is never uploaded as-is: it first opens in the "fit it to
 *    the frame" crop step (PhotoCropDialog), locked to the mat window's aspect, so
 *    the couple decides what the frame shows — not a quiet object-fit crop.
 * 3. The picture is displayed exactly inside the mat window (object-fit: cover),
 *    never cropped by the frame or stretched.
 * 4. The frame is the nook's centrepiece but never its only control: the
 *    "I miss you" button and the "Our little nook" caption stay exactly where
 *    they are.
 * 5. The idle sway is restrained (±0.35°, 6s), anchored at the frame's feet, and
 *    honours prefers-reduced-motion (see .nooki-photo-frame-stand in index.css).
 */
export const NookPhotoFrame: React.FC<NookPhotoFrameProps> = ({
  src,
  uploading = false,
  error = null,
  onUpload,
  altText,
}) => {
  const inputRef = useRef<HTMLInputElement>(null);
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
        height: '100%',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'flex-end',
        paddingBottom: '12px',
      }}
    >
      <div
        data-nooki-frame-stand
        className={`nooki-photo-frame-stand${uploading ? ' nooki-photo-frame-busy' : ''}`}
        style={{
          position: 'relative',
          height: 'min(84%, 208px)',
          aspectRatio: '5 / 4',
          maxWidth: '82%',
        }}
      >
        {/* Soft shadow the frame stands in — the nook's floor. */}
        <div
          aria-hidden="true"
          style={{
            position: 'absolute',
            left: '6%',
            right: '6%',
            bottom: '-8px',
            height: '14px',
            borderRadius: '50%',
            background:
              'radial-gradient(50% 50% at 50% 50%, rgba(78,56,44,0.20) 0%, rgba(78,56,44,0) 72%)',
            pointerEvents: 'none',
          }}
        />

        {/* The gift-wrapped frame itself: honey wood, stitched mat, corner hearts. */}
        <svg
          aria-hidden="true"
          viewBox="0 0 200 160"
          preserveAspectRatio="none"
          style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', display: 'block' }}
        >
          <rect x="3" y="3" width="194" height="154" rx="16" fill="#E9BE88" stroke="#C68B55" strokeWidth="2.5" />
          <rect
            x="12" y="12" width="176" height="136" rx="10"
            fill="none" stroke="rgba(140,95,55,0.45)" strokeWidth="2"
            strokeDasharray="0.5 6" strokeLinecap="round"
          />
          <rect x="26" y="26" width="148" height="108" rx="8" fill="#FFFDF6" stroke="#EFE3CE" strokeWidth="1" />
          {/* One heart per partner, in the two brand colours, pinned to the wood. */}
          <path
            d="M15.5 9 C15.5 7.2 17.8 6.2 19.2 7.5 C20.6 6.2 22.9 7.2 22.9 9 C22.9 11.4 19.2 13.8 19.2 13.8 C19.2 13.8 15.5 11.4 15.5 9 Z"
            fill={tokens.colors.primaryPink} stroke={tokens.colors.primaryPinkDeep} strokeWidth="1.1"
          />
          <path
            d="M177.1 146.2 C177.1 144.4 179.4 143.4 180.8 144.7 C182.2 143.4 184.5 144.4 184.5 146.2 C184.5 148.6 180.8 151 180.8 151 C180.8 151 177.1 148.6 177.1 146.2 Z"
            fill={tokens.colors.primaryGreen} stroke={tokens.colors.primaryGreenDeep} strokeWidth="1.1"
          />
        </svg>

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
            border: 'none',
            borderRadius: '16px',
            cursor: 'pointer',
            WebkitTapHighlightColor: 'transparent',
            touchAction: 'manipulation',
          }}
        >
          <div
            data-nooki-frame-window
            className="nooki-photo-frame-window"
            style={{
              position: 'absolute',
              inset: '20.6% 16.5%',
              overflow: 'hidden',
              borderRadius: '5px',
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
                <Camera size={17} strokeWidth={2.2} color={tokens.colors.primaryPinkDeep} />
                <span
                  style={{
                    fontSize: '9px',
                    fontWeight: 800,
                    lineHeight: 1.3,
                    color: tokens.colors.textPrimary,
                  }}
                >
                  Upload your couple picture
                </span>
                <span
                  style={{
                    fontSize: '7.5px',
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
                  fontSize: '8px',
                  fontWeight: 700,
                  lineHeight: 1.35,
                  color: tokens.colors.textSecondary,
                }}
              >
                Framing your picture…
              </div>
            )}
          </div>
        </button>

        {/* The ribbon bow: one pink loop, one green loop — the two of you, tied. */}
        <svg
          aria-hidden="true"
          viewBox="0 0 120 54"
          style={{
            position: 'absolute',
            top: '-12%',
            left: '50%',
            transform: 'translateX(-50%)',
            width: '54%',
            overflow: 'visible',
            display: 'block',
            pointerEvents: 'none',
          }}
        >
          <path
            d="M56 22 C46 30 38 40 34 50 L46 52 C50 43 56 33 61 26 Z"
            fill="#FBCFE8" stroke={tokens.colors.primaryPinkDeep} strokeWidth="1.4" strokeLinejoin="round"
          />
          <path
            d="M64 22 C74 30 82 40 86 50 L74 52 C70 43 64 33 59 26 Z"
            fill="#BBF7D9" stroke={tokens.colors.primaryGreenDeep} strokeWidth="1.4" strokeLinejoin="round"
          />
          <path
            d="M58 18 C44 2 26 4 26 14 C26 24 44 25 58 19 Z"
            fill={tokens.colors.primaryPink} stroke={tokens.colors.primaryPinkDeep} strokeWidth="1.6" strokeLinejoin="round"
          />
          <path
            d="M62 18 C76 2 94 4 94 14 C94 24 76 25 62 19 Z"
            fill={tokens.colors.primaryGreen} stroke={tokens.colors.primaryGreenDeep} strokeWidth="1.6" strokeLinejoin="round"
          />
          <rect
            x="52" y="11" width="16" height="15" rx="5"
            fill="#FFF3DE" stroke="#C9A97E" strokeWidth="1.5"
          />
        </svg>
      </div>

      {error && (
        <span
          data-nooki-frame-error
          role="status"
          style={{
            position: 'absolute',
            bottom: '1px',
            left: '12px',
            right: '12px',
            textAlign: 'center',
            fontSize: '8.5px',
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
          aspect={PHOTO_WINDOW_ASPECT}
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
