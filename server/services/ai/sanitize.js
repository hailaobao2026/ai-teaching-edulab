const ALLOWED_TAGS = new Set([
  'br', 'p', 'div', 'span', 'strong', 'b', 'em', 'i', 'u', 'ul', 'ol', 'li',
  'code', 'pre', 'blockquote', 'sub', 'sup', 'table', 'thead', 'tbody', 'tr', 'th', 'td'
]);

/** Keep the small HTML subset used by lesson prose and discard all attributes/scripts. */
export function sanitizeHtml(value) {
  return String(value ?? '').replace(/<!--[\s\S]*?-->/g, '').replace(/<\/?\s*([a-z][\w:-]*)\b[^>]*>/gi, (tag, rawName) => {
    const name = String(rawName).toLowerCase();
    if (!ALLOWED_TAGS.has(name)) return '';
    return tag.trimStart().startsWith('</') ? `</${name}>` : `<${name}>`;
  });
}

export function sanitizeTree(value) {
  if (typeof value === 'string') return sanitizeHtml(value);
  if (Array.isArray(value)) return value.map(sanitizeTree);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, sanitizeTree(child)]));
  }
  return value;
}
