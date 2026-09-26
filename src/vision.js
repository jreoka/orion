// Orion vision: turn attached image files into OpenAI-style image_url
// content parts, downscaled so they stay cheap and under provider limits.
// Works with any OpenAI-compatible /chat/completions endpoint whose model
// accepts vision input. If the model rejects them, agent.js strips the
// parts and retries the turn text-only.
import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import { db, DATA_DIR } from './db.js';

const MAX_DIM = 1568; // longest side after downscale
const JPEG_QUALITY = 78;
const MAX_FILE_BYTES = 12 * 1024 * 1024; // skip monsters outright
const MAX_IMAGES_PER_MESSAGE = 6;

/** Image attachment rows (claimed, not staged) for a message. */
export function messageImageAttachments(messageId) {
  return db
    .prepare(
      `SELECT filename, mime, size, path FROM attachments
       WHERE message_id = ? AND staged = 0 AND (mime LIKE 'image/%' OR kind = 'image')`
    )
    .all(messageId);
}

/** Downscale + JPEG-encode a buffer. Returns {buffer, mime} or null. */
export async function prepareImage(buf) {
  let meta;
  try {
    meta = await sharp(buf, { failOn: 'none' }).metadata();
  } catch {
    return null;
  }
  if (!meta || !meta.width) return null;
  const scale = Math.min(1, MAX_DIM / Math.max(meta.width, meta.height || 1));
  try {
    let pipeline = sharp(buf, { failOn: 'none' });
    if (scale < 1) {
      pipeline = pipeline.resize(Math.round(meta.width * scale), Math.round((meta.height || 1) * scale), {
        fit: 'inside',
        withoutEnlargement: true,
      });
    }
    const out = await pipeline
      .flatten({ background: '#ffffff' }) // alpha → white for JPEG
      .jpeg({ quality: JPEG_QUALITY, mozjpeg: true })
      .toBuffer();
    return { buffer: out, mime: 'image/jpeg' };
  } catch {
    return null;
  }
}

function absUnderData(rel) {
  if (!rel) return null;
  const dataRoot = path.resolve(DATA_DIR) + path.sep;
  const fp = path.resolve(DATA_DIR, rel);
  return fp.startsWith(dataRoot) ? fp : null;
}

/** Build image_url parts for a message's image attachments. */
export async function imagePartsForMessage(messageId) {
  const rows = messageImageAttachments(messageId);
  const parts = [];
  const skipped = [];
  for (const r of rows.slice(0, MAX_IMAGES_PER_MESSAGE)) {
    try {
      const fp = absUnderData(r.path);
      if (!fp) {
        skipped.push(r.filename || 'image');
        continue;
      }
      if (fs.statSync(fp).size > MAX_FILE_BYTES) {
        skipped.push(`${r.filename || 'image'} (too large)`);
        continue;
      }
      const prep = await prepareImage(fs.readFileSync(fp));
      if (!prep) {
        skipped.push(r.filename || 'image');
        continue;
      }
      parts.push({
        type: 'image_url',
        image_url: { url: `data:${prep.mime};base64,${prep.buffer.toString('base64')}` },
      });
    } catch {
      skipped.push(r.filename || 'image');
    }
  }
  if (rows.length > MAX_IMAGES_PER_MESSAGE) {
    skipped.push(`${rows.length - MAX_IMAGES_PER_MESSAGE} more image(s) omitted`);
  }
  return { parts, skipped };
}

/** A single image part from an absolute file path (e.g. tool results). */
export async function imagePartFromFile(absPath) {
  try {
    const prep = await prepareImage(fs.readFileSync(absPath));
    if (!prep) return null;
    return {
      type: 'image_url',
      image_url: { url: `data:${prep.mime};base64,${prep.buffer.toString('base64')}` },
    };
  } catch {
    return null;
  }
}

/** True when a convo message carries image parts. */
export function messageHasImages(m) {
  return Array.isArray(m?.content) && m.content.some((p) => p && p.type === 'image_url');
}

/**
 * Replace image parts with an honest placeholder (fallback for text-only
 * models). Mutates the messages in place; returns the count stripped.
 */
export function stripImageParts(messages) {
  let stripped = 0;
  for (const m of messages) {
    if (!messageHasImages(m)) continue;
    const kept = [];
    for (const p of m.content) {
      if (p && p.type === 'image_url') {
        stripped++;
        continue;
      }
      kept.push(p);
    }
    kept.push({
      type: 'text',
      text: '\n\n[an image was attached here, but the configured model cannot view images]',
    });
    m.content = kept;
  }
  return stripped;
}
