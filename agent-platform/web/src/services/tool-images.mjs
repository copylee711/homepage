const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/bmp']);

export function readToolImage(name, result) {
  if (name !== 'read') return undefined;
  const parts = Array.isArray(result) ? result : result?.content;
  if (!Array.isArray(parts)) return undefined;
  const image = parts.find(part => part?.type === 'image' && IMAGE_TYPES.has(part.mimeType)
    && typeof part.data === 'string' && part.data.length > 0 && part.data.length <= 2 * 1024 * 1024);
  return image ? 'data:' + image.mimeType + ';base64,' + image.data : undefined;
}
