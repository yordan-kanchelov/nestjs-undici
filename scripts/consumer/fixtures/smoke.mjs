// ESM consumer entry, run by run-matrix.mjs.
import 'reflect-metadata';
import { createRequire } from 'node:module';
// Named ESM imports: fails at link time if cjs-module-lexer can't see the exports
import {
  HttpModule,
  HttpService,
  AxiosError,
  isAxiosError,
} from 'nestjs-axios-undici';
import * as common from '@nestjs/common';
import * as core from '@nestjs/core';
import * as rxjs from 'rxjs';
import * as esm from 'nestjs-axios-undici';

const require = createRequire(import.meta.url);

// Every CommonJS export must also be importable by name from ESM
const hidden = Object.keys(require('nestjs-axios-undici')).filter(
  name => name !== '__esModule' && !(name in esm),
);
if (hidden.length) {
  console.error(`esm FAILED: exports not visible to ESM: ${hidden.join(', ')}`);
  process.exit(1);
}

const run = require('./scenario.cjs');
run({
  lib: { HttpModule, HttpService, AxiosError, isAxiosError },
  common,
  core,
  rxjs,
  label: 'esm',
}).then(
  r => console.log(`esm ${r}`),
  e => {
    console.error('esm FAILED', e);
    process.exit(1);
  },
);
