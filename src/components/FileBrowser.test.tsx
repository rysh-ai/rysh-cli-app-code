import { beforeEach, describe, expect, it, vi } from 'vitest';
import { configure, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { FileBrowser } from './FileBrowser';

// Every assertion here waits on a mocked promise that resolves immediately, so
// the only thing the default 1000ms waitFor budget actually measures is how busy
// the machine is. It is not enough on a loaded one: the first test in this file
// paid 11.4s for a cold render and failed on the timeout while the identical
// query passed in 1.3s once warm. Raise the async budget so a slow host cannot
// masquerade as a broken component.
configure({ asyncUtilTimeout: 30_000 });

// FileBrowser is the phone's only way to read a file on the machine the pane is
// running on. It is a port of rysh-mobile's FileBrowserScreen + FileViewerScreen
// (see the component header) and it talks to the daemon's embedded /fs/list and
// /fs/read, which reuse the share relay's sandbox and content classification
// (rysh-cli internal/actors/file_browse.go).
//
// The seams worth pinning are the ones a reader cannot check by looking, and
// where being wrong is silent rather than loud:
//
//   - the CHUNK length sent to /fs/read must equal the server's fsMaxTextChunk;
//     ask for more and the server truncates without saying so, so "load more"
//     would loop on the same bytes;
//   - paging advances by the RESPONSE's offset+length, not the request's — the
//     server is free to return less than asked;
//   - the child path is built from the CURRENT path, so descending twice must
//     produce a/b and not b (this is the bug that makes a nested directory
//     appear empty);
//   - `unsupported` entries must be inert — the server refuses them, and a tap
//     that fetched anyway would surface the sandbox's error as if the file were
//     broken;
//   - the {ok:false, error, message} envelope prefers `message`, which is the
//     human half;
//   - Back is three different actions depending on where you are, and the one
//     that closes the overlay is only correct at the root.
//
// apiFetch is mocked rather than fetch: it resolves the path against the page
// prefix and attaches the login token, neither of which is under test here.

const { apiFetch } = vi.hoisted(() => ({ apiFetch: vi.fn() }));
vi.mock('../utils/auth', () => ({ apiFetch }));

/** Queue one JSON body per call, in order. */
function reply(...bodies: unknown[]) {
  for (const body of bodies) {
    apiFetch.mockImplementationOnce(() => Promise.resolve({ json: () => Promise.resolve(body) }));
  }
}

function entry(over: Partial<Record<string, unknown>> = {}) {
  return {
    name: 'notes.txt',
    kind: 'file',
    size: 10,
    mtime_ms: 0,
    content_class: 'text',
    mime: 'text/plain',
    ...over,
  };
}

const dir = (name: string) => entry({ name, kind: 'dir', content_class: 'dir', size: 0 });

/** The query string apiFetch was called with on call `n` (0-based). */
const callPath = (n: number) => apiFetch.mock.calls[n][0] as string;

function open(onClose = vi.fn()) {
  render(<FileBrowser paneId="pane-1" onClose={onClose} />);
  return onClose;
}

// Tap an entry row by its filename. The row's accessible name also contains the
// icon, the size and the chevron, and a bare name like "a" additionally matches
// the "Back" button — so go through the name cell and click its own row.
function tap(name: string) {
  const row = screen.getByText(name).closest('button');
  if (!row) throw new Error(`no row button for entry ${name}`);
  fireEvent.click(row);
}

beforeEach(() => {
  apiFetch.mockReset();
});

describe('FileBrowser — listing the pane directory', () => {
  it('lists on mount, asking /fs/list for this pane at the root path', async () => {
    reply({ ok: true, root: '/w', path: '', entries: [entry()] });
    open();

    await waitFor(() => expect(screen.getByText('notes.txt')).toBeInTheDocument());
    expect(callPath(0)).toBe('fs/list?pane=pane-1&path=');
  });

  it('shows a size for files and a chevron for directories', async () => {
    reply({ ok: true, root: '/w', path: '', entries: [dir('src'), entry({ size: 2048 })] });
    open();

    await waitFor(() => expect(screen.getByText('src')).toBeInTheDocument());
    expect(screen.getByText('2.0 KB')).toBeInTheDocument();
    // The dir row carries the chevron and no size.
    expect(screen.getByText('›')).toBeInTheDocument();
  });

  it.each([
    [0, '0 B'],
    [1023, '1023 B'],
    [1024, '1.0 KB'],
    [1024 * 1024 - 1, '1024.0 KB'],
    [1024 * 1024, '1.0 MB'],
    [3 * 1024 * 1024, '3.0 MB'],
  ])('formats %i bytes as %s', async (size, shown) => {
    reply({ ok: true, root: '/w', path: '', entries: [entry({ size })] });
    open();

    await waitFor(() => expect(screen.getByText(shown)).toBeInTheDocument());
  });

  it('says so when the directory is empty', async () => {
    reply({ ok: true, root: '/w', path: '', entries: [] });
    open();

    await waitFor(() => expect(screen.getByText('empty directory')).toBeInTheDocument());
  });

  it('reports a truncated listing with the number of entries it did show', async () => {
    reply({ ok: true, root: '/w', path: '', entries: [entry(), dir('d')], truncated: true });
    open();

    await waitFor(() =>
      expect(screen.getByText(/listing truncated — showing the first 2 entries/)).toBeInTheDocument()
    );
  });
});

describe('FileBrowser — entries the sandbox refuses are inert', () => {
  it('disables an unsupported file and does not fetch when it is tapped', async () => {
    reply({ ok: true, root: '/w', path: '', entries: [entry({ name: 'a.bin', content_class: 'unsupported' })] });
    open();

    await waitFor(() => expect(screen.getByText('a.bin')).toBeInTheDocument());
    const row = screen.getByRole('button', { name: /a\.bin/ });
    expect(row).toBeDisabled();

    fireEvent.click(row);
    expect(apiFetch).toHaveBeenCalledTimes(1); // the mount listing, and nothing more
  });
});

describe('FileBrowser — descending builds the path from where you already are', () => {
  it('descends twice and asks for a/b, not b', async () => {
    reply(
      { ok: true, root: '/w', path: '', entries: [dir('a')] },
      { ok: true, root: '/w', path: 'a', entries: [dir('b')] },
      { ok: true, root: '/w', path: 'a/b', entries: [] }
    );
    open();

    await waitFor(() => expect(screen.getByText('a')).toBeInTheDocument());
    tap('a');
    await waitFor(() => expect(screen.getByText('b')).toBeInTheDocument());
    expect(callPath(1)).toBe('fs/list?pane=pane-1&path=a');

    tap('b');
    await waitFor(() => expect(screen.getByText('empty directory')).toBeInTheDocument());
    // URLSearchParams percent-encodes the separator; the path is a/b either way.
    expect(decodeURIComponent(callPath(2))).toBe('fs/list?pane=pane-1&path=a/b');
  });
});

describe('FileBrowser — reading a text file', () => {
  it('reads the first chunk at offset 0 with the server fsMaxTextChunk length', async () => {
    reply(
      { ok: true, root: '/w', path: '', entries: [entry()] },
      { ok: true, content_class: 'text', data: 'hello', offset: 0, length: 5, eof: true, total_size: 5 }
    );
    open();

    await waitFor(() => expect(screen.getByText('notes.txt')).toBeInTheDocument());
    tap('notes.txt');

    await waitFor(() => expect(screen.getByText('hello')).toBeInTheDocument());
    expect(callPath(1)).toBe('fs/read?pane=pane-1&path=notes.txt&offset=0&length=262144');
  });

  it('offers load-more only until eof, and pages by the response offset+length', async () => {
    reply(
      { ok: true, root: '/w', path: '', entries: [entry({ size: 12 })] },
      // The server returned FEWER bytes than the 262144 asked for: paging must
      // follow what came back, not what was requested.
      { ok: true, content_class: 'text', data: 'abcdef', offset: 0, length: 6, eof: false, total_size: 12 },
      { ok: true, content_class: 'text', data: 'ghijkl', offset: 6, length: 6, eof: true, total_size: 12 }
    );
    open();

    await waitFor(() => expect(screen.getByText('notes.txt')).toBeInTheDocument());
    tap('notes.txt');
    await waitFor(() => expect(screen.getByText('abcdef')).toBeInTheDocument());

    const more = screen.getByRole('button', { name: /load more/ });
    fireEvent.click(more);

    // Appended, not replaced.
    await waitFor(() => expect(screen.getByText('abcdefghijkl')).toBeInTheDocument());
    expect(callPath(2)).toBe('fs/read?pane=pane-1&path=notes.txt&offset=6&length=262144');
    // eof reached: the button is gone.
    expect(screen.queryByRole('button', { name: /load more/ })).not.toBeInTheDocument();
  });
});

describe('FileBrowser — viewing an image', () => {
  it('builds a data URI from the served mime and base64 payload', async () => {
    reply(
      { ok: true, root: '/w', path: '', entries: [entry({ name: 'p.png', content_class: 'image', mime: 'image/png' })] },
      { ok: true, content_class: 'image', mime: 'image/png', data: 'QUJD' }
    );
    open();

    await waitFor(() => expect(screen.getByText('p.png')).toBeInTheDocument());
    tap('p.png');

    const img = await waitFor(() => screen.getByAltText('p.png') as HTMLImageElement);
    expect(img.getAttribute('src')).toBe('data:image/png;base64,QUJD');
  });
});

describe('FileBrowser — the error envelope', () => {
  it('prefers the human `message` over `error`', async () => {
    reply({ ok: false, error: 'eacces', message: 'permission denied' });
    open();

    await waitFor(() => expect(screen.getByText('permission denied')).toBeInTheDocument());
    expect(screen.queryByText('eacces')).not.toBeInTheDocument();
  });

  it('falls back to `error` when there is no message', async () => {
    reply({ ok: false, error: 'eacces' });
    open();

    await waitFor(() => expect(screen.getByText('eacces')).toBeInTheDocument());
  });

  it('falls back to a generic line when the envelope carries neither', async () => {
    reply({ ok: false });
    open();

    await waitFor(() => expect(screen.getByText('file browse failed')).toBeInTheDocument());
  });
});

describe('FileBrowser — Back is three different actions', () => {
  it('closes the overlay when you are already at the root', async () => {
    reply({ ok: true, root: '/w', path: '', entries: [entry()] });
    const onClose = open();

    await waitFor(() => expect(screen.getByText('notes.txt')).toBeInTheDocument());
    fireEvent.click(screen.getByLabelText('Back'));

    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('goes to the parent directory when you are below the root, without closing', async () => {
    reply(
      { ok: true, root: '/w', path: '', entries: [dir('a')] },
      { ok: true, root: '/w', path: 'a', entries: [dir('b')] },
      { ok: true, root: '/w', path: 'a/b', entries: [] },
      { ok: true, root: '/w', path: 'a', entries: [dir('b')] }
    );
    const onClose = open();

    await waitFor(() => expect(screen.getByText('a')).toBeInTheDocument());
    tap('a');
    await waitFor(() => expect(screen.getByText('b')).toBeInTheDocument());
    tap('b');
    await waitFor(() => expect(screen.getByText('empty directory')).toBeInTheDocument());

    fireEvent.click(screen.getByLabelText('Back'));

    await waitFor(() => expect(callPath(3)).toBe('fs/list?pane=pane-1&path=a'));
    expect(onClose).not.toHaveBeenCalled();
  });

  it('returns from a file view to the listing without refetching it', async () => {
    reply(
      { ok: true, root: '/w', path: '', entries: [entry()] },
      { ok: true, content_class: 'text', data: 'hello', offset: 0, length: 5, eof: true, total_size: 5 }
    );
    const onClose = open();

    await waitFor(() => expect(screen.getByText('notes.txt')).toBeInTheDocument());
    tap('notes.txt');
    await waitFor(() => expect(screen.getByText('hello')).toBeInTheDocument());

    fireEvent.click(screen.getByLabelText('Back'));

    await waitFor(() => expect(screen.getByText('notes.txt')).toBeInTheDocument());
    expect(screen.queryByText('hello')).not.toBeInTheDocument();
    expect(apiFetch).toHaveBeenCalledTimes(2); // list + read, no third call
    expect(onClose).not.toHaveBeenCalled();
  });

  it('closes on the ✕ button from anywhere', async () => {
    reply({ ok: true, root: '/w', path: '', entries: [entry()] });
    const onClose = open();

    await waitFor(() => expect(screen.getByText('notes.txt')).toBeInTheDocument());
    fireEvent.click(screen.getByLabelText('Close files'));

    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
