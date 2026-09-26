---
'nestjs-axios-undici': patch
---

Require Node.js 22.17 or later (`engines.node` was `>=22.12.0`). On Node.js 22.12-22.16, an ESM app on NestJS 12 that imports this package can fail to start (`ReferenceError: Cannot access 'isUndefined' before initialization` from `@nestjs/common`, an issue with Node.js loading the ESM-only NestJS 12 from a CommonJS package). Node.js 22.17+ works with every supported NestJS and `undici` 7 version; `undici` 8 itself requires Node.js 22.19+.
