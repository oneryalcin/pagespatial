# Security

PageSpatial processes untrusted document-derived content. Adapters must enforce input-size, page-count, decompression, timeout, concurrency, and memory limits appropriate to their runtime.

The core does not provide authorization. Callers must enforce tenant access, deletion state, canonical revision selection, and data-retention policy before parsing, indexing, retrieval, or model escalation.

Do not send page images or observations to a remote adapter unless the caller has explicitly authorized that data boundary. Record the selected adapter and backend in provenance.

Markdown projections have `trust: "untrusted-document-content"`. They may contain HTML, links, scripts, instructions, or other attacker-controlled document text. Sanitize them before HTML rendering. When sending them to an LLM, delimit them as untrusted evidence and do not allow document text to change system instructions or tool authority.

Do not report vulnerabilities in public issues while this repository is private. Contact the repository owner directly.
