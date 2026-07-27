/**
 * Render a unified diff string as HTML with colored +/- lines.
 */
export function renderDiffHtml(diff: string): string {
  if (!diff) return '';
  return diff
    .split('\n')
    .map(line => {
      const escaped = line.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
      if (line.startsWith('+')) return '<span class="text-green-400">' + escaped + '</span>';
      if (line.startsWith('-')) return '<span class="text-red-400">' + escaped + '</span>';
      return escaped;
    })
    .join('\n');
}
