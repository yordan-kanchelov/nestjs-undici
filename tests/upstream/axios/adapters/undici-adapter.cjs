// Strategy (b): an axios `adapter` function backed by this package's own
// transport/response/error code (not its interceptor/config-normalization
// pipeline, and not axiosRef - see ../../nestjs-axios/ for the sibling
// suite that exercises axiosRef itself, and tests/upstream/README.md for
// why both strategies exist).
//
// Contract reminder (axios' lib/core/dispatchRequest.js): by the time
// `adapter(config)` runs, axios has already applied `transformRequest`
// (config.data is the final wire body) and merged defaults into `config`;
// the adapter must build the full URL itself (baseURL + url) and return
// `{ data, status, statusText, headers, config, request }` with `data`
// still UNTRANSFORMED (axios applies `transformResponse` afterwards) -
// exactly the shape `toAxiosLikeResponse` already produces for
// HttpService's own response path.
'use strict';

const { Agent, request: undiciRequest } = require('undici');

const LIB_DIR = process.env.CONFORMANCE_LIB_DIR;
if (!LIB_DIR) {
  throw new Error('undici-adapter: CONFORMANCE_LIB_DIR env var not set');
}
const path = require('node:path');
const { toAxiosLikeResponse, RequestInfo } = require(
  path.join(LIB_DIR, 'adapters', 'axios-response.adapter.js'),
);
const {
  toAxiosError,
  createTimeoutError,
  createUnsupportedProtocolError,
  isDeadlineTimeoutReason,
} = require(path.join(LIB_DIR, 'errors', 'axios-error.js'));
const {
  DEFAULT_MAX_REDIRECTS,
  isRedirectResponse,
  buildRedirectHop,
  createTooManyRedirectsError,
  dumpRedirectBody,
  urlToString,
} = require(path.join(LIB_DIR, 'adapters', 'redirect.adapter.js'));

const SUPPORTED_PROTOCOLS = new Set(['http:', 'https:']);

function unsupportedProtocol(url) {
  let protocol;
  try {
    protocol = new URL(String(url)).protocol;
  } catch {
    return undefined;
  }
  return SUPPORTED_PROTOCOLS.has(protocol) ? undefined : protocol;
}

// Real axios' http adapter listens to the legacy `cancelToken.promise`
// alongside `config.signal`. Without this, `should support cancel` (which
// only sets `cancelToken`, not `AbortController`) hangs for the full test
// timeout, and its fixture server (a fixed port, not an ephemeral one) is
// then never closed - every later test that reuses that port fails closed
// with `EADDRINUSE`. See tests/upstream/README.md's "harness limitation"
// note for the rest of that cascade.
function resolveSignal(config) {
  if (!config.cancelToken) return config.signal;
  const controller = new AbortController();
  if (config.signal) {
    if (config.signal.aborted) controller.abort(config.signal.reason);
    else
      config.signal.addEventListener('abort', () =>
        controller.abort(config.signal.reason),
      );
  }
  config.cancelToken.promise.then(
    reason => controller.abort(reason),
    () => {},
  );
  return controller.signal;
}

