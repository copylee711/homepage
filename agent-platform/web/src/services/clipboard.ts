export async function copyText(value: string): Promise<boolean> {
  const text = String(value ?? '');
  try { await navigator.clipboard.writeText(text); return true; }
  catch {
    try {
      const area = document.createElement('textarea');
      area.value = text; area.style.position = 'fixed'; area.style.opacity = '0';
      document.body.append(area); area.select();
      const ok = document.execCommand('copy');
      area.remove(); return ok;
    } catch { return false; }
  }
}
