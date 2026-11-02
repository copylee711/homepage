// Preserve arbitrary file bytes. Both attachment entry points use this framing.
export function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => { const result = String(reader.result || ''); resolve(result.slice(result.indexOf(',') + 1)); };
    reader.onerror = () => reject(new Error('读取文件失败，请重新选择'));
    reader.onabort = () => reject(new Error('已取消读取文件'));
    reader.readAsDataURL(file);
  });
}
