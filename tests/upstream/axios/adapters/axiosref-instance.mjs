// Strategy (a): shims axios' `create()`/default export so the unmodified
// upstream spec file runs against `new HttpService(...).axiosRef` itself -
// the object a real consumer of this package actually gets - rather than
// only its transport layer (strategy (b), ../undici-adapter.cjs). This
// exercises axiosRef's interceptor chain and config normalization
// (`buildAxiosConfig`/`normalizeAxiosRequest`), which strategy (b)
// deliberately bypasses.
//
// `axios.create(config)` here is `axiosRef.create(config)`
// (axios-ref.factory.ts): a new instance sharing the root HttpService's
// transport, with its own `defaults`/`interceptors` - not a fully
// independent HttpService/Agent the way `HttpModule.register()` would
// give you in a real Nest app, but the same object shape and the same
// `create()` code path a consumer's `axiosRef.create()` call runs.
import { createRequire } from 'node:module';

const LIB_INDEX = process.env.CONFORMANCE_REPO_LIB;
if (!LIB_INDEX) {
  throw new Error(
    'axiosref-instance shim: CONFORMANCE_REPO_LIB env var not set',
  );
}

const require = createRequire(import.meta.url);
const { HttpService } = require(LIB_INDEX);

const root = new HttpService({}, {});
const axiosRef = root.axiosRef;

export default axiosRef;
export { axiosRef };
