import { useCallback, useEffect, useState } from 'react';

// FileBrowser — port of rysh-mobile's FileBrowserScreen + FileViewerScreen to
// the web mobile view. Full-screen overlay over the pane screen: browse the
// pane's working directory (dirs first), tap a text file to read it (256 KiB
// chunks, "load more" until eof) or an image to view it (whole-file base64 →
// data URI). Fetches the embedded web server's /fs/list & /fs/read endpoints,
// which reuse the share relay's sandbox/classification (rysh-cli
// internal/actors/file_browse.go): same snake_case reply fields, same
// {ok:false, error, message} error envelope, 'unsupported' entries disabled.

// Matches the server's fsMaxTextChunk (and rysh-mobile's CHUNK).
const CHUNK = 262144;

interface FsEntry {
  name: string;
  kind: 'file' | 'dir';
  size: number;
  mtime_ms: number;
  content_class: 'text' | 'image' | 'unsupported' | 'dir';
  mime: string;
}

// Base URL prefix for same-origin API calls. The bundle may be served behind
// a prefix-stripping reverse proxy (dev.rysh.ai/ryshweb/<dev>/ → /), where an
// absolute "/fs/list" would escape the proxied subtree — so derive the prefix
// from the page path by dropping the "mobile" segment.
function apiBase(): string {
  let base = window.location.pathname.replace(/mobile\/?$/, '');
  if (!base.endsWith('/')) base += '/';
  return base;
}

async function fsGet(op: 'list' | 'read', params: Record<string, string>): Promise<any> {
  const q = new URLSearchParams(params).toString();
  const resp = await fetch(`${apiBase()}fs/${op}?${q}`);
  const body = await resp.json();
  if (!body.ok) {
    throw new Error(body.message || body.error || 'file browse failed');
  }
  return body;
}

