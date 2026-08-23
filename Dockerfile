# syntax=docker/dockerfile:1
# parse-service deployment image (design doc 2026-08-23, workstream 1 / M1).
#
# TARGET PLATFORM IS linux/amd64 AND IT IS LOAD-BEARING: OpenVINO HPI is
# x86-only. Built for arm64, the sidecar truthfully reports
# ep=paddle-default and the container is NOT the deployment unit — an arm64
# image may exist as a local dev artifact only. Build with:
#
#   docker build --platform=linux/amd64 -t pagespatial-service .
#
# RUN WITH AN INIT THAT REAPS — this is part of the shutdown contract:
#
#   docker run --init -p 8571:8571 pagespatial-service
#
# (or a tini entrypoint / k8s shareProcessNamespace equivalent). PID 1
# changes default signal handling and orphan reaping; the graceful path
# (SIGTERM -> ParseService.shutdown awaits every worker's exit -> each
# worker's exit hook group-kills its Python sidecar) is init-independent,
# but the SIGKILL fallback path reparents detached Python groups to PID 1
# and a non-reaping Node PID 1 would accumulate zombies.
#
# One image, both runtimes (Node + Python): the sidecar protocol passes
# pages as filesystem paths in a mkdtemp directory, so the Python engine
# must share the Node workers' filesystem. Image size budget ~2 GB
# (paddle + OpenVINO — see docs/trials/2026-08-22-sidecar-adoption-ceremony.md).

########################################################################
# Stage 1 — builder: compile TypeScript -> dist/ with the full dev tree.
########################################################################
FROM --platform=linux/amd64 node:26-bookworm-slim AS builder
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
COPY schemas ./schemas
COPY scripts/generate-schema.mjs ./scripts/generate-schema.mjs
RUN npm run build

########################################################################
# Stage 2 — models: bake the PINNED PP-OCRv6 weights. fetch_models.py in
# verify mode downloads the exact committed revisions and exits non-zero
# on ANY hash mismatch — the build FAILS rather than baking weights the
# adoption ceremony's lineage did not validate.
########################################################################
FROM --platform=linux/amd64 python:3.11-slim-bookworm AS models
RUN pip install --no-cache-dir huggingface_hub==0.36.0
COPY service/sidecar/fetch_models.py service/sidecar/model-pins.json /sidecar/
RUN python /sidecar/fetch_models.py --models-dir /opt/models

########################################################################
# Stage 3 — runtime: Debian slim + Node + Python 3.11 venv + poppler +
# tesseract + pinned paddle with HPI deps. Non-root. No corpus data.
########################################################################
FROM --platform=linux/amd64 node:26-bookworm-slim AS runtime

# bookworm's python3 IS 3.11 (deb package python3.11). libgl1/libglib2.0-0/
# libgomp1 are paddle's runtime shared-library needs (same set the HPI
# benchmark/ceremony images used); poppler-utils provides pdftoppm (render
# stage), tesseract-ocr the cross-family second opinion.
RUN apt-get update && apt-get install -y --no-install-recommends \
      python3.11 python3.11-venv \
      poppler-utils tesseract-ocr \
      libgl1 libglib2.0-0 libgomp1 \
    && rm -rf /var/lib/apt/lists/*

# Engine pins. These MUST equal the versions in DEFAULT_PYTHON_CMD
# (service/adapters/ppocr-sidecar.mjs) — asserted at build time below; a
# drift fails the build (the ceremony validated weights AND engine).
ARG PADDLEOCR_PIN=3.7.0
ARG PADDLEPADDLE_PIN=3.2.1
# install_hpi_deps shells out to a bare `paddlex`, so the venv bin must be
# on PATH for THIS command. The subsequent import assertion makes the HPI
# runtime a build-time guarantee: a build without ultra_infer (the OpenVINO
# HPI engine) must fail loudly, never ship as a silent paddle-default image
# (that exact silent failure happened once: a swallowed FileNotFoundError
# behind an `|| true`).
RUN python3.11 -m venv /opt/paddle \
    && /opt/paddle/bin/pip install --no-cache-dir setuptools \
       paddleocr==${PADDLEOCR_PIN} paddlepaddle==${PADDLEPADDLE_PIN} \
    && PATH="/opt/paddle/bin:$PATH" /opt/paddle/bin/paddleocr install_hpi_deps cpu \
    && /opt/paddle/bin/python -c "import ultra_infer, paddle2onnx"

WORKDIR /app
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/schemas ./schemas
COPY package.json ./
COPY service ./service
COPY scripts/assert-engine-pins.mjs ./scripts/assert-engine-pins.mjs

# Build-time assertions, both directions: the pip pins equal
# DEFAULT_PYTHON_CMD's pins, and the venv actually resolved those versions.
RUN node scripts/assert-engine-pins.mjs \
      "paddleocr==${PADDLEOCR_PIN}" "paddlepaddle==${PADDLEPADDLE_PIN}" \
    && /opt/paddle/bin/python -c "import importlib.metadata as m, sys; \
       pins = {'paddleocr': '${PADDLEOCR_PIN}', 'paddlepaddle': '${PADDLEPADDLE_PIN}'}; \
       bad = {p: (m.version(p), v) for p, v in pins.items() if m.version(p) != v}; \
       sys.exit(f'venv/pin drift: {bad}' if bad else 0)"

COPY --from=models /opt/models /opt/models

# The baked interpreter — NOT the uv default: left unset, every worker
# would re-resolve the paddle environment through uv at runtime (network at
# boot inside a container that already contains the packages).
ENV SERVICE_OCR_ADAPTER=ppocr-sidecar \
    SERVICE_SIDECAR_PYTHON=/opt/paddle/bin/python \
    SERVICE_SIDECAR_MODELS_DIR=/opt/models \
    SERVICE_SIDECAR_THREADS=1 \
    SERVICE_DATA_DIR=/data \
    PORT=8571 \
    PATH=/opt/paddle/bin:$PATH

RUN useradd --create-home --uid 10001 pagespatial \
    && mkdir -p /data && chown pagespatial:pagespatial /data
USER pagespatial

EXPOSE 8571
# Boot fails closed (model-pin verification + sidecar --check), then the
# /health warm-up gates readiness — point the readiness probe at /health.
CMD ["node", "service/server.mjs"]
