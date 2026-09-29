import { DiffModeEnum, DiffView, SplitSide } from '@git-diff-view/react';
import '@git-diff-view/react/styles/diff-view-pure.css';
import type { DiffFileEntry, ReviewComment } from '@orc/core';
import { Undo2 } from 'lucide-react';
import { useMemo } from 'react';
import { Button } from '@/components/ui/button.tsx';
import { Card } from '@/components/ui/card.tsx';
import { useResolvedTheme } from '@/features/theme/ThemeProvider.tsx';
import { CommentComposer } from './CommentComposer.tsx';

type LineNotes = Record<string, { data: ReviewComment[] }>;

export function FileDiff(p: {
  file: DiffFileEntry;
  mode: 'split' | 'unified';
  comments: ReviewComment[];
  canRevert: boolean;
  onAddComment(c: ReviewComment): void;
  onRevertFile(): void;
  onRevertHunk(index: number): void;
}) {
  const { file } = p;
  const theme = useResolvedTheme();
  const extendData = useMemo(() => {
    const oldFile: LineNotes = {};
    const newFile: LineNotes = {};
    for (const c of p.comments) {
      const target = c.side === 'old' ? oldFile : newFile;
      const key = String(c.line);
      target[key] = { data: [...(target[key]?.data ?? []), c] };
    }
    return { oldFile, newFile };
  }, [p.comments]);

  return (
    <section aria-label={`Diff of ${file.path}`} className="flex flex-1 flex-col gap-2">
      <Card className="flex flex-wrap items-center gap-2 p-2 text-sm">
        <span className="min-w-0 flex-1 truncate font-mono font-semibold">
          {file.oldPath ? `${file.oldPath} → ${file.path}` : file.path}
        </span>
        {p.canRevert && (
          <Button size="sm" variant="ghost" className="text-destructive" onClick={p.onRevertFile}>
            <Undo2 aria-hidden />
            Revert file
          </Button>
        )}
        {p.canRevert &&
          file.hunks.map((h, i) => (
            <Button
              key={h.header}
              size="sm"
              variant="ghost"
              className="text-destructive"
              title={h.header}
              onClick={() => p.onRevertHunk(i)}
            >
              {`Revert hunk ${i + 1}`}
            </Button>
          ))}
      </Card>
      {file.status === 'binary' ? (
        <p className="text-sm text-muted-foreground">Binary file changed.</p>
      ) : (
        <div className="min-h-0 flex-1 overflow-auto rounded-xl border">
          <DiffView<ReviewComment[]>
            data={{
              oldFile: { fileName: file.oldPath ?? file.path },
              newFile: { fileName: file.path },
              hunks: [file.patch],
            }}
            diffViewMode={p.mode === 'split' ? DiffModeEnum.Split : DiffModeEnum.Unified}
            diffViewHighlight
            diffViewTheme={theme}
            diffViewWrap
            diffViewAddWidget
            extendData={extendData}
            renderExtendLine={({ data }) => (
              <ul className="border-y bg-muted p-2 text-sm">
                {data.map((c, i) => (
                  // biome-ignore lint/suspicious/noArrayIndexKey: comments on one line have no id and never reorder
                  <li key={`${c.line}-${i}`}>{c.body}</li>
                ))}
              </ul>
            )}
            renderWidgetLine={({ side, lineNumber, onClose }) => (
              <CommentComposer
                onCancel={onClose}
                onSubmit={(body) => {
                  p.onAddComment({
                    file: file.path,
                    line: lineNumber,
                    side: side === SplitSide.old ? 'old' : 'new',
                    body,
                  });
                  onClose();
                }}
              />
            )}
          />
        </div>
      )}
    </section>
  );
}