function fmtSize(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

function entryIcon(e: FsEntry): string {
  if (e.kind === 'dir') return '📁';
  if (e.content_class === 'image') return '🖼';
  if (e.content_class === 'text') return '📄';
  return '•';
}

interface Props {
  paneId: string;
  onClose: () => void;
}

type View =
  | { kind: 'list' }
  | { kind: 'text'; filePath: string; text: string; nextOffset: number; eof: boolean; total: number }
  | { kind: 'image'; filePath: string; src: string };

export function FileBrowser({ paneId, onClose }: Props) {
  const [path, setPath] = useState('');
  const [root, setRoot] = useState('');
  const [entries, setEntries] = useState<FsEntry[]>([]);
  const [truncated, setTruncated] = useState(false);
  const [view, setView] = useState<View>({ kind: 'list' });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const loadDir = useCallback(
    async (p: string) => {
      setLoading(true);
      setError('');
      try {
        const res = await fsGet('list', { pane: paneId, path: p });
        setRoot(res.root || '');
        setPath(res.path || p);
        setEntries(res.entries || []);
        setTruncated(!!res.truncated);
        setView({ kind: 'list' });
      } catch (e) {
        setError((e as Error).message);
      } finally {
        setLoading(false);
      }
    },
    [paneId]
  );

  useEffect(() => {
    loadDir('');
  }, [loadDir]);

  const openFile = useCallback(
    async (filePath: string, contentClass: 'text' | 'image', mime: string) => {
      setLoading(true);
      setError('');
      try {
        const res = await fsGet('read', {
          pane: paneId,
          path: filePath,
          offset: '0',
          length: String(CHUNK),
        });
        if (res.content_class === 'image' || contentClass === 'image') {
          setView({
            kind: 'image',
            filePath,
            src: `data:${res.mime || mime};base64,${res.data}`,
          });
        } else {
          setView({
            kind: 'text',
            filePath,
            text: res.data,
            nextOffset: (res.offset || 0) + (res.length || 0),
            eof: !!res.eof,
            total: res.total_size || 0,
          });
        }
      } catch (e) {
        setError((e as Error).message);
      } finally {
        setLoading(false);
      }
    },
    [paneId]
  );

  const loadMore = useCallback(async () => {
    if (view.kind !== 'text' || view.eof) return;
    setLoading(true);
    try {
      const res = await fsGet('read', {
        pane: paneId,
        path: view.filePath,
        offset: String(view.nextOffset),
        length: String(CHUNK),
      });
      setView({
        ...view,
        text: view.text + res.data,
        nextOffset: (res.offset || 0) + (res.length || 0),
        eof: !!res.eof,
      });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [paneId, view]);

  const goBack = useCallback(() => {
    if (view.kind !== 'list') {
      setView({ kind: 'list' });
      return;
    }
    if (!path) {
      onClose();
      return;
    }
    const parent = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '';
    loadDir(parent);
  }, [view, path, onClose, loadDir]);

  const title =
    view.kind === 'list'
      ? path || root || '/'
      : view.filePath.split('/').pop() || view.filePath;

  return (
    <div
      className="fixed inset-0 z-[200] flex flex-col bg-[#1e1e1e] text-[#d4d4d4]"
      data-testid="file-browser"
    >
      {/* Header */}
      <div className="shrink-0 flex items-center gap-2 h-12 px-3 bg-[#222] border-b border-[#333] select-none">
        <button
          onClick={goBack}
          className="text-[#9a9aaf] active:text-white text-[26px] leading-none px-2 -ml-2"
          aria-label="Back"
        >
          {'‹'}
        </button>
        <span className="flex-1 min-w-0">
          <span className="block font-bold text-[14px] text-white truncate leading-tight">
            {title}
          </span>
          <span className="block text-[11px] text-[#808080] truncate leading-tight">
            {view.kind === 'list' ? 'files' : view.filePath}
          </span>
        </span>
        <button
          onClick={onClose}
          className="text-[#9a9aaf] active:text-white text-[20px] px-2"
          aria-label="Close files"
        >
          ✕
        </button>
      </div>

      {error && (
        <div className="shrink-0 px-4 py-2 text-[13px] text-[#ff8787] bg-[#3a1a1a] border-b border-[#5a2a2a]">
          {error}
        </div>
      )}

      {/* Body */}
      {view.kind === 'list' ? (
        <div className="flex-1 overflow-y-auto">
          {entries.map((e) => {
            const disabled = e.kind === 'file' && e.content_class === 'unsupported';
            const child = path ? `${path}/${e.name}` : e.name;
            return (
              <button
                key={e.name}
                type="button"
                disabled={disabled}
                onClick={() => {
                  if (e.kind === 'dir') loadDir(child);
                  else if (e.content_class === 'text' || e.content_class === 'image') {
                    openFile(child, e.content_class, e.mime);
                  }
                }}
                className={`w-full flex items-center gap-3 px-4 py-3 border-b border-[#2a2a2a] text-left ${
                  disabled ? 'opacity-40' : 'active:bg-[#2a2a2a]'
                }`}
              >
                <span className="text-[18px] shrink-0 w-6 text-center">{entryIcon(e)}</span>
                <span className="flex-1 min-w-0 text-[14px] text-white truncate">{e.name}</span>
                {e.kind === 'file' && (
                  <span className="text-[11px] text-[#808080] shrink-0">{fmtSize(e.size)}</span>
                )}
                {e.kind === 'dir' && <span className="text-[#666] text-[18px] shrink-0">{'›'}</span>}
              </button>
            );
          })}
          {truncated && (
            <div className="px-4 py-3 text-[12px] text-[#808080]">
              listing truncated — showing the first {entries.length} entries
            </div>
          )}
          {!loading && entries.length === 0 && !error && (
            <div className="px-4 py-8 text-center text-[13px] text-[#666]">empty directory</div>
          )}
        </div>
      ) : view.kind === 'text' ? (
        <div className="flex-1 overflow-auto">
          {/* textContent rendering (not HTML) — file contents are untrusted. */}
          <pre className="px-3 py-2 text-[12px] leading-[1.4] font-mono whitespace-pre text-[#d4d4d4]">
            {view.text}
          </pre>
          {!view.eof && (
            <button
              type="button"
              onClick={loadMore}
              disabled={loading}
              className="mx-3 mb-4 px-4 py-2 rounded bg-[#333] text-[#d0d0d0] text-[13px] active:bg-[#444]"
            >
              {loading ? 'loading…' : `load more (${fmtSize(view.nextOffset)} of ${fmtSize(view.total)})`}
            </button>
          )}
        </div>
      ) : (
        <div className="flex-1 overflow-auto flex items-start justify-center p-2 bg-[#141414]">
          <img src={view.src} alt={view.filePath} className="max-w-full h-auto" />
        </div>
      )}

      {loading && view.kind === 'list' && (
        <div className="absolute inset-x-0 top-14 text-center text-[12px] text-[#808080]">
          loading…
        </div>
      )}
    </div>
  );
}
