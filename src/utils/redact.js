export function maskPhoneLike(value) {
  const s = String(value || '');
  if (!s) return s;

  const suffixIdx = s.indexOf('@');
  const suffix = suffixIdx >= 0 ? s.slice(suffixIdx) : '';
  const digits = s.replace(/\D/g, '');

  if (digits.length <= 4) {
    return suffix ? `***${suffix}` : '***';
  }

  return `***${digits.slice(-4)}${suffix}`;
}

