#!/usr/bin/env node
import { startRuntime } from './runtime.mjs';

const runtime = await startRuntime();
let closing = false;
const close = async () => {
  if (closing) return;
  closing = true;
  await runtime.close();
};

process.once('SIGTERM', close);
process.once('SIGINT', close);
