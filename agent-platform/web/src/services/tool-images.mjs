import { safeHref } from './markdown-url.mjs';
const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/bmp']);
const IMAGE_PATH = /\.(png|jpe?g|gif|webp|bmp)$/i;

/* The runner replaces every image payload with a text placeholder before the
   event reaches the browser, so an inline data URL is normally unavailable.
   A successful read of a workspace image is recovered from its path instead. */
export function toolImagePath(block) {
  if (!block || String(block.name || '').toLowerCase() !== 'read') return undefined;
  if (block.state === 'error') return undefined;
  if (typeof block.result !== 'string' || !block.result.includes('[图片已交给模型]')) return undefined;
  let args = block.args;
  if (typeof args === 'string') { try { args = JSON.parse(args); } catch { return undefined; } }
  const path = args && (args.path || args.file_path || args.filePath);
  return typeof path === 'string' && IMAGE_PATH.test(path) ? path : undefined;
}

export function readToolImage(name, result) {
  if (!['read', 'web_view_image'].includes(name)) return undefined;
  const parts = Array.isArray(result) ? result : result?.content;
  if (!Array.isArray(parts)) return undefined;
  const image = parts.find(part => part?.type === 'image' && IMAGE_TYPES.has(part.mimeType)
    && typeof part.data === 'string' && part.data.length > 0 && part.data.length <= 2 * 1024 * 1024);
  return image ? 'data:' + image.mimeType + ';base64,' + image.data : undefined;
}

export function toolRemoteImage(block) {
  if (block?.name !== 'web_view_image' || block.state === 'error' ||
      !String(block.result || '').includes('[图片已交给模型]')) return undefined;
  let args = block.args;
  if (typeof args === 'string') { try { args = JSON.parse(args); } catch { return undefined; } }
  const url = safeHref(args?.url);
  return url?.startsWith('https:') ? url : undefined;
}
