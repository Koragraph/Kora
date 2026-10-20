const HTML = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

export function escapeHtml(text) {
  return String(text).replace(/[&<>"']/g, (c) => HTML[c]);
}

export function escapeAttr(text) {
  return escapeHtml(text).replace(/\n/g, '&#10;');
}
