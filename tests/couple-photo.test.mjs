import { test } from 'node:test';
import assert from 'node:assert/strict';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { JSDOM } from 'jsdom';
import { createServer } from 'vite';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

test('couple photo frame: the upload invite, the deliberate replace, and the service rules', async () => {
  const server = await createServer({ server: { middlewareMode: true, hmr: false, ws: false } });
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>');
  globalThis.window = dom.window;
  globalThis.document = dom.window.document;
  globalThis.HTMLElement = dom.window.HTMLElement;
  globalThis.HTMLImageElement = dom.window.HTMLImageElement;

  const root = createRoot(dom.window.document.getElementById('root'));

  try {
    const { NookPhotoFrame } = await server.ssrLoadModule('/src/components/home/NookPhotoFrame.tsx');
    const service = await server.ssrLoadModule('/src/lib/couplePhotoService.ts');

    // --- Pure service rules ---------------------------------------------------------
    assert.equal(service.photoStoragePath('c1', 'p1'), 'photos/c1/p1.jpg');
    assert.equal(service.isPhotoFile({ type: 'image/jpeg' }), true);
    assert.equal(service.isPhotoFile({ type: 'application/pdf' }), false);
    // Without a canvas (the test DOM), the original bytes travel unchanged.
    const original = new dom.window.Blob(['us'], { type: 'image/png' });
    assert.equal(await service.preparePhotoForUpload(original), original);
    // A huge camera-roll original is refused before anything leaves the phone.
    await assert.rejects(
      () => service.preparePhotoForUpload({ size: service.PHOTO_MAX_SOURCE_BYTES + 1, type: 'image/png' }),
      /too large/,
    );
    // Without a configured client, nothing uploads at all.
    await assert.rejects(
      () => service.uploadCouplePhoto({ coupleId: 'c1', userId: 'u1', file: original }),
      (error) => error instanceof Error,
      'the upload is refused rather than appearing to work',
    );

    // --- The empty frame invites the upload — no confirmation in the way -------------
    const uploads = [];
    let confirmCalls = 0;
    let confirmAnswer = true;
    dom.window.confirm = () => { confirmCalls += 1; return confirmAnswer; };
    const frameButton = () => document.querySelector('button[data-nooki-frame-button]');
    const picker = () => document.querySelector('input[type="file"]');
    let pickerOpened = 0;

    await act(async () => {
      root.render(React.createElement(NookPhotoFrame, { src: null, onUpload: (file) => uploads.push(file) }));
    });
    Object.defineProperty(picker(), 'click', { value: () => { pickerOpened += 1; }, configurable: true });
    await act(async () => { frameButton().click(); });
    assert.equal(pickerOpened, 1, 'tapping the empty frame opens the picture picker');
    assert.equal(confirmCalls, 0, 'the first upload needs no confirmation');

    // The photo now fills its flex area instead of sitting inside a capped SVG frame.
    const photoArea = document.querySelector('[data-component="nook-photo-frame"]');
    const stand = photoArea.querySelector('[data-nooki-frame-stand]');
    const photoWindow = photoArea.querySelector('[data-nooki-frame-window]');
    assert.equal(photoArea.style.flexGrow, '1');
    assert.equal(stand.style.flexGrow, '1');
    assert.equal(stand.style.maxWidth, '', 'no percentage cap shrinks the picture');
    assert.equal(stand.style.aspectRatio, '', 'the photo area follows available height');
    assert.equal(frameButton().style.borderWidth, '5px', 'a 5px coloured border replaces the mat');
    assert.equal(photoWindow.style.inset, '0px', 'there is no inset mat around the photo');
    const hearts = photoArea.querySelectorAll('[data-nooki-photo-heart]');
    assert.equal(hearts.length, 2, 'one heart for each partner');
    assert.notEqual(hearts[0].getAttribute('fill'), hearts[1].getAttribute('fill'));
    assert.equal(hearts[0].style.top, '12px');
    assert.equal(hearts[1].style.bottom, '12px', 'the hearts sit at opposite corners');
    assert.equal(photoArea.querySelector('svg rect'), null, 'the wood, mat and bow are gone');

    // Crop to the responsive photo area, not the old fixed landscape mat.
    photoWindow.getBoundingClientRect = () => ({ width: 300, height: 420 });

    // --- A chosen picture is fitted before it uploads --------------------------------
    const file = new dom.window.File(['us'], 'us.png', { type: 'image/png' });
    const chooseFile = async () => {
      Object.defineProperty(picker(), 'files', { value: [file], configurable: true });
      await act(async () => { picker().dispatchEvent(new dom.window.Event('change', { bubbles: true })); });
    };
    const cropDialog = () => document.querySelector('[data-component="photo-crop-dialog"]');

    await chooseFile();
    assert(cropDialog(), 'the fit-to-frame step opens over the app');
    const cropWindow = cropDialog().querySelector('[data-crop-window]');
    const cropRatio = parseFloat(cropWindow.style.width) / parseFloat(cropWindow.style.height);
    assert(Math.abs(cropRatio - 300 / 420) < 1e-6,
      'the crop matches the actual photo window on this phone');
    assert.equal(uploads.length, 0, 'nothing uploads before the picture is fitted');

    // Stepping out uploads nothing at all.
    await act(async () => { cropDialog().querySelector('[data-action="crop-cancel"]').click(); });
    assert.equal(cropDialog(), null, 'cancel closes the fit-to-frame step');
    assert.equal(uploads.length, 0, 'a cancelled fit uploads nothing');

    // Confirming the fit hands the picture to the couple's upload. (This DOM has
    // no canvas, so the fitted picture travels on as the original — the same
    // fallback a very old browser gets.)
    await chooseFile();
    assert(cropDialog(), 'the fit-to-frame step opens again for another try');
    await act(async () => { cropDialog().querySelector('[data-action="crop-confirm"]').click(); });
    assert.equal(uploads.length, 1, 'confirming the fit hands the picture to the upload');
    assert.equal(uploads[0], file, 'the upload receives the fitted picture');
    assert.equal(cropDialog(), null, 'the fit-to-frame step closes once framed');

    // --- A framed picture is only replaced deliberately ------------------------------
    await act(async () => {
      root.render(React.createElement(NookPhotoFrame, { src: 'https://example.test/us.jpg', onUpload: (f) => uploads.push(f) }));
    });
    Object.defineProperty(picker(), 'click', { value: () => { pickerOpened += 1; }, configurable: true });

    confirmAnswer = false;
    await act(async () => { frameButton().click(); });
    assert.equal(confirmCalls, 1, 'replacing a framed picture asks first');
    assert.equal(pickerOpened, 1, 'a declined replace never opens the picker');

    confirmAnswer = true;
    await act(async () => { frameButton().click(); });
    assert.equal(confirmCalls, 2, 'the question is asked once per attempt');
    assert.equal(pickerOpened, 2, 'an accepted replace opens the picker');

    // --- Busy and error states ---------------------------------------------------------
    await act(async () => {
      root.render(React.createElement(NookPhotoFrame, {
        src: null,
        uploading: true,
        error: 'The picture could not be framed.',
        onUpload: () => {},
      }));
    });
    const busyFrame = document.querySelector('[data-component="nook-photo-frame"]');
    assert.equal(busyFrame.dataset.uploading, 'true', 'the frame marks itself busy while framing');
    assert.equal(busyFrame.dataset.hasPhoto, 'false');
    assert(
      busyFrame.querySelector('[data-nooki-frame-busy]')?.textContent.includes('Framing your picture'),
      'the busy overlay explains itself',
    );
    assert.equal(frameButton().getAttribute('aria-busy'), 'true', 'the button announces the busy state');
    assert(
      busyFrame.querySelector('[data-nooki-frame-error]')?.textContent.includes('could not be framed'),
      'a refused upload surfaces as a quiet sentence',
    );
    let busyPickerOpened = 0;
    Object.defineProperty(picker(), 'click', { value: () => { busyPickerOpened += 1; }, configurable: true });
    await act(async () => { frameButton().click(); });
    assert.equal(busyPickerOpened, 0, 'a busy frame ignores taps');
  } finally {
    await act(() => root.unmount());
    await server.close();
    dom.window.close();
  }
});
