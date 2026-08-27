const MAX_INPUT_BYTES = 90 * 1024 * 1024;

const form = document.querySelector('[data-upload-form]');
const fileInput = document.querySelector('[data-upload-file]');
const submit = document.querySelector('[data-upload-submit]');
const status = document.querySelector('[data-upload-status]');
const progress = document.querySelector('[data-upload-progress]');
const detail = document.querySelector('[data-upload-detail]');

let attempt = null;

function setStatus(message, extra = '') {
  status.textContent = message;
  detail.textContent = extra;
}

function resetAttempt() {
  attempt = null;
  progress.hidden = true;
  progress.removeAttribute('value');
  progress.textContent = '';
  setStatus('Ready to submit.', 'SHA-256 is calculated in this browser before upload.');
}

function hex(buffer) {
  return [...new Uint8Array(buffer)]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

async function responseJson(response) {
  const body = await response.json().catch(() => null);
  if (response.ok) return body;
  const message = body?.error?.message ?? 'The request could not be completed.';
  const requestId = body?.error?.request_id;
  throw new Error(requestId ? `${message} Request ID: ${requestId}` : message);
}

async function createJob(digest) {
  const response = await fetch('/jobs', {
    method: 'POST',
    credentials: 'same-origin',
    headers: {
      'content-type': 'application/json',
      'idempotency-key': attempt.idempotencyKey,
    },
    body: JSON.stringify({ input_sha256: digest }),
  });
  return responseJson(response);
}

function uploadPdf(file, grant) {
  return new Promise((resolve, reject) => {
    const request = new XMLHttpRequest();
    request.open(grant.method, grant.url);
    for (const [name, value] of Object.entries(grant.headers)) request.setRequestHeader(name, value);
    request.upload.addEventListener('progress', (event) => {
      if (!event.lengthComputable) return;
      progress.hidden = false;
      progress.max = event.total;
      progress.value = event.loaded;
      const percentage = Math.floor(event.loaded / event.total * 100);
      progress.textContent = `${percentage}% uploaded`;
      setStatus('Uploading PDF…', `${percentage}% of bytes sent to storage. Parsing has not started.`);
    });
    request.addEventListener('load', () => {
      if (request.status >= 200 && request.status < 300) resolve();
      else reject(new Error('The PDF upload did not complete. Try again before the upload grant expires.'));
    });
    request.addEventListener('error', () => reject(new Error('The PDF upload could not reach storage. Check your connection and try again.')));
    request.addEventListener('abort', () => reject(new Error('The PDF upload was cancelled.')));
    request.send(file);
  });
}

async function finalizeJob(jobId) {
  const response = await fetch(`/jobs/${jobId}/finalize`, {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json' },
    body: '{}',
  });
  return responseJson(response);
}

fileInput.addEventListener('change', resetAttempt);

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  const file = fileInput.files?.[0];
  if (!file) {
    setStatus('Choose a PDF first.');
    fileInput.focus();
    return;
  }
  if (file.size < 1) {
    setStatus('The selected file is empty.');
    fileInput.focus();
    return;
  }
  if (file.size > MAX_INPUT_BYTES) {
    setStatus('The PDF exceeds the 90 MiB limit.', 'Split the PDF, then submit each part separately.');
    fileInput.focus();
    return;
  }
  if (!globalThis.crypto?.subtle || typeof globalThis.crypto.randomUUID !== 'function') {
    setStatus('This browser cannot submit PDFs securely.', 'Use a current browser or follow the API guide.');
    return;
  }

  submit.disabled = true;
  fileInput.disabled = true;
  try {
    if (!attempt) {
      setStatus('Calculating SHA-256…', 'This happens in your browser before upload.');
      const digest = hex(await crypto.subtle.digest('SHA-256', await file.arrayBuffer()));
      attempt = {
        digest, idempotencyKey: crypto.randomUUID(), job: null, upload: null, uploaded: false,
      };
    }
    if (!attempt.job || (attempt.job.state === 'uploading' && !attempt.upload && !attempt.uploaded)) {
      setStatus('Creating job…');
      const created = await createJob(attempt.digest);
      attempt.job = created.job;
      attempt.upload = created.upload;
    }
    if (!attempt.upload && attempt.job.state !== 'uploading') {
      location.assign(`/jobs/${attempt.job.id}`);
      return;
    }
    if (!attempt.upload) {
      throw new Error('The upload grant is no longer available. Reload this page and start a new submission.');
    }
    if (!attempt.uploaded) {
      setStatus('Uploading PDF…', 'Progress measures bytes sent to storage, not parsing.');
      try {
        await uploadPdf(file, attempt.upload);
        attempt.uploaded = true;
      } catch (error) {
        attempt.upload = null;
        throw error;
      }
    }
    setStatus('Finalizing upload…', 'PageSpatial is validating the stored object.');
    const finalized = await finalizeJob(attempt.job.id);
    location.assign(`/jobs/${finalized.job.id}`);
  } catch (error) {
    setStatus('Submission stopped.', error instanceof Error ? error.message : 'Try again.');
    submit.disabled = false;
    fileInput.disabled = false;
  }
});
