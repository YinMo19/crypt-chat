/**
 * Client-side image compression.
 *
 * Goals:
 *   - Cap source size at 20 MiB (raw input from user).
 *   - Resize to fit within 1600×1600 max side (preserves aspect ratio).
 *   - Re-encode as JPEG at quality 0.82, falling back to lower quality
 *     if the result is still over the target size.
 *   - Output stays well under 1.2 MiB so envelope after base64 + JSON +
 *     ws frame stays under the 6 MiB server cap.
 *
 * The output is a base64 data string (no `data:` prefix; mime is separate).
 * Server is opaque to all of this — image bytes ride inside the encrypted
 * payload like text does.
 */

import { b64encode } from './crypto';

export const MAX_IMAGE_SOURCE_BYTES = 20 * 1024 * 1024; // 20 MiB
const MAX_DIMENSION = 1600;
const TARGET_OUTPUT_BYTES = 1_200_000; // ~1.2 MiB
const QUALITY_STEPS = [0.82, 0.7, 0.6, 0.5, 0.4];

export interface ImageAttachment {
  /** mime type of the encoded blob (always image/jpeg in practice). */
  mime: string;
  /** Base64-encoded image bytes (no data: prefix). */
  data: string;
  /** Display dimensions. */
  w: number;
  h: number;
}

export async function compressImage(file: File): Promise<ImageAttachment> {
  const url = URL.createObjectURL(file);
  try {
    const img = await loadImage(url);
    const { canvas, w, h } = drawScaled(img, MAX_DIMENSION);
    // Try qualities until we hit the size budget. canvas.toBlob can
    // return null (unsupported MIME, oversized canvas, OOM); we just
    // proceed to the next quality. `lastBlob` retains the smallest /
    // most-compressed result so an over-budget but otherwise valid blob
    // is still preferable to throwing.
    let lastBlob: Blob | null = null;
    for (const q of QUALITY_STEPS) {
      const blob = await canvasToBlob(canvas, 'image/jpeg', q);
      if (!blob) continue;
      lastBlob = blob;
      if (blob.size <= TARGET_OUTPUT_BYTES) break;
    }
    if (!lastBlob) {
      throw new Error('canvas.toBlob returned null at every quality level');
    }
    const data = await blobToBase64(lastBlob);
    return { mime: 'image/jpeg', data, w, h };
  } finally {
    URL.revokeObjectURL(url);
  }
}

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = url;
  });
}

function drawScaled(
  img: HTMLImageElement,
  maxSide: number,
): { canvas: HTMLCanvasElement; w: number; h: number } {
  const ratio = Math.min(1, maxSide / Math.max(img.naturalWidth, img.naturalHeight));
  const w = Math.round(img.naturalWidth * ratio);
  const h = Math.round(img.naturalHeight * ratio);
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('no 2d context');
  ctx.drawImage(img, 0, 0, w, h);
  return { canvas, w, h };
}

function canvasToBlob(
  canvas: HTMLCanvasElement,
  mime: string,
  quality: number,
): Promise<Blob | null> {
  return new Promise((resolve) => canvas.toBlob(resolve, mime, quality));
}

async function blobToBase64(blob: Blob): Promise<string> {
  return b64encode(new Uint8Array(await blob.arrayBuffer()));
}
