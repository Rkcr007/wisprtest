import {
  createLocalMemoryStore,
  parseLocalMemory,
  snapshotCounts,
} from '../background/local-memory.js';

/**
 * Options page: bind a dumped snapshot to an origin.
 *
 * This is the developer dress-rehearsal path. The worker reads the same store on attach and,
 * when the tab origin matches, skips the gateway. Nothing here talks to the page or to the
 * control plane.
 */

const store = createLocalMemoryStore(chrome.storage.local);

const originInput = document.querySelector('#origin');
const fileInput = document.querySelector('#file');
const importButton = document.querySelector('#import');
const clearButton = document.querySelector('#clear');
const status = document.querySelector('#status');

if (
  !(originInput instanceof HTMLInputElement) ||
  !(fileInput instanceof HTMLInputElement) ||
  !(importButton instanceof HTMLButtonElement) ||
  !(clearButton instanceof HTMLButtonElement) ||
  !(status instanceof HTMLElement)
) {
  throw new Error('options page is missing its controls');
}

function setStatus(message: string, tone: 'ok' | 'error' | 'idle'): void {
  if (!(status instanceof HTMLElement)) return;
  status.textContent = message;
  if (tone === 'idle') status.removeAttribute('data-tone');
  else status.dataset.tone = tone;
}

async function refresh(): Promise<void> {
  const envelope = await store.read();
  if (envelope === null) {
    setStatus('No local dump is loaded.', 'idle');
    return;
  }
  const counts = snapshotCounts(envelope.snapshot);
  setStatus(
    `Loaded for ${envelope.origin} — ${String(counts.screens)} screens, ${String(counts.elements)} elements.`,
    'ok',
  );
  if (originInput instanceof HTMLInputElement && originInput.value.trim() === '') {
    originInput.value = envelope.origin;
  }
}

async function onImport(): Promise<void> {
  const file = fileInput instanceof HTMLInputElement ? fileInput.files?.[0] : undefined;
  if (file === undefined) {
    setStatus('Choose a dump JSON file first.', 'error');
    return;
  }

  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(await file.text()) as unknown;
  } catch {
    setStatus('The file is not valid JSON.', 'error');
    return;
  }

  const origin = originInput instanceof HTMLInputElement ? originInput.value : '';
  const parsed = parseLocalMemory(parsedJson, origin);
  if (!parsed.ok) {
    setStatus(parsed.error, 'error');
    return;
  }

  await store.write(parsed.envelope);
  if (originInput instanceof HTMLInputElement) originInput.value = parsed.envelope.origin;
  const counts = snapshotCounts(parsed.envelope.snapshot);
  setStatus(
    `Loaded for ${parsed.envelope.origin} — ${String(counts.screens)} screens, ${String(counts.elements)} elements.`,
    'ok',
  );
}

async function onClear(): Promise<void> {
  await store.clear();
  if (fileInput instanceof HTMLInputElement) fileInput.value = '';
  setStatus('No local dump is loaded.', 'idle');
}

importButton.addEventListener('click', () => {
  void onImport();
});
clearButton.addEventListener('click', () => {
  void onClear();
});

void refresh();
