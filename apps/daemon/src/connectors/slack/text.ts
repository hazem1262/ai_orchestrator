/** Slack timestamps are "<seconds>.<microseconds>" strings; compare them numerically without float rounding. */
export function compareSlackTs(a: string, b: string): number {
  const [as = '0', af = '0'] = a.split('.');
  const [bs = '0', bf = '0'] = b.split('.');
  const bySeconds = Number(as) - Number(bs);
  if (bySeconds !== 0) return Math.sign(bySeconds);
  return Math.sign(Number(af.padEnd(6, '0')) - Number(bf.padEnd(6, '0')));
}

export function slackTsFromDate(d: Date): string {
  const ms = d.getTime();
  return `${Math.floor(ms / 1000)}.${String((ms % 1000) * 1000).padStart(6, '0')}`;
}

export function decodeSlackText(t: string): string {
  return t.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
}
