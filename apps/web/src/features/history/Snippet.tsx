import { SNIPPET_CLOSE, SNIPPET_OPEN } from '@orc/api-contract';

export function Snippet({ text }: { text: string }) {
  const parts: Array<{ key: string; marked: boolean; text: string }> = [];
  let rest = text;
  let n = 0;
  while (rest.length > 0) {
    const open = rest.indexOf(SNIPPET_OPEN);
    const close = open >= 0 ? rest.indexOf(SNIPPET_CLOSE, open) : -1;
    if (open < 0 || close < 0) {
      parts.push({
        key: `p${n++}`,
        marked: false,
        text: rest.replaceAll(SNIPPET_OPEN, '').replaceAll(SNIPPET_CLOSE, ''),
      });
      break;
    }
    if (open > 0) parts.push({ key: `p${n++}`, marked: false, text: rest.slice(0, open) });
    parts.push({ key: `p${n++}`, marked: true, text: rest.slice(open + SNIPPET_OPEN.length, close) });
    rest = rest.slice(close + SNIPPET_CLOSE.length);
  }
  return (
    <span>
      {parts.map((p) => (p.marked ? <mark key={p.key}>{p.text}</mark> : <span key={p.key}>{p.text}</span>))}
    </span>
  );
}
