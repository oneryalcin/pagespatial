(() => {
  'use strict';

  const root = document.querySelector('[data-result-viewer]');
  if (!root) return;
  root.hidden = false;
  const status = root.querySelector('[data-viewer-status]');
  const content = root.querySelector('[data-viewer-content]');
  const pageNode = root.querySelector('[data-viewer-page]');
  const provenance = root.querySelector('[data-viewer-provenance] dl');
  const position = root.querySelector('[data-page-position]');
  const previous = root.querySelector('[data-page-previous]');
  const next = root.querySelector('[data-page-next]');
  const provenanceFields = [
    ['Parser', 'parserName'],
    ['Parser version', 'parserVersion'],
    ['Native adapter', 'nativeAdapter'],
    ['OCR adapter', 'ocrAdapter'],
    ['Region recovery', 'regionRecoveryAdapter'],
    ['Renderer', 'renderer'],
    ['Backend', 'backend'],
  ];
  const allowedTags = Object.freeze([
    'h2', 'h3', 'h4', 'h5', 'h6', 'p', 'ul', 'ol', 'li', 'blockquote',
    'strong', 'em', 'code', 'pre', 'hr', 'br', 'table', 'thead', 'tbody',
    'tr', 'th', 'td', 'a',
  ]);
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  const sha256 = /^[0-9a-f]{64}$/i;
  const maxViewerBytes = 16 * 1024 * 1024;

  function fail(message) {
    status.textContent = message;
    status.classList.add('viewer-status--error');
    content.hidden = true;
    window.dispatchEvent(new CustomEvent('pagespatial:result-error'));
  }

  function object(value) {
    return value && typeof value === 'object' && !Array.isArray(value);
  }

  function validateEnvelope(value) {
    if (!object(value) || value.representation !== 'compact'
        || value.schema_version !== 'pagespatial-compact-v1'
        || value.job_id !== root.dataset.jobId || !uuid.test(value.attempt_id ?? '')
        || !sha256.test(value.input_sha256 ?? '')
        || !Number.isInteger(value.page_count) || value.page_count < 1
        || value.page_count > 200 || !Array.isArray(value.pages)
        || value.pages.length !== value.page_count) {
      throw new TypeError('invalid compact envelope');
    }
    for (let index = 0; index < value.pages.length; index += 1) {
      const entry = value.pages[index];
      if (!object(entry) || entry.page_number !== undefined
          && entry.page_number !== index + 1) {
        throw new TypeError('invalid compact page');
      }
      if (entry.ok) {
        if (!object(entry.page_compact) || !object(entry.page_compact.projection)
            || typeof entry.page_compact.projection.markdown !== 'string'
            || !object(entry.page_compact.provenance)) {
          throw new TypeError('invalid compact page projection');
        }
      }
    }
    return value;
  }

  function markdownRenderer() {
    const md = window.markdownit({ html: false, linkify: false, typographer: false });
    md.validateLink = (href) => {
      try { return /^https:\/\//iu.test(href) && new URL(href).protocol === 'https:'; } catch { return false; }
    };
    const heading = md.renderer.rules.heading_open
      ?? ((tokens, index, options, _environment, self) => self.renderToken(tokens, index, options));
    md.renderer.rules.heading_open = (tokens, index, options, environment, self) => {
      const level = Math.min(6, Number(tokens[index].tag.slice(1)) + 1);
      tokens[index].tag = `h${level}`;
      return heading(tokens, index, options, environment, self);
    };
    md.renderer.rules.heading_close = (tokens, index, options, environment, self) => {
      const level = Math.min(6, Number(tokens[index].tag.slice(1)) + 1);
      tokens[index].tag = `h${level}`;
      return self.renderToken(tokens, index, options, environment);
    };
    return md;
  }

  const md = markdownRenderer();
  let envelope;
  let selected = 0;

  function addDefinition(label, value) {
    if (typeof value !== 'string' || !value) return;
    const wrapper = document.createElement('div');
    const term = document.createElement('dt');
    const detail = document.createElement('dd');
    term.textContent = label;
    detail.textContent = value;
    wrapper.append(term, detail);
    provenance.append(wrapper);
  }

  function render() {
    const entry = envelope.pages[selected];
    pageNode.replaceChildren();
    provenance.replaceChildren();
    if (entry.ok) {
      const projection = entry.page_compact.projection;
      const fragment = window.DOMPurify.sanitize(md.render(projection.markdown), {
        ALLOWED_TAGS: allowedTags,
        ALLOWED_ATTR: ['href', 'title', 'rel', 'target', 'referrerpolicy'],
        ALLOW_DATA_ATTR: false,
        ALLOW_ARIA_ATTR: false,
        FORBID_TAGS: ['script', 'style', 'img', 'svg', 'math', 'form', 'input', 'iframe'],
        RETURN_DOM_FRAGMENT: true,
      });
      for (const link of fragment.querySelectorAll('a')) {
        const href = link.getAttribute('href') ?? '';
        let safe = false;
        try { safe = /^https:\/\//iu.test(href) && new URL(href).protocol === 'https:'; } catch {}
        if (!safe) {
          link.replaceWith(document.createTextNode(link.textContent));
          continue;
        }
        link.target = '_blank';
        link.rel = 'noopener noreferrer';
        link.referrerPolicy = 'no-referrer';
      }
      pageNode.append(fragment);
      addDefinition('Projection format', projection.format);
      addDefinition(
        'Markdown source', entry.page_compact.projection.markdownSource,
      );
      for (const [label, field] of provenanceFields) {
        addDefinition(label, entry.page_compact.provenance[field]);
      }
    } else {
      const heading = document.createElement('h2');
      const message = document.createElement('p');
      heading.textContent = 'Page could not be parsed';
      message.textContent = entry.failure?.message ?? 'Page could not be parsed.';
      pageNode.append(heading, message);
    }
    position.textContent = `Page ${selected + 1} of ${envelope.page_count}`;
    previous.disabled = selected === 0;
    next.disabled = selected === envelope.page_count - 1;
    status.textContent = entry.ok
      ? `Page ${selected + 1} of ${envelope.page_count} loaded.`
      : `Page ${selected + 1} of ${envelope.page_count} failed.`;
  }

  previous.addEventListener('click', () => {
    if (selected > 0) { selected -= 1; render(); }
  });
  next.addEventListener('click', () => {
    if (selected < envelope.page_count - 1) { selected += 1; render(); }
  });

  const expectedBytes = Number(root.dataset.compactBytes);
  const expectedDigest = root.dataset.compactDigest;
  if (expectedBytes > maxViewerBytes) {
    fail('This compact result is too large for the browser viewer. Download its JSON instead.');
    return;
  }
  if (!Number.isSafeInteger(expectedBytes) || expectedBytes < 1
      || !sha256.test(expectedDigest ?? '')) {
    fail('The compact result metadata is invalid. Download its JSON or try again.');
    return;
  }
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), 30_000);
  fetch(root.dataset.compactUrl, {
    cache: 'no-store', credentials: 'same-origin', signal: controller.signal,
  })
    .then((response) => {
      if (!response.ok) throw new Error('compact result request failed');
      return response.arrayBuffer();
    })
    .then(async (bytes) => {
      if (bytes.byteLength !== expectedBytes) throw new Error('compact result size mismatch');
      const digestBytes = await crypto.subtle.digest('SHA-256', bytes);
      const digest = [...new Uint8Array(digestBytes)]
        .map((byte) => byte.toString(16).padStart(2, '0')).join('');
      if (digest !== expectedDigest) throw new Error('compact result digest mismatch');
      const value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
      envelope = validateEnvelope(value);
      content.hidden = false;
      render();
      window.dispatchEvent(new CustomEvent('pagespatial:result-ready'));
    })
    .catch(() => fail('The compact result could not be loaded. Use a JSON download or try again.'))
    .finally(() => window.clearTimeout(timeout));
})();
