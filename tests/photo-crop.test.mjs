import { test } from 'node:test';
import assert from 'node:assert/strict';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { JSDOM } from 'jsdom';
import { createServer } from 'vite';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

test('photo crop: the fit-to-frame maths, and the dialog that uses it', async () => {
  const server = await createServer({ server: { middlewareMode: true, hmr: false, ws: false } });
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>');
  globalThis.window = dom.window;
  globalThis.document = dom.window.document;
  globalThis.HTMLElement = dom.window.HTMLElement;
  globalThis.HTMLImageElement = dom.window.HTMLImageElement;

  const root = createRoot(dom.window.document.getElementById('root'));

  try {
    const {
      PhotoCropDialog,
      cropWindowSize,
      coverScale,
      clampOffset,
      cropRectInSource,
      outputSize,
    } = await server.ssrLoadModule('/src/components/home/PhotoCropDialog.tsx');
    const ASPECT = 67 / 47; // the frame's mat window, from NookPhotoFrame

    // --- The window is the largest of the mat aspect that fits the stage -------------
    const win = cropWindowSize(320, 300, ASPECT);
    assert(Math.abs(win.w - 320 * 0.92) < 1e-9, 'a wide stage gives the window its width');
    assert(Math.abs(win.h - win.w / ASPECT) < 1e-9, 'the window is exactly the mat aspect');
    // A stage wider than the window's aspect limits the window by height instead.
    const wide = cropWindowSize(600, 300, ASPECT);
    assert(Math.abs(wide.h - 300 * 0.92) < 1e-9, 'a wide stage limits the window by height');
    assert(Math.abs(wide.w - wide.h * ASPECT) < 1e-9, 'and the window keeps the mat aspect');

    // --- Cover: the picture just covers the window -----------------------------------
    const s = coverScale(1000, 500, win.w, win.h);
    assert(Math.abs(s - win.h / 500) < 1e-9, 'the shorter side of the picture drives the cover scale');
    assert(1000 * s >= win.w - 1e-9 && 500 * s >= win.h - 1e-9, 'a covered window has no gaps');

    // --- Clamping: the window never slides off the picture ----------------------------
    const loose = clampOffset(1000, 500, win.w, win.h, s, 10000, -10000);
    assert(Math.abs(loose.ox - (1000 * s - win.w) / 2) < 1e-9, 'the x offset stops at the picture\'s edge');
    assert(Math.abs(loose.oy + (500 * s - win.h) / 2) < 1e-9, 'the y offset stops at the picture\'s edge');

    // --- The crop rect maps the window back into the picture's own pixels -------------
    const rect = cropRectInSource(1000, 500, win.w, win.h, s, 0, 0);
    assert(Math.abs(rect.sw - win.w / s) < 1e-6 && Math.abs(rect.sh - win.h / s) < 1e-6,
      'the rect is the window in source pixels');
    assert(rect.sx >= -1e-6 && rect.sy >= -1e-6 && rect.sx + rect.sw <= 1000 + 1e-6 && rect.sy + rect.sh <= 500 + 1e-6,
      'a centred crop stays inside the picture');
    const panned = cropRectInSource(1000, 500, win.w, win.h, s, loose.ox, loose.oy);
    assert(panned.sx >= -1e-6 && panned.sx + panned.sw <= 1000 + 1e-6,
      'a fully panned crop still covers the picture, edge to edge');
    // Zooming in crops a smaller, tighter piece of the same picture.
    const zoomed = cropRectInSource(1000, 500, win.w, win.h, s * 2, 0, 0);
    assert(Math.abs(zoomed.sw - rect.sw / 2) < 1e-6, 'double the scale halves the crop');

    // --- The output keeps the crop's shape and caps the long edge ---------------------
    const out = outputSize(3000, (3000 * 47) / 67);
    assert.equal(out.w, 1600, 'the long edge is capped at 1600');
    assert(Math.abs(out.h - (1600 * 47) / 67) <= 1, 'the output keeps the mat shape');
    const small = outputSize(400, 280);
    assert.equal(small.w, 400, 'a small crop is never scaled up');

    // --- The dialog itself -------------------------------------------------------------
    const cropped = [];
    let cancels = 0;
    const file = new dom.window.File(['us'], 'us.png', { type: 'image/png' });
    await act(async () => {
      root.render(React.createElement(PhotoCropDialog, {
        file,
        aspect: ASPECT,
        onCropped: (f) => cropped.push(f),
        onCancel: () => { cancels += 1; },
      }));
    });

    const dialog = document.querySelector('[data-component="photo-crop-dialog"]');
    assert(dialog, 'the fit-to-frame dialog renders');
    assert.equal(dialog.getAttribute('role'), 'dialog', 'it announces itself as a dialog');
    assert.equal(dialog.getAttribute('aria-modal'), 'true', 'and as modal');
    assert(document.body.textContent.includes('Fit it to the frame'), 'the title says what the step is');
    assert(dialog.querySelector('[data-crop-stage]'), 'the crop stage renders');
    assert(dialog.querySelector('[data-crop-window]'), 'the mat-shaped window renders');
    const stage = dialog.querySelector('[data-crop-stage]');
    const windowEl = dialog.querySelector('[data-crop-window]');
    const windowRatio = Number.parseFloat(windowEl.style.width) / Number.parseFloat(windowEl.style.height);
    assert(Math.abs(windowRatio - ASPECT) < 1e-6, 'the on-screen window is the mat aspect, exactly');

    // This DOM cannot preview the picture (no object URLs), so it says so, keeps the
    // zoom slider off, and still offers to frame the original as-is.
    assert(
      dialog.querySelector('[data-crop-notice]')?.textContent.includes('still be framed as-is'),
      'an unpreviewable picture is explained, not blocked',
    );
    assert.equal(dialog.querySelector('[data-crop-slider]').disabled, true, 'zoom waits for a preview');

    // Escape steps out without uploading anything.
    await act(async () => {
      dom.window.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    assert.equal(cancels, 1, 'Escape cancels the fit');
    assert.equal(cropped.length, 0, 'nothing was framed by an escape');

    // Confirming frames the picture — here as the original, the canvas-less fallback.
    await act(async () => {
      document.querySelector('[data-action="crop-confirm"]').click();
    });
    assert.equal(cropped.length, 1, 'confirm frames the picture');
    assert.equal(cropped[0], file, 'without a canvas the original travels on untouched');

    // The stage is where a finger drags the picture; the pointer surface is there.
    assert.equal(stage.style.touchAction, 'none', 'the stage owns its touch gestures');
    void stage; void windowEl;
  } finally {
    await act(() => root.unmount());
    await server.close();
    dom.window.close();
  }
});
