#!/usr/bin/env node
// Runs every upstream conformance suite: `npm run test:upstream`.
// Builds lib/ once, then hands both suites `--skip-build` so they don't
// each rebuild it again.
import { main as runNestjsAxios } from './nestjs-axios/run.mjs';
import { main as runAxios } from './axios/run.mjs';
import { buildLib } from './lib/conformance.mjs';

buildLib();

const nestjsAxiosStatus = await runNestjsAxios(['--skip-build']);
const axiosStatus = await runAxios(['--skip-build']);

process.exit(nestjsAxiosStatus || axiosStatus ? 1 : 0);