function makeAdapter({ buildFullPath }) {
  return async function undiciAdapter(config) {
    const headers = config.headers?.toJSON
      ? config.headers.toJSON()
      : { ...config.headers };
    const fullPath = buildFullPath(
      config.baseURL,
      config.url,
      config.allowAbsoluteUrls,
      config,
    );

    const userSignal = resolveSignal(config);
    const controller = new AbortController();
    if (userSignal) {
      if (userSignal.aborted) controller.abort(userSignal.reason);
      else
        userSignal.addEventListener('abort', () =>
          controller.abort(userSignal.reason),
        );
    }

    // A malformed (non-numeric) `config.timeout` must fail fast with axios'
    // own `ERR_BAD_OPTION_VALUE`, matching axios' http adapter (`parseInt`
    // check) - not merely as a matter of conformance: calling
    // `setTimeout(fn, NaN)` (Node coerces a non-number delay to ~1ms) fires
    // the deadline almost immediately, racing undici's own connection setup
    // for that origin. That race was traced (bisecting the harness hang
    // this file's header describes) to a leaked pool slot on the shared
    // global undici Agent: once one request to an origin is aborted at
    // exactly the wrong moment, every later request to that same origin
    // hangs forever waiting for a connection slot that never frees - which
    // is exactly what stalled the suite from "should wrap HTTP errors and
    // keep stack" onward (same fixed-port origin reused by dozens of later
    // tests) before this check was added.
    if (config.timeout !== undefined) {
      const parsed = parseInt(config.timeout, 10);
      if (
        !Number.isFinite(parsed) ||
        String(parsed) !== String(config.timeout).trim()
      ) {
        const err = new Error('error trying to parse `config.timeout` to int');
        err.code = 'ERR_BAD_OPTION_VALUE';
        err.config = config;
        throw err;
      }
    }

    // A deadline timer matching HttpService.executeRequest's own: one
    // timeout for the whole redirect chain, tagged so the `fail()` path
    // below can tell "the deadline fired" apart from "the caller aborted",
    // and build axios' exact timeout message/code either way.
    let deadlineTimer;
    if (config.timeout) {
      deadlineTimer = setTimeout(() => {
        controller.abort({
          axiosDeadlineTimeout: true,
          timeout: config.timeout,
          timeoutErrorMessage: config.timeoutErrorMessage,
          clarifyTimeoutError: config.transitional?.clarifyTimeoutError,
        });
      }, config.timeout);
    }
    const clearDeadline = () => {
      if (deadlineTimer !== undefined) clearTimeout(deadlineTimer);
    };

    const interceptorRequest = {
      url: fullPath,
      options: {
        maxContentLength:
          config.maxContentLength > -1 ? config.maxContentLength : undefined,
        responseType: config.responseType,
        decompress: config.decompress !== false,
        validateStatus:
          config.validateStatus === null ? () => true : config.validateStatus,
        signal: controller.signal,
      },
    };

    const badProtocol = unsupportedProtocol(fullPath);
    if (badProtocol) {
      clearDeadline();
      const err = createUnsupportedProtocolError(
        badProtocol,
        interceptorRequest,
      );
      err.config = config;
      throw err;
    }

    let currentUrl = fullPath;
    let currentOptions = {
      method: (config.method || 'get').toUpperCase(),
      headers,
      body: config.data,
    };
    let redirectCount = 0;
    const maxRedirects =
      config.maxRedirects === undefined
        ? DEFAULT_MAX_REDIRECTS
        : config.maxRedirects;

    // `maxBodyLength`: a string/Buffer body is checked synchronously before
    // ever dispatching, matching HttpService.executeRequest.
    const currentBodyLength =
      typeof currentOptions.body === 'string'
        ? Buffer.byteLength(currentOptions.body)
        : Buffer.isBuffer(currentOptions.body)
          ? currentOptions.body.length
          : undefined;
    if (
      config.maxBodyLength !== undefined &&
      config.maxBodyLength > -1 &&
      currentBodyLength !== undefined &&
      currentBodyLength > config.maxBodyLength
    ) {
      clearDeadline();
      const err = new Error(`Request body larger than maxBodyLength limit`);
      err.code = 'ERR_FR_MAX_BODY_LENGTH_EXCEEDED';
      err.config = config;
      throw err;
    }

    // A dedicated Agent per call, destroyed unconditionally below, rather
    // than the shared global one `undici.request()` would otherwise use.
    // Bisecting the harness hang this file's header describes traced it
    // here: several tests in a row deliberately fail a redirect hop for
    // security reasons (a thrown `beforeRedirect`, a cross-origin
    // sensitiveHeaders check), and even with every response body drained
    // (see the `buildRedirectHop` try/catch below), something about that
    // sequence left the *shared* global Agent's pool for the suite's fixed
    // test port unable to open a new connection a few tests later - every
    // later request to that same origin then hung until the test's own
    // timeout, compounding across the rest of the file. A private Agent,
    // torn down after every call, can't accumulate that kind of state
    // across tests, matching the "give each scenario a fresh dispatcher"
    // follow-up already noted for tests/compat/differential/harness.ts.
    const dispatcher = new Agent({ connections: 4 });
    const destroyDispatcher = () => {
      dispatcher.destroy().catch(() => {});
    };

    try {
      while (true) {
        const dispatchOptions = {
          method: currentOptions.method,
          headers: currentOptions.headers,
          body: currentOptions.body,
          signal: controller.signal,
          dispatcher,
          // axios' own http adapter defaults to Node's global http(s).Agent,
          // which defaults to `keepAlive: false` (closes the socket after
          // each response) unless the caller supplies its own keep-alive
          // agent.
          reset: true,
        };
        const res = await undiciRequest(currentUrl, dispatchOptions);
        const location = res.headers.location;

        if (
          isRedirectResponse(res.statusCode, location) &&
          maxRedirects !== 0
        ) {
          redirectCount++;
          if (redirectCount > maxRedirects) {
            await dumpRedirectBody(res.body);
            clearDeadline();
            const err = createTooManyRedirectsError();
            err.config = config;
            throw err;
          }
          // `buildRedirectHop` can throw synchronously (e.g. a same-origin
          // security check on sensitiveHeaders) - `res.body` must be drained
          // on *that* path too, matching HttpService.executeRequest exactly.
          // Forgetting this (an adapter-only bug, not in src/) was the real
          // cause of the harness hang bisected here: an undrained undici
          // response body leaks its connection, and enough of those (this
          // suite has several security-check tests in a row) exhausts
          // something later requests to the same fixed-port origin then
          // wait forever for - it isn't the network, so the per-test
          // timeout, on its own, can't recover from it.
          let hop;
          try {
            hop = buildRedirectHop({
              currentUrl: urlToString(currentUrl),
              location,
              statusCode: res.statusCode,
              method: currentOptions.method,
              headers: currentOptions.headers,
              body: currentOptions.body,
              responseHeaders: res.headers,
              beforeRedirect: config.beforeRedirect,
            });
          } catch (hopError) {
            await dumpRedirectBody(res.body);
            throw hopError;
          }
          await dumpRedirectBody(res.body);
          currentUrl = hop.url;
          currentOptions = {
            method: hop.method,
            headers: hop.headers,
            body: hop.body,
          };
          continue;
        }

        clearDeadline();
        const requestInfo = new RequestInfo(
          currentUrl,
          currentOptions.method,
          currentUrl,
        );
        const axiosLikeResponse = await toAxiosLikeResponse(
          interceptorRequest,
          res,
          requestInfo,
        );
        axiosLikeResponse.config = config;
        // For `responseType: 'stream'`, `axiosLikeResponse.data` is the
        // still-unconsumed undici response body: destroying the dispatcher
        // now can abort it before the caller ever reads it. Deferred until
        // the stream itself ends, errors, or is closed.
        if (config.responseType === 'stream') {
          axiosLikeResponse.data.once('close', destroyDispatcher);
        } else {
          destroyDispatcher();
        }
        return axiosLikeResponse;
      }
    } catch (error) {
      destroyDispatcher();
      clearDeadline();
      const requestInfo = new RequestInfo(currentUrl, currentOptions.method);
      let err;
      if (isDeadlineTimeoutReason(controller.signal.reason)) {
        err = createTimeoutError(
          controller.signal.reason,
          interceptorRequest,
          requestInfo,
        );
      } else {
        err = toAxiosError(
          error,
          interceptorRequest,
          controller.signal,
          requestInfo,
        );
      }
      // Our error/response objects build `.config` lazily from the minimal
      // `interceptorRequest` above (no real axios config set) - override
      // with the real one axios's own http adapter would have set, since
      // dispatchRequest re-runs `transformResponse` against
      // `reason.response` and callers read `error.config`.
      if (err && typeof err === 'object') {
        err.config = config;
        if (err.response) err.response.config = config;
      }
      throw err;
    }
  };
}

module.exports = { makeAdapter };
