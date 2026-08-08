import { useStore } from '../store';
import { apiFetch } from './auth';

/**
 * Singleton voice controller. Records the microphone via MediaRecorder,
 * transcribes it out-of-renderer (Deepgram/Whisper — the API key never lives
 * in the page), and drops the transcript into the active pane's input field.
 *
 * Two transcription backends, same behavior (web_electron_roadmap W10):
 *   - Electron: window.electronAPI.voice.transcribe (main process).
 *   - Web mode: POST /api/voice/transcribe on the page origin — the rysh web
 *     server runs the identical Go provider call (internal/voice) server-side.
 *     Availability is advertised by /api/env; when voice is not configured the
 *     mic button simply does not render (voiceConfig.enabled stays false).
 *
 * Mirrors the rysh-cli TUI voice feature (3f3d182): voice only POPULATES the
 * input; the user reviews and submits with Enter.
 */

let mediaRecorder: MediaRecorder | null = null;
let mediaStream: MediaStream | null = null;
let chunks: Blob[] = [];
let maxTimer: ReturnType<typeof setTimeout> | null = null;

const MAX_SECONDS = 120;

function setState(
  s: 'idle' | 'recording' | 'transcribing' | 'error',
  err: string | null = null
) {
  useStore.getState().setVoiceState(s);
  useStore.getState().setVoiceError(err);
}

function cleanupStream() {
  if (mediaStream) {
    mediaStream.getTracks().forEach((t) => t.stop());
    mediaStream = null;
  }
  if (maxTimer) {
    clearTimeout(maxTimer);
    maxTimer = null;
  }
}

function pickMimeType(): string | undefined {
  const candidates = [
    'audio/webm;codecs=opus',
    'audio/webm',
    'audio/ogg;codecs=opus',
    'audio/mp4',
  ];
  if (typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported) {
    for (const c of candidates) {
      if (MediaRecorder.isTypeSupported(c)) return c;
    }
  }
  return undefined;
}

// transcriberAvailable: an Electron voice bridge, or a web server that
// advertised voice capability via /api/env (W10).
function transcriberAvailable(): boolean {
  if (window.electronAPI?.voice) return true;
  return useStore.getState().webEnv?.capabilities.voice === true;
}

async function start(): Promise<void> {
  if (!transcriberAvailable()) {
    setState('error', 'voice: not configured on this rysh server');
    return;
  }
  if (
    !navigator.mediaDevices?.getUserMedia ||
    typeof MediaRecorder === 'undefined'
  ) {
    setState('error', 'voice: microphone capture not supported here');
    return;
  }
  try {
    mediaStream = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch (err) {
    setState(
      'error',
      `voice: microphone access denied${err instanceof Error ? ' (' + err.message + ')' : ''}`
    );
    return;
  }
  chunks = [];
  const mimeType = pickMimeType();
  try {
    mediaRecorder = mimeType
      ? new MediaRecorder(mediaStream, { mimeType })
      : new MediaRecorder(mediaStream);
  } catch {
    mediaRecorder = new MediaRecorder(mediaStream);
  }
  mediaRecorder.ondataavailable = (e) => {
    if (e.data && e.data.size > 0) chunks.push(e.data);
  };
  mediaRecorder.onstop = () => {
    void finalize();
  };
  mediaRecorder.start();
  setState('recording');
  maxTimer = setTimeout(() => stop(), MAX_SECONDS * 1000);
}

function stop(): void {
  if (mediaRecorder && mediaRecorder.state !== 'inactive') {
    mediaRecorder.stop(); // triggers onstop -> finalize
  } else {
    cleanupStream();
    setState('idle');
  }
}

async function finalize(): Promise<void> {
  const recorder = mediaRecorder;
  mediaRecorder = null;
  cleanupStream();
  if (chunks.length === 0) {
    setState('idle');
    return;
  }
  const type = recorder?.mimeType || 'audio/webm';
  const blob = new Blob(chunks, { type });
  chunks = [];
  setState('transcribing');
  try {
    const buf = await blob.arrayBuffer();
    let res: { transcript?: string; error?: string };
    const api = window.electronAPI?.voice;
    if (api) {
      // Electron path stays primary when present.
      res = await api.transcribe(buf, type);
    } else if (transcriberAvailable()) {
      // Web mode: same-origin server-side transcription (apiFetch carries the
      // access-token cookie and the login bearer token; the provider key stays
      // on the server).
      const resp = await apiFetch('/api/voice/transcribe', {
        method: 'POST',
        headers: { 'Content-Type': type },
        body: buf,
      });
      res = resp.ok
        ? ((await resp.json()) as { transcript?: string; error?: string })
        : { error: `voice: server replied ${resp.status}` };
    } else {
      setState('error', 'voice: bridge unavailable');
      return;
    }
    if (res.error) {
      setState('error', res.error);
      return;
    }
    const transcript = (res.transcript || '').trim();
    if (transcript) injectTranscript(transcript);
    setState('idle');
  } catch (err) {
    setState('error', `voice: ${err instanceof Error ? err.message : String(err)}`);
  }
}

function injectTranscript(text: string) {
  const store = useStore.getState();
  const paneId = store.getEffectiveActivePaneID();
  if (!paneId) return;
  const cur = store.paneInputTexts[paneId] || '';
  const sep = cur && !/\s$/.test(cur) ? ' ' : '';
  store.setPaneInputText(paneId, cur + sep + text);
  const el = document.getElementById('input-' + paneId) as HTMLInputElement | null;
  el?.focus();
}

export const voice = {
  /** Toggle recording: start when idle, stop (and transcribe) when recording. */
  toggle(): void {
    const st = useStore.getState().voiceState;
    if (st === 'recording') {
      stop();
      return;
    }
    if (st === 'transcribing') return; // busy
    void start();
  },
  /** True when a transcriber is reachable (Electron bridge or the web
   *  server's /api/voice) AND voice is enabled in config. */
  isAvailable(): boolean {
    return transcriberAvailable() && useStore.getState().voiceConfig?.enabled === true;
  },
};
