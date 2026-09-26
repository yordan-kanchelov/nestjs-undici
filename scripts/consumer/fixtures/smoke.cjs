'use strict';
// CommonJS consumer entry, run by run-matrix.mjs.
require('reflect-metadata');
require('./scenario.cjs')({
  lib: require('nestjs-axios-undici'),
  common: require('@nestjs/common'),
  core: require('@nestjs/core'),
  rxjs: require('rxjs'),
  label: 'cjs',
}).then(
  r => console.log(`cjs ${r}`),
  e => {
    console.error('cjs FAILED', e);
    process.exit(1);
  },
);
