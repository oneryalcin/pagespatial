import { safeDownloadStem, validateDemoFile } from './contract.mjs';
import type { DemoOutput } from './parser.ts';

function required<T extends Element>(selector: string): T {
  const element = document.querySelector<T>(selector);
  if (!element) throw new Error(`Missing demo element: ${selector}`);
  return element;
}

const form = required<HTMLFormElement>('#demo-form');
const fileInput = required<HTMLInputElement>('#demo-file');
const submit = required<HTMLButtonElement>('#demo-submit');
const clear = required<HTMLButtonElement>('#demo-clear');
const status = required<HTMLElement>('#demo-status');
const errorBox = required<HTMLElement>('#demo-error');
const results = required<HTMLElement>('#demo-results');
const resultsTitle = required<HTMLElement>('#demo-results-title');
const backendText = required<HTMLElement>('#demo-backend');
const pages = required<HTMLElement>('#demo-pages');
const markdown = required<HTMLElement>('#demo-markdown');
const json = required<HTMLElement>('#demo-json');
const reconstruction = required<HTMLImageElement>('#demo-reconstruction');
const download = required<HTMLButtonElement>('#demo-download');
const tabs = [...document.querySelectorAll<HTMLButtonElement>('[role="tab"]')];
const panels = tabs.map((tab) => required<HTMLElement>(`#${tab.getAttribute('aria-controls')}`));

let output: DemoOutput | undefined;
let selectedPage = 0;
let selectedTab = 'reconstruction';
let svgUrl: string | undefined;
let active = false;

function setStatus(message: string): void {
  status.textContent = message;
}

function showError(message: string): void {
  errorBox.textContent = message;
  errorBox.hidden = false;
  errorBox.focus();
}

function clearError(): void {
  errorBox.textContent = '';
  errorBox.hidden = true;
}

function setBusy(busy: boolean): void {
  active = busy;
  fileInput.disabled = busy;
  submit.disabled = busy || fileInput.files?.length !== 1;
}

function updateReconstruction(): void {
  if (!output) return;
  if (svgUrl) URL.revokeObjectURL(svgUrl);
  svgUrl = URL.createObjectURL(new Blob([output.reconstructions[selectedPage]!], { type: 'image/svg+xml' }));
  reconstruction.src = svgUrl;
  reconstruction.alt = `Deterministic text and layout reconstruction for page ${selectedPage + 1}`;
  for (const button of pages.querySelectorAll<HTMLButtonElement>('button')) {
    button.setAttribute('aria-current', Number(button.dataset.page) === selectedPage ? 'page' : 'false');
  }
}

function selectTab(name: string, focus = false): void {
  selectedTab = name;
  tabs.forEach((tab, index) => {
    const selected = tab.id === `tab-${name}`;
    tab.setAttribute('aria-selected', String(selected));
    tab.tabIndex = selected ? 0 : -1;
    panels[index]!.hidden = !selected;
    if (selected && focus) tab.focus();
  });
  download.textContent = `Download ${name === 'json' ? 'evidence JSON' : name}`;
}

function renderOutput(next: DemoOutput): void {
  output = next;
  selectedPage = 0;
  markdown.textContent = next.markdown;
  json.textContent = next.json;
  backendText.textContent = next.backend === 'webgpu'
    ? 'OCR ran locally with WebGPU.'
    : 'WebGPU was unavailable. OCR ran locally with WASM, which may be slower.';
  if (next.inspectorFallback) backendText.textContent += ' Structured Markdown fell back to PDF.js.';
  pages.replaceChildren(...next.document.pages.map((page, index) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = String(page.pageNumber);
    button.dataset.page = String(index);
    button.setAttribute('aria-label', `Show reconstruction for page ${page.pageNumber}`);
    button.addEventListener('click', () => {
      selectedPage = index;
      updateReconstruction();
    });
    return button;
  }));
  updateReconstruction();
  selectTab('reconstruction');
  results.hidden = false;
  clear.hidden = false;
  resultsTitle.focus();
}

function reset(): void {
  if (active) return;
  output = undefined;
  selectedPage = 0;
  fileInput.value = '';
  results.hidden = true;
  clear.hidden = true;
  pages.replaceChildren();
  markdown.textContent = '';
  json.textContent = '';
  reconstruction.removeAttribute('src');
  if (svgUrl) URL.revokeObjectURL(svgUrl);
  svgUrl = undefined;
  clearError();
  setStatus('Choose a PDF to begin.');
  setBusy(false);
  fileInput.focus();
}

fileInput.addEventListener('change', () => {
  clearError();
  submit.disabled = fileInput.files?.length !== 1;
  setStatus(fileInput.files?.length === 1 ? 'Ready to parse locally.' : 'Choose a PDF to begin.');
});

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  if (active) return;
  clearError();
  results.hidden = true;
  const file = fileInput.files?.[0];
  try {
    validateDemoFile(file);
    setBusy(true);
    let fallbackReason: string | undefined;
    const { parseDemoPdf } = await import('./parser.ts');
    const next = await parseDemoPdf(file!, {
      onStage: setStatus,
      onPage: (completed, total) => setStatus(`Parsed page ${completed} of ${total}`),
      onBackend: (backend, reason) => {
        fallbackReason = reason;
        if (backend === 'wasm') setStatus('WebGPU is unavailable. Preparing local WASM OCR, which may be slower.');
      }
    });
    renderOutput(next);
    const fallback = next.backend === 'wasm' && fallbackReason ? ' using the WASM fallback' : '';
    setStatus(`Complete — ${next.document.pages.length} ${next.document.pages.length === 1 ? 'page' : 'pages'} parsed locally${fallback}.`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/pages; limit is 4/u.test(message)) {
      showError('This demo accepts up to 4 pages. Sign in to process documents up to 200 pages.');
    } else if (/bytes; limit is/u.test(message)) {
      showError('This demo accepts PDFs up to 20 MiB.');
    } else {
      showError(`Local parsing stopped. ${message}`);
    }
    setStatus('No document bytes were uploaded.');
  } finally {
    setBusy(false);
  }
});

clear.addEventListener('click', reset);

tabs.forEach((tab, index) => {
  tab.addEventListener('click', () => selectTab(tab.id.replace('tab-', '')));
  tab.addEventListener('keydown', (event) => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const nextIndex = event.key === 'Home'
      ? 0
      : event.key === 'End'
        ? tabs.length - 1
        : (index + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length;
    selectTab(tabs[nextIndex]!.id.replace('tab-', ''), true);
  });
});

download.addEventListener('click', () => {
  if (!output) return;
  const stem = safeDownloadStem(fileInput.files?.[0]?.name);
  const data = selectedTab === 'json'
    ? { body: output.json, type: 'application/json', extension: 'pagespatial.json' }
    : selectedTab === 'markdown'
      ? { body: output.markdown, type: 'text/markdown', extension: 'md' }
      : { body: output.reconstructions[selectedPage]!, type: 'image/svg+xml', extension: `page-${selectedPage + 1}.svg` };
  const url = URL.createObjectURL(new Blob([data.body], { type: data.type }));
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = `${stem}.${data.extension}`;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 0);
  setStatus(`Downloaded ${anchor.download}.`);
});

window.addEventListener('pagehide', () => {
  if (svgUrl) URL.revokeObjectURL(svgUrl);
});
