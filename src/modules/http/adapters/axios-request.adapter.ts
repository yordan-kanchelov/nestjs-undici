import { PassThrough, Readable } from 'stream';
import type { UrlObject } from 'node:url';
import type {
  AxiosCancelTokenLike,
  AxiosLikeRequestConfig,
  AxiosParamsSerializer,
  FormDataVisitorHelpers,
  FormSerializerOptions,
  InternalAxiosLikeRequestConfig,
  SerializerVisitor,
} from '../interfaces/axios-compatible.interface';
import type { AxiosRefDefaults } from '../interfaces/axios-ref.interface';
import type { HttpInterceptorRequest } from '../interfaces/http-interceptor.interface';
import { AxiosHeaders, sanitizeHeaderValue } from '../interfaces/axios-headers';
import { AxiosError } from '../errors/axios-error';

/**
 * Per-service context used when normalising a request.
 */
export interface AxiosRequestContext {
  /** Live `httpService.axiosRef.defaults` object */
  defaults?: AxiosRefDefaults;
  /** Module-level (register/registerAsync) request options */
  instanceOptions?: Record<string, any>;
}

type Url = string | URL | UrlObject;

type HeaderRecord = Record<string, any>;

const FORM_URLENCODED = 'application/x-www-form-urlencoded';

/**
 * Keys understood by this adapter that must not be forwarded to undici.
 */
const AXIOS_ONLY_KEYS = [
  'url',
  'baseURL',
  'params',
  'paramsSerializer',
  'data',
  'auth',
  'cancelToken',
  'maxRedirects',
] as const;

// ---------------------------------------------------------------------------
// URL helpers (ported from axios/lib/helpers so the resulting URLs match)
// ---------------------------------------------------------------------------

/**
 * Same as axios' `isAbsoluteURL`: `<scheme>://` or protocol-relative `//`.
 */
export function isAbsoluteURL(url: string): boolean {
  return /^([a-z][a-z\d+\-.]*:)?\/\//i.test(url);
}

/**
 * Same as axios' `combineURLs`: plain string concatenation, so a path on the
 * baseURL is preserved (`http://api/v1` + `/users` => `http://api/v1/users`).
 */
export function combineURLs(baseURL: string, relativeURL: string): string {
  return relativeURL
    ? baseURL.replace(/\/+$/, '') + '/' + relativeURL.replace(/^\/+/, '')
    : baseURL;
}

/**
 * `decodeURIComponent`, falling back to the raw (still-encoded) value on a
 * malformed sequence instead of throwing - same as axios' own
 * `decodeURIComponentSafe`.
 */
function decodeURIComponentSafe(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/**
 * Credentials embedded in a URL (`http://user:pass@host`), as axios reads
 * them: percent-decoded, only used as `auth` when the caller didn't set
 * `config.auth` explicitly (checked by the caller), and stripped from the
 * URL string returned here - undici's own `new URL()` parsing already keeps
 * them out of the `Host` header and request line, but the string form still
 * needs to lose them for anything downstream (baseURL joining, a relative
 * `Location` rebuild) that works on the string.
 */
export function extractUrlCredentials(
  url: string,
): { username: string; password: string; url: string } | undefined {
  if (!url.includes('@')) return undefined;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return undefined;
  }
  if (!parsed.username && !parsed.password) return undefined;
  const username = decodeURIComponentSafe(parsed.username);
  const password = decodeURIComponentSafe(parsed.password);
  parsed.username = '';
  parsed.password = '';
  return { username, password, url: parsed.toString() };
}

/**
 * axios' default query value encoder.
 */
function encodeParam(value: string): string {
  return encodeURIComponent(value)
    .replace(/%3A/gi, ':')
    .replace(/%24/g, '$')
    .replace(/%2C/gi, ',')
    .replace(/%20/g, '+');
}

function isPlainObject(value: unknown): value is Record<string, any> {
  if (value === null || typeof value !== 'object') return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function isVisitable(value: unknown): boolean {
  return isPlainObject(value) || Array.isArray(value);
}

function convertParamValue(value: any): string {
  if (value === null) return '';
  if (value instanceof Date) return value.toISOString();
  return String(value);
}

/**
 * Flattens params the same way axios' `toFormData` visitor does for the
 * default `paramsSerializer` (`indexes: false` => `a[]=1&a[]=2`,
 * nested objects => `a[b]=1`).
 */
function flattenParams(
  params: Record<string, any>,
  options: { indexes?: boolean | null; dots?: boolean },
): Array<[string, string]> {
  const pairs: Array<[string, string]> = [];
  const indexes = options.indexes === undefined ? false : options.indexes;
  const dots = !!options.dots;

  const removeBrackets = (key: string) =>
    key.endsWith('[]') ? key.slice(0, -2) : key;

  const renderKey = (
    path: Array<string | number> | undefined,
    key: string | number,
  ) => {
    if (!path) return String(key);
    return path
      .concat(key)
      .map((token, i) => {
        const t = removeBrackets(String(token));
        return !dots && i ? `[${t}]` : t;
      })
      .join(dots ? '.' : '');
  };

  const visit = (
    value: any,
    key: string | number,
    path?: Array<string | number>,
  ): boolean => {
    if (value && !path && typeof value === 'object') {
      if (typeof key === 'string' && key.endsWith('{}')) {
        pairs.push([key, JSON.stringify(value)]);
        return false;
      }
      const isFlatArray = Array.isArray(value) && !value.some(isVisitable);
      if (
        isFlatArray ||
        (typeof key === 'string' && key.endsWith('[]') && Array.isArray(value))
      ) {
        const base = removeBrackets(String(key));
        value.forEach((el: any, index: number) => {
          if (el === undefined || el === null) return;
          const name =
            indexes === true
              ? renderKey([base], index)
              : indexes === null
                ? base
                : `${base}[]`;
          pairs.push([name, convertParamValue(el)]);
        });
        return false;
      }
    }
    if (isVisitable(value)) return true;
    pairs.push([renderKey(path, key), convertParamValue(value)]);
    return false;
  };

  const build = (value: any, path?: Array<string | number>) => {
    const entries: Array<[string | number, any]> = Array.isArray(value)
      ? value.map((v, i) => [i, v])
      : Object.keys(value).map(k => [k, value[k]]);
    for (const [rawKey, el] of entries) {
      if (el === undefined || el === null) continue;
      const key = typeof rawKey === 'string' ? rawKey.trim() : rawKey;
      if (visit(el, key, path)) {
        build(el, path ? path.concat(key) : [key]);
      }
    }
  };

  build(params);
  return pairs;
}

// ---------------------------------------------------------------------------
// `formSerializer` (plan.md phase 2 "Progress callbacks ... formSerializer"):
// a fuller, axios-compatible traversal engine (custom `visitor`, `dots`,
// `metaTokens`, `indexes`, `maxDepth`, circular-reference/depth checks),
// ported from axios' own `lib/helpers/toFormData.js`. Only reached when a
// caller actually configures `formSerializer` - `postForm`/a plain
// multipart/urlencoded body with no `formSerializer` keeps using the simpler
// `flattenParams` above unchanged (see `toGlobalFormData`/
// `serializeRequestData`), so the common case pays nothing extra.
// ---------------------------------------------------------------------------

const DEFAULT_FORM_DATA_MAX_DEPTH = 100;

function stripArrayBracketSuffix(key: string): string {
  return key.endsWith('[]') ? key.slice(0, -2) : key;
}

function renderFormKey(
  path: Array<string | number> | null | undefined,
  key: string | number,
  dots: boolean,
): string {
  if (!path) return String(key);
  return path
    .concat(key)
    .map((token, i) => {
      const t = stripArrayBracketSuffix(String(token));
      return !dots && i ? `[${t}]` : t;
    })
    .join(dots ? '.' : '');
}

/** axios' own `convertValue`: `Date`/`boolean`/`null` get special-cased; a Buffer/typed array becomes a `Blob` when the target supports one (a real, spec-compliant `FormData`). */
function convertFormValue(value: any, useBlob: boolean): any {
  if (value === null) return '';
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'boolean') return String(value);
  if (
    useBlob &&
    typeof Blob !== 'undefined' &&
    (Buffer.isBuffer(value) ||
      value instanceof ArrayBuffer ||
      ArrayBuffer.isView(value))
  ) {
    return new Blob([value as any]);
  }
  return value;
}

/**
 * Walks `data`'s own keys (matching axios' `toFormData`'s `build()`),
 * appending each resolved leaf to `target` via `visitor` (the caller's own
 * `formSerializer.visitor`, or `defaultVisitor` below). `target` is anything
 * with an `.append(name, value)` - a real `FormData` (multipart, `useBlob:
 * true`) or an internal pairs collector (url-encoded, `useBlob: false`, since
 * `URLSearchParams` needs strings, not Blobs).
 */
export function buildFormData(
  data: Record<string, any>,
  target: { append(name: string, value: any): void },
  options: FormSerializerOptions = {},
  useBlob = false,
): void {
  const metaTokens =
    options.metaTokens === undefined ? true : options.metaTokens;
  const dots = !!options.dots;
  const indexes = options.indexes === undefined ? false : options.indexes;
  const maxDepth =
    options.maxDepth === undefined
      ? DEFAULT_FORM_DATA_MAX_DEPTH
      : options.maxDepth;
  const stack: any[] = [];

  const convertValue = (value: any) => convertFormValue(value, useBlob);

  const defaultVisitor: SerializerVisitor = function (value, key, path) {
    if (value !== null && !path && typeof value === 'object') {
      if (typeof key === 'string' && key.endsWith('{}')) {
        const renderedKey = metaTokens ? key : key.slice(0, -2);
        target.append(
          renderFormKey(path, renderedKey, dots),
          convertValue(JSON.stringify(value)),
        );
        return false;
      }
      const isFlatArr = Array.isArray(value) && !value.some(isVisitable);
      if (
        isFlatArr ||
        (typeof key === 'string' && key.endsWith('[]') && Array.isArray(value))
      ) {
        const base = stripArrayBracketSuffix(String(key));
        (value as any[]).forEach((el, index) => {
          if (el === undefined || el === null) return;
          const name =
            indexes === true
              ? renderFormKey([base], index, dots)
              : indexes === null
                ? base
                : `${base}[]`;
          target.append(name, convertValue(el));
        });
        return false;
      }
    }
    if (isVisitable(value)) return true;
    target.append(renderFormKey(path, key, dots), convertValue(value));
    return false;
  };

  const visitor = options.visitor || defaultVisitor;
  const helpers: FormDataVisitorHelpers = {
    defaultVisitor,
    isVisitable,
    convertValue,
  };

  function build(
    value: any,
    path: Array<string | number> | null = null,
    depth = 0,
  ): void {
    if (value === undefined) return;
    if (depth > maxDepth) {
      throw new Error(
        `Object is too deeply nested (${depth} levels). Max depth: ${maxDepth}`,
      );
    }
    if (stack.indexOf(value) !== -1) {
      throw new Error(
        `Circular reference detected in ${(path || []).join('.')}`,
      );
    }
    stack.push(value);
    const entries: Array<[string | number, any]> = Array.isArray(value)
      ? value.map((v, i): [number, any] => [i, v])
      : Object.keys(value).map((k): [string, any] => [k, value[k]]);
    for (const [rawKey, el] of entries) {
      if (el === undefined || el === null) continue;
      const key = typeof rawKey === 'string' ? rawKey.trim() : rawKey;
      const result = visitor.call(target as any, el, key, path, helpers);
      if (result === true) {
        build(el, path ? path.concat(key) : [key], depth + 1);
      }
    }
    stack.pop();
  }

  build(data);
}

/** Collects `[key, value]` pairs (values stringified on append) - the `formSerializer` url-encoded-body target, joined with `URLSearchParams` afterwards so the actual percent-encoding matches the no-`formSerializer` default path exactly. */
class FormPairsTarget {
  readonly pairs: Array<[string, string]> = [];
  append(name: string, value: any): void {
    this.pairs.push([name, value == null ? '' : String(value)]);
  }
}

/** `data` (a plain object/array) turned into `[key, value]` pairs per `formSerializer`, for a url-encoded body. */
export function buildFormSerializedPairs(
  data: Record<string, any>,
  formSerializer: FormSerializerOptions,
): Array<[string, string]> {
  const target = new FormPairsTarget();
  buildFormData(data, target, formSerializer, false);
  return target.pairs;
}

const MAX_FORM_DATA_JSON_DEPTH = DEFAULT_FORM_DATA_MAX_DEPTH;

function parseFormDataPropPath(name: string): Array<string> {
  // foo[x][y][z] -> ['foo', 'x', 'y', 'z']; foo.x.y.z -> same.
  const path: string[] = [];
  const pattern = /[^.[\]]+|\[([^.[\]]*)]/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(name)) !== null) {
    if (path.length > MAX_FORM_DATA_JSON_DEPTH) {
      throw new Error(
        `FormData field is too deeply nested (${path.length} levels). Max depth: ${MAX_FORM_DATA_JSON_DEPTH}`,
      );
    }
    path.push(match[0] === '[]' ? '' : (match[1] ?? match[0]));
  }
  return path;
}

/**
 * axios' `formDataToJSON`: the reverse of `buildFormData`/`toFormData` - a
 * `foo[x][y]`-style flat field-name convention decoded back into a nested
 * object. Used when a real `FormData` is sent as `data` but `Content-Type` is
 * explicitly `application/json` (axios' default `transformRequest`
 * special-cases exactly this - see `serializeRequestData`).
 */
export function formDataToJSON(formData: {
  entries?: () => IterableIterator<[string, any]>;
}): Record<string, any> | null {
  if (typeof formData?.entries !== 'function') return null;

  function buildPath(
    path: string[],
    value: any,
    target: Record<string, any>,
    index: number,
  ): boolean {
    if (index > MAX_FORM_DATA_JSON_DEPTH) {
      throw new Error(
        `FormData field is too deeply nested (${index} levels). Max depth: ${MAX_FORM_DATA_JSON_DEPTH}`,
      );
    }
    let name: string | number = path[index++];
    if (name === '__proto__') return true;
    const isNumericKey = Number.isFinite(+name);
    const isLast = index >= path.length;
    name = !name && Array.isArray(target) ? target.length : name;

    if (isLast) {
      if (Object.prototype.hasOwnProperty.call(target, name)) {
        target[name] = Array.isArray(target[name])
          ? target[name].concat(value)
          : [target[name], value];
      } else {
        target[name] = value;
      }
      return !isNumericKey;
    }

    if (
      !Object.prototype.hasOwnProperty.call(target, name) ||
      typeof target[name] !== 'object' ||
      target[name] === null
    ) {
      target[name] = [];
    }

    const result = buildPath(path, value, target[name], index);
    if (result && Array.isArray(target[name])) {
      target[name] = { ...target[name] };
    }
    return !isNumericKey;
  }

  const obj: Record<string, any> = {};
  for (const [name, value] of formData.entries()) {
    buildPath(parseFormDataPropPath(name), value, obj, 0);
  }
  return obj;
}

/**
 * Appends `params` to `url` exactly like axios' `buildURL`.
 */
export function buildURL(
  url: string,
  params: any,
  paramsSerializer?: AxiosParamsSerializer,
): string {
  if (!params) return url;

  const options =
    typeof paramsSerializer === 'function'
      ? { serialize: paramsSerializer }
      : paramsSerializer || {};
  const encode = options.encode || encodeParam;

  let serialized: string;
  if (options.serialize) {
    serialized = options.serialize(params, options);
  } else if (params instanceof URLSearchParams) {
    serialized = params.toString();
  } else if (typeof params === 'object') {
    serialized = flattenParams(params, options)
      .map(([key, value]) => `${encode(key)}=${encode(value)}`)
      .join('&');
  } else {
    serialized = '';
  }

  if (!serialized) return url;

  const hashIndex = url.indexOf('#');
  const base = hashIndex === -1 ? url : url.slice(0, hashIndex);
  return base + (base.indexOf('?') === -1 ? '?' : '&') + serialized;
}

/**
 * Url-encodes form data for postForm/putForm/patchForm. Nested objects and
 * arrays use the same bracket notation as params (`a[b]=1`, `list[]=1`).
 */
export function toUrlEncodedForm(data: any): string {
  if (!data) return '';
  if (typeof data === 'string') return data;
  if (data instanceof URLSearchParams) return data.toString();
  return flattenParams(data, {})
    .map(
      ([key, value]) =>
        `${encodeURIComponent(key)}=${encodeURIComponent(value)}`,
    )
    .join('&');
}

/**
 * A plain object/array turned into a global `FormData`, one `append()` per
 * flattened `[key, value]` pair (same flattening `params`/url-encoded
 * bodies use - nested objects/arrays as `a[b]=1`/`a[]=1`). Lets
 * `buildFormRequestConfig` hand the *existing* global-`FormData` body path
 * (`serializeRequestData`'s `isGlobalFormData` branch, `globalFormDataToStream`)
 * do the actual multipart encoding (boundary, `Content-Type`) - exactly as
 * it already does for a `FormData` instance a caller builds by hand.
 */
function toGlobalFormData(
  data: any,
  formSerializer?: FormSerializerOptions,
): FormData {
  const form = new FormData();
  if (data != null) {
    if (formSerializer) {
      buildFormData(data, form as any, formSerializer, true);
    } else {
      for (const [key, value] of flattenParams(data, {})) {
        form.append(key, value);
      }
    }
  }
  return form;
}

/**
 * Shared `postForm`/`putForm`/`patchForm` config-building, matching axios'
 * own `generateHTTPMethod(isForm=true)`: a `FormData`-like body (the global
 * `FormData`, or the `form-data` package) is sent as multipart as-is.
 * Anything else (a plain object/array) is *also* sent as multipart, like
 * axios (`Content-Type: multipart/form-data`, the object converted with
 * `toGlobalFormData` above) - even when the caller's own `config.headers`
 * names a different `Content-Type` (confirmed against real axios: an
 * explicit `Content-Type: application/x-www-form-urlencoded` passed to
 * `postForm` is still sent as multipart - the method's own default headers
 * win). A caller who actually wants url-encoded form data uses `post()`
 * with `data: new URLSearchParams(...)` instead, not `postForm()`. Used by
 * both `HttpService.postForm`/`putForm`/`patchForm` and
 * `axiosRef.postForm`/`putForm`/`patchForm` (`axios-ref.factory.ts`), so
 * both build the exact same request.
 */
export function buildFormRequestConfig<D = any>(
  method: 'POST' | 'PUT' | 'PATCH',
  url: Url,
  data: D | undefined,
  config: AxiosLikeRequestConfig<D> | undefined,
  // `axiosRef.defaults.formSerializer` (seeded from module options at setup -
  // see `createAxiosRefDefaults`'s `DEFAULTS_PASSTHROUGH_KEYS`), read by
  // `HttpService.formRequest`/`axiosRef.postForm` et al. before this runs, so
  // the same "request > defaults" precedence every other option here has
  // applies to `formSerializer` too. A request-level `config.formSerializer`
  // always wins.
  defaultFormSerializer?: FormSerializerOptions,
): AxiosLikeRequestConfig<D> {
  // A URLSearchParams body is already form-encoded: send it as is (its
  // `a=1&b=2` body and urlencoded Content-Type) rather than flattening it
  // into an empty FormData - it has no enumerable own keys.
  const isFormDataLike =
    (data as any)?.[Symbol.toStringTag] === 'FormData' ||
    typeof (data as any)?.getHeaders === 'function' ||
    isGlobalFormData(data) ||
    data instanceof URLSearchParams;
  if (isFormDataLike) {
    return { ...config, url: url as any, method, data };
  }

  const formSerializer = config?.formSerializer ?? defaultFormSerializer;

  // Multipart by default, like axios' postForm - `data` becomes a real
  // FormData, and the existing global-FormData body path sets the
  // `Content-Type`/boundary itself (no header set here).
  return {
    ...config,
    url: url as any,
    method,
    data: toGlobalFormData(data, formSerializer) as any,
  };
}

// ---------------------------------------------------------------------------
// Headers
// ---------------------------------------------------------------------------

function forEachHeader(
  headers: any,
  fn: (key: string, value: any) => void,
): void {
  if (!headers) return;
  if (Array.isArray(headers)) {
    // undici raw headers: [k1, v1, k2, v2, ...] or [[k, v], ...]
    if (headers.length && Array.isArray(headers[0])) {
      headers.forEach(([key, value]: [string, any]) => fn(key, value));
    } else {
      for (let i = 0; i + 1 < headers.length; i += 2)
        fn(headers[i], headers[i + 1]);
    }
    return;
  }
  if (!isPlainObject(headers) && typeof headers.toJSON === 'function') {
    // AxiosHeaders (ours or the axios package's)
    const json = headers.toJSON();
    Object.keys(json).forEach(key => fn(key, json[key]));
    return;
  }
  if (!isPlainObject(headers) && typeof headers.forEach === 'function') {
    // WHATWG Headers / Map
    headers.forEach((value: any, key: string) => fn(key, value));
    return;
  }
  Object.keys(headers).forEach(key => fn(key, headers[key]));
}

/**
 * Case-insensitively merges header sources (later sources win). A header
 * explicitly set to `undefined`, `null` or `false` removes any value a
 * lower-priority source set for it, as in axios (`AxiosHeaders#toJSON`
 * drops all three); a source that is itself `undefined`/`null` (no headers
 * given at all) is simply skipped.
 */
export function mergeHeaders(...sources: any[]): HeaderRecord {
  const merged = new Map<string, [string, any]>();
  for (const source of sources) {
    forEachHeader(source, (key, value) => {
      const lower = key.toLowerCase();
      if (value === undefined || value === null || value === false) {
        merged.delete(lower);
      } else {
        merged.set(lower, [
          key,
          Array.isArray(value)
            ? value.map(v => sanitizeHeaderValue(String(v)))
            : sanitizeHeaderValue(String(value)),
        ]);
      }
    });
  }
  const result: HeaderRecord = {};
  merged.forEach(([key, value]) => {
    result[key] = value;
  });
  return result;
}

// `AxiosHeaders` is a Proxy whose key enumeration goes through its
// `ownKeys`/`getOwnPropertyDescriptor` traps, so scanning it with
// `Object.keys` is slow on the interceptor path; its own case-insensitive
// `get`/`has`/`set` give the same answers directly.
function findHeader(headers: HeaderRecord, name: string): string | undefined {
  if (headers instanceof AxiosHeaders) return headers.get(name) as any;
  const lower = name.toLowerCase();
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() === lower) return headers[key];
  }
  return undefined;
}

function setHeaderIfMissing(
  headers: HeaderRecord,
  name: string,
  value: string,
): void {
  if (headers instanceof AxiosHeaders) {
    if (!headers.has(name)) headers.set(name, value);
    return;
  }
  if (findHeader(headers, name) === undefined) headers[name] = value;
}

/** Sets a header, replacing any existing case-insensitive match (and its casing). */
function setHeader(headers: HeaderRecord, name: string, value: string): void {
  if (headers instanceof AxiosHeaders) {
    headers.set(name, value);
    return;
  }
  const existing = Object.keys(headers).find(
    key => key.toLowerCase() === name.toLowerCase(),
  );
  if (existing) delete headers[existing];
  headers[name] = value;
}

// ---------------------------------------------------------------------------
// Body
// ---------------------------------------------------------------------------

function isStreamLike(value: any): boolean {
  return (
    !!value && typeof value === 'object' && typeof value.pipe === 'function'
  );
}

function isGlobalFormData(value: unknown): value is FormData {
  return typeof FormData !== 'undefined' && value instanceof FormData;
}

/**
 * Encodes a WHATWG FormData (the Node.js global) as a multipart stream.
 *
 * The global FormData belongs to the undici copy bundled with Node.js, which
 * the `undici` package's `request()` cannot always encode (the request hangs),
 * so it is encoded with the global `Response` instead.
 */
function globalFormDataToStream(
  form: FormData,
  headers: HeaderRecord,
): Readable {
  const encoded = new Response(form);
  const contentType = encoded.headers.get('content-type');
  const current = findHeader(headers, 'content-type');
  if (contentType && (!current || !String(current).includes('boundary='))) {
    Object.keys(headers).forEach(key => {
      if (key.toLowerCase() === 'content-type') delete headers[key];
    });
    headers['Content-Type'] = contentType;
  }
  return Readable.fromWeb(encoded.body as any);
}

/**
 * Serialises `data` like axios' default `transformRequest` and returns the
 * undici body. May add a Content-Type header to `headers`.
 */
export function serializeRequestData(
  data: any,
  headers: HeaderRecord,
  method: string,
  formSerializer?: FormSerializerOptions,
): any {
  const contentType = String(findHeader(headers, 'content-type') || '');
  let body: any;

  // A plain object/array with an explicit multipart Content-Type is sent as
  // multipart, like axios' default `transformRequest` (`toFormData`) - not
  // just through `postForm`/`putForm`/`patchForm`. Converted to a real
  // `FormData` up front so the `isGlobalFormData` branch just below does the
  // actual multipart encoding either way.
  if (isPlainObject(data) && contentType.includes('multipart/form-data')) {
    data = toGlobalFormData(data, formSerializer);
  }

  if (
    data === undefined ||
    data === null ||
    (!data && typeof data !== 'object')
  ) {
    // axios sends no body for null/undefined and falsy primitives (0, false, '')
    body = undefined;
  } else if (isGlobalFormData(data)) {
    // axios' default `transformRequest`: a real `FormData` sent with an
    // explicit `Content-Type: application/json` is converted to JSON first
    // (`formDataToJSON`) instead of being encoded as multipart.
    if (contentType.includes('application/json')) {
      body = JSON.stringify(formDataToJSON(data as any));
    } else {
      body = globalFormDataToStream(data, headers);
    }
  } else if (isStreamLike(data) && typeof data.getHeaders === 'function') {
    // `form-data` package: copy its multipart headers and stream it
    Object.entries(data.getHeaders() as Record<string, string>).forEach(
      ([key, value]) => setHeaderIfMissing(headers, key, value),
    );
    body = data.pipe(new PassThrough());
  } else if (
    typeof data === 'object' &&
    (data as any)[Symbol.toStringTag] === 'FormData'
  ) {
    // e.g. `FormData` from the `undici` package: undici encodes it natively
    // and sets multipart/form-data with the boundary itself
    body = data;
  } else if (typeof Blob !== 'undefined' && data instanceof Blob) {
    body = data;
    // axios' Node adapter sets Content-Type from the Blob's own `type`
    // whenever it has content - overriding even a header the caller set
    // explicitly. An empty Blob is left alone (falls through to the
    // POST/PUT/PATCH default below, like axios).
    if (data.size) {
      setHeader(
        headers,
        'Content-Type',
        data.type || 'application/octet-stream',
      );
    }
  } else if (Buffer.isBuffer(data) || isStreamLike(data)) {
    body = data;
  } else if (data instanceof ArrayBuffer) {
    body = Buffer.from(data);
  } else if (ArrayBuffer.isView(data)) {
    body = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  } else if (data instanceof URLSearchParams) {
    setHeaderIfMissing(
      headers,
      'Content-Type',
      `${FORM_URLENCODED};charset=utf-8`,
    );
    body = data.toString();
  } else if (
    typeof data === 'object' &&
    contentType.includes(FORM_URLENCODED)
  ) {
    body = formSerializer
      ? new URLSearchParams(
          buildFormSerializedPairs(data, formSerializer),
        ).toString()
      : new URLSearchParams(flattenParams(data, {})).toString();
  } else if (
    typeof data === 'object' ||
    contentType.includes('application/json')
  ) {
    setHeaderIfMissing(headers, 'Content-Type', 'application/json');
    body = typeof data === 'string' ? data : JSON.stringify(data);
  } else {
    body = typeof data === 'string' ? data : String(data);
  }

  // axios' dispatchRequest default for methods with a body (undici sets the
  // multipart Content-Type of its own FormData itself)
  const isFormData = !!body && (body as any)[Symbol.toStringTag] === 'FormData';
  if (
    !isFormData &&
    (method === 'POST' || method === 'PUT' || method === 'PATCH')
  ) {
    setHeaderIfMissing(headers, 'Content-Type', FORM_URLENCODED);
  }

  return body;
}

// ---------------------------------------------------------------------------
// Cancellation
// ---------------------------------------------------------------------------

/**
 * Combines an AbortSignal and an axios CancelToken into a single signal.
 */
/**
 * Set (non-enumerably) on the `AbortSignal` `resolveSignal` returns, when it
 * had to add a listener on the caller's own `signal` to combine it with a
 * `cancelToken`. Calling it removes that listener. Review follow-up (PR #15):
 * without this, the listener (`{ once: true }`, so it only ever
 * self-removes *if the signal fires*) stayed on a request that never
 * aborted for as long as the caller's `signal` object lived - a real leak
 * for a long-lived signal reused across many requests. `executeRequest`
 * (`http.service.ts`) calls this from its teardown, which - unlike the
 * listener's own `once: true` - runs on every request, aborted or not.
 */
export const SIGNAL_CLEANUP = Symbol('signalCleanup');

function resolveSignal(
  signal: AbortSignal | undefined,
  cancelToken: AxiosCancelTokenLike | undefined,
): AbortSignal | undefined {
  if (!cancelToken) return signal;

  const controller = new AbortController();
  const abort = (reason: any) => {
    if (!controller.signal.aborted) controller.abort(reason);
  };

  if (cancelToken.reason) {
    abort(cancelToken.reason);
  } else if (typeof cancelToken.subscribe === 'function') {
    cancelToken.subscribe(abort);
  } else if (cancelToken.promise) {
    cancelToken.promise.then(abort, () => undefined);
  }

  if (signal) {
    if (signal.aborted) {
      abort(signal.reason);
    } else {
      const onAbort = () => abort(signal.reason);
      signal.addEventListener('abort', onAbort, { once: true });
      Object.defineProperty(controller.signal, SIGNAL_CLEANUP, {
        value: () => signal.removeEventListener('abort', onAbort),
        configurable: true,
      });
    }
  }
  return controller.signal;
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/**
 * The axios-style header buckets (`common`, and one per HTTP method).
 * Exported for `axios-ref.factory.ts`'s `createAxiosRefDefaults`, which
 * seeds `axiosRef.defaults.headers` from module options the same way this
 * file flattens them per request.
 */
export const METHOD_HEADER_KEYS = new Set([
  'common',
  'get',
  'delete',
  'head',
  'options',
  'post',
  'put',
  'patch',
]);

function hasOwnKeys(value: any): boolean {
  if (!value || typeof value !== 'object') return false;
  for (const key in value) {
    if (Object.prototype.hasOwnProperty.call(value, key)) return true;
  }
  return false;
}

function flatDefaultHeaders(
  headers: Record<string, any> | undefined,
): HeaderRecord | undefined {
  if (!headers) return undefined;
  let flat: HeaderRecord | undefined;
  for (const key of Object.keys(headers)) {
    if (!METHOD_HEADER_KEYS.has(key) && headers[key] !== undefined) {
      (flat ??= {})[key] = headers[key];
    }
  }
  return flat;
}

// ---------------------------------------------------------------------------
// Per-method default/module header cache
//
// The default + module headers for a method (`defaults.headers` common /
// method / flat, then module `headers` common / method / flat) rarely change,
// so their 6-source merge is cached per `defaults` object and method. Rather
// than tracking writes (which can't see every mutation path), each request
// re-checks the sources: the same objects, holding the same keys in the same
// order with identical primitive values, merge to the same result. Anything
// else, including a source that isn't a plain object or a header value that
// isn't a primitive, skips the cache and merges as before.
// ---------------------------------------------------------------------------

interface HeaderSourceSnapshot {
  source: unknown;
  keys: string[];
  values: unknown[];
}

interface HeaderBaseCache {
  sources: HeaderSourceSnapshot[];
  /** Merged default + module headers for this method, excluding per-request headers. */
  base: HeaderRecord;
  hasWork: boolean;
}

const headerBaseCaches = new WeakMap<object, Map<string, HeaderBaseCache>>();

function headerSources(
  defaultHeaders: Record<string, any> | undefined,
  instanceHeaders: Record<string, any> | undefined,
  lowerMethod: string,
): unknown[] {
  return [
    defaultHeaders,
    defaultHeaders?.common,
    defaultHeaders?.[lowerMethod],
    instanceHeaders,
    instanceHeaders?.common,
    instanceHeaders?.[lowerMethod],
  ];
}

/** `container` sources (`headers` itself) may hold method buckets by reference. */
function snapshotHeaderSource(
  source: unknown,
  container: boolean,
): HeaderSourceSnapshot | undefined {
  if (source === undefined || source === null) {
    return { source, keys: [], values: [] };
  }
  if (!isPlainObject(source)) return undefined;
  const keys: string[] = [];
  const values: unknown[] = [];
  for (const key in source) {
    const value = source[key];
    if (
      value !== null &&
      (typeof value === 'object' || typeof value === 'function') &&
      !(container && METHOD_HEADER_KEYS.has(key))
    ) {
      return undefined;
    }
    keys.push(key);
    values.push(value);
  }
  return { source, keys, values };
}

function matchesHeaderSnapshot(
  source: any,
  snapshot: HeaderSourceSnapshot,
): boolean {
  if (source !== snapshot.source) return false;
  if (source === undefined || source === null) return true;
  const { keys, values } = snapshot;
  let i = 0;
  for (const key in source) {
    if (i >= keys.length || keys[i] !== key || source[key] !== values[i]) {
      return false;
    }
    i++;
  }
  return i === keys.length;
}

function getHeaderBase(
  owner: object,
  defaultHeaders: Record<string, any> | undefined,
  instanceHeaders: Record<string, any> | undefined,
  lowerMethod: string,
): HeaderBaseCache | undefined {
  const sources = headerSources(defaultHeaders, instanceHeaders, lowerMethod);

  let byMethod = headerBaseCaches.get(owner);
  const cached = byMethod?.get(lowerMethod);
  if (cached) {
    let valid = true;
    for (let i = 0; i < sources.length && valid; i++) {
      valid = matchesHeaderSnapshot(sources[i], cached.sources[i]);
    }
    if (valid) return cached;
  }

  const snapshots: HeaderSourceSnapshot[] = [];
  for (let i = 0; i < sources.length; i++) {
    const snapshot = snapshotHeaderSource(sources[i], i === 0 || i === 3);
    if (!snapshot) {
      byMethod?.delete(lowerMethod);
      return undefined;
    }
    snapshots.push(snapshot);
  }

  const entry: HeaderBaseCache = {
    sources: snapshots,
    // Precedence: request > axiosRef.defaults > module (raw `instanceHeaders`).
    // `defaultHeaders` is merged *after* `instanceHeaders` here so a runtime
    // mutation of `axiosRef.defaults.headers` always wins over the original
    // module-level value it was seeded from at setup (`createAxiosRefDefaults`)
    // - one coherent "request > defaults" rule, matching axios'
    // `mergeConfig(this.defaults, config)` and this library's existing
    // `timeout`/`maxRedirects` precedence (see docs/axios-supported-options.md
    // "Precedence"). This is a breaking change from the PR #16 rule ("module
    // headers always win over axiosRef.defaults").
    base: mergeHeaders(
      instanceHeaders?.common,
      instanceHeaders?.[lowerMethod],
      flatDefaultHeaders(instanceHeaders),
      defaultHeaders?.common,
      defaultHeaders?.[lowerMethod],
      flatDefaultHeaders(defaultHeaders),
    ),
    hasWork: headersHaveWork(defaultHeaders, instanceHeaders, lowerMethod),
  };
  if (!byMethod) {
    byMethod = new Map();
    headerBaseCaches.set(owner, byMethod);
  }
  byMethod.set(lowerMethod, entry);
  return entry;
}

function headersHaveWork(
  defaultHeaders: Record<string, any> | undefined,
  instanceHeaders: Record<string, any> | undefined,
  lowerMethod: string,
): boolean {
  return (
    hasOwnKeys(defaultHeaders?.common) ||
    hasOwnKeys(defaultHeaders?.[lowerMethod]) ||
    flatDefaultHeaders(defaultHeaders) !== undefined ||
    hasOwnKeys(instanceHeaders)
  );
}

/**
 * `node:url`'s `UrlObject` shape (`url.format()`'s input): fields that only
 * a URL-ish plain object would ever carry - none of them overlap with
 * `AxiosLikeRequestConfig`'s own keys (checked against
 * `axios-compatible.interface.ts`; `auth` is the one nominal overlap - a
 * legacy `UrlObject.auth` string vs. `config.auth`'s `{ username, password }`
 * object - vanishingly rare either way, so it's left off this list rather
 * than risk misclassifying a real `config.auth`).
 */
const URL_OBJECT_MARKER_KEYS = [
  'protocol',
  'hostname',
  'host',
  'pathname',
  'path',
  'href',
  'query',
  'search',
  'hash',
  'slashes',
  'port',
] as const;

/**
 * Detects the `request(config)` call form (`{ url, method, ... }`), as
 * opposed to `request(url, options)` where `url` may also be a `URL` or a
 * `UrlObject`.
 *
 * Review fix (CodeRabbit): this used to require a `url` key to say "this is
 * a config" - so `axiosRef({ baseURL: '...', method: 'get' })` (a perfectly
 * valid axios config with no `url` set - matching axios exactly, see
 * `AxiosLikeRequestConfig.url`'s own doc comment) fell through the `else`
 * branch and got treated as a raw URL value, stringified to
 * `"[object Object]"`. A config's `url` is commonly left unset (resolved
 * later via `baseURL` or an interceptor), so a *missing* `url` key alone
 * can't mean "this is a URL, not a config" - matches axios' own
 * `Axios.prototype.request`, which only ever branches on
 * `typeof configOrUrl === 'string'` (a bare URL value here is never a
 * config). The one extra case this library's own `request(url, options)`/
 * `get(url, config)` etc. add on top of axios (a raw `UrlObject` as the
 * first, positional argument - see that interface's doc comment) is still
 * recognised structurally: an object with no `url` key is a `UrlObject`
 * only if it actually carries one of that shape's own fields
 * (`URL_OBJECT_MARKER_KEYS`), never merely by the absence of `url`.
 */
export function isAxiosRequestConfig(
  value: unknown,
): value is { url?: Url } & Record<string, any> {
  if (!value || typeof value !== 'object' || value instanceof URL) {
    return false;
  }
  const obj = value as Record<string, unknown>;
  if ('url' in obj) return true;
  return !URL_OBJECT_MARKER_KEYS.some(key => key in obj);
}

/**
 * Normalises both `request(url, options)` and `request(config)` call forms
 * into the undici-level `(url, options)` pair used by HttpService, applying
 * axios semantics for `baseURL`, `params`/`paramsSerializer`, `data`,
 * `headers` (merged with module and `axiosRef.defaults` headers), `auth`,
 * `timeout`, `maxRedirects` and `cancelToken`.
 *
 * Module-level values are read from the raw module options, so they apply to
 * both `register()` and `registerAsync()`.
 */
/**
 * Cheap, mostly-by-reference fields captured while normalising a request,
 * enough to lazily build a correctly-shaped `response.config` / `error.config`
 * (see `buildLazyAxiosConfig`) without paying for it on every request.
 */
export interface NormalizedRequestSeed {
  url: Url;
  baseURL?: string;
  params?: any;
  method: string;
}

export function normalizeAxiosRequest(
  urlOrConfig: Url | ({ url?: Url } & Record<string, any>),
  requestOptions: Record<string, any> | undefined,
  context: AxiosRequestContext = {},
): { url: Url; options: Record<string, any>; raw: NormalizedRequestSeed } {
  let url: Url;
  let input: Record<string, any>;
  if (isAxiosRequestConfig(urlOrConfig)) {
    input = { ...urlOrConfig, ...requestOptions };
    url = urlOrConfig.url ?? '';
  } else {
    input = requestOptions || {};
    url = urlOrConfig as Url;
  }

  const defaults = context.defaults;
  const instance = context.instanceOptions || {};
  const method = String(input.method || 'GET').toUpperCase();
  const lowerMethod = method.toLowerCase() as 'get';

  const defaultHeaders = defaults?.headers as Record<string, any> | undefined;
  const instanceHeaders = instance.headers as Record<string, any> | undefined;
  // See "Per-method default/module header cache" above.
  const headerBase = getHeaderBase(
    defaults ?? instance,
    defaultHeaders,
    instanceHeaders,
    lowerMethod,
  );

  const baseURL = input.baseURL ?? defaults?.baseURL ?? instance.baseURL;
  let auth = input.auth ?? defaults?.auth ?? instance.auth;
  const defaultTimeout =
    defaults?.timeout ??
    (instance.headersTimeout === undefined ? instance.timeout : undefined);
  const maxRedirects =
    input.maxRedirects ?? defaults?.maxRedirects ?? instance.maxRedirects;
  const allowAbsoluteUrls =
    input.allowAbsoluteUrls ??
    defaults?.allowAbsoluteUrls ??
    instance.allowAbsoluteUrls;
  // Precedence: request > axiosRef.defaults > module - see the header
  // comment below.
  const baseParams = defaults?.params ?? instance.params;
  // CodeRabbit review finding: `axiosRef.create({ maxContentLength, ... })`
  // (and a runtime `axiosRef.defaults.X = ...` assignment) used to have no
  // effect on these 5 - only ever read off module (`instance`) options here,
  // never off `defaults` - same precedence (request > axiosRef.defaults >
  // module) as `baseURL`/`timeout`/`maxRedirects` above.
  const defaultMaxContentLength =
    defaults?.maxContentLength ?? instance.maxContentLength;
  const defaultMaxBodyLength =
    defaults?.maxBodyLength ?? instance.maxBodyLength;
  const defaultTimeoutErrorMessage =
    defaults?.timeoutErrorMessage ?? instance.timeoutErrorMessage;
  const defaultDecompress = defaults?.decompress ?? instance.decompress;
  const defaultSocketPath = defaults?.socketPath ?? instance.socketPath;
  const defaultBeforeRedirect =
    defaults?.beforeRedirect ?? instance.beforeRedirect;

  // Fast path: nothing axios-specific to do for this request. In practice
  // this only triggers for calls that bypass HttpService's axiosRef defaults
  // entirely (defaultHeaders?.common always carries the default Accept /
  // User-Agent / Accept-Encoding headers once a service is set up).
  const needsWork =
    AXIOS_ONLY_KEYS.some(key => input[key] !== undefined) ||
    (input.method !== undefined && input.method !== method) ||
    input.headers !== undefined ||
    (typeof url === 'string' && (!!baseURL || url.includes('@'))) ||
    baseParams !== undefined ||
    auth !== undefined ||
    (defaultTimeout !== undefined && input.timeout === undefined) ||
    (maxRedirects !== undefined && input.maxRedirections === undefined) ||
    (defaults?.validateStatus !== undefined &&
      !Object.prototype.hasOwnProperty.call(input, 'validateStatus')) ||
    (defaults?.responseType !== undefined &&
      input.responseType === undefined) ||
    (defaultMaxContentLength !== undefined &&
      input.maxContentLength === undefined) ||
    (defaultMaxBodyLength !== undefined && input.maxBodyLength === undefined) ||
    (defaultTimeoutErrorMessage !== undefined &&
      input.timeoutErrorMessage === undefined) ||
    (defaultDecompress !== undefined && input.decompress === undefined) ||
    (defaultSocketPath !== undefined && input.socketPath === undefined) ||
    (defaultBeforeRedirect !== undefined &&
      input.beforeRedirect === undefined) ||
    (defaults?.allowAbsoluteUrls !== undefined &&
      input.allowAbsoluteUrls === undefined) ||
    (defaults?.transitional !== undefined &&
      input.transitional === undefined) ||
    (defaults?.onUploadProgress !== undefined &&
      input.onUploadProgress === undefined) ||
    (defaults?.onDownloadProgress !== undefined &&
      input.onDownloadProgress === undefined) ||
    (defaults?.maxRate !== undefined && input.maxRate === undefined) ||
    (defaults?.parseReviver !== undefined &&
      input.parseReviver === undefined) ||
    (defaults?.sensitiveHeaders !== undefined &&
      input.sensitiveHeaders === undefined) ||
    (defaults?.formSerializer !== undefined &&
      input.formSerializer === undefined) ||
    (headerBase
      ? headerBase.hasWork
      : headersHaveWork(defaultHeaders, instanceHeaders, lowerMethod));
  if (!needsWork) {
    return {
      url,
      options: input,
      raw: { url, baseURL: undefined, params: undefined, method: lowerMethod },
    };
  }

  const rawUrl = url;
  const {
    url: _url,
    baseURL: _baseURL,
    params,
    paramsSerializer,
    data,
    auth: _auth,
    cancelToken,
    maxRedirects: _maxRedirects,
    validateStatus: inputValidateStatus,
    ...options
  } = input;
  options.method = method;
  // `validateStatus` present as an own key (even `null`, or explicit
  // `undefined`) always wins over the default, as in axios' `settle()`
  // (`!validateStatus || validateStatus(status)` - a non-function
  // `validateStatus` always resolves). Only a truly *absent* key falls back
  // to `defaults`/the built-in 2xx range - see `toAxiosLikeResponse`.
  const validateStatusProvided = Object.prototype.hasOwnProperty.call(
    input,
    'validateStatus',
  );
  if (validateStatusProvided) {
    options.validateStatus = inputValidateStatus;
  }

  // URL: baseURL + params. `allowAbsoluteUrls: false` makes an absolute
  // `url` combine with `baseURL` anyway (naive concatenation, exactly like a
  // relative one), instead of replacing it outright - axios'
  // `buildFullPath`.
  if (
    typeof url === 'string' &&
    baseURL &&
    (!isAbsoluteURL(url) || allowAbsoluteUrls === false)
  ) {
    url = combineURLs(baseURL, url);
  }
  // Credentials embedded in the URL (`http://user:pass@host`) become Basic
  // auth, as in axios - but only when `config.auth` didn't already win.
  if (!auth && typeof url === 'string') {
    const credentials = extractUrlCredentials(url);
    if (credentials) {
      auth = { username: credentials.username, password: credentials.password };
      url = credentials.url;
    }
  }
  const mergedParams =
    isPlainObject(baseParams) && isPlainObject(params)
      ? { ...baseParams, ...params }
      : (params ?? baseParams);
  if (mergedParams) {
    // A synchronous throw here (a throwing `paramsSerializer`, `params`
    // shaped in a way `buildURL` can't stringify - e.g. an invalid `Date` -
    // or any other synchronous error while building the URL) must reject as
    // a proper `AxiosError`, not propagate a raw error - matching axios
    // exactly (`lib/adapters/http.js`: `buildURL(...)` inside its own
    // `try`/`catch`, `AxiosError.from(err, AxiosError.ERR_BAD_REQUEST,
    // config, null, null, { url: own('url'), exists: true })`, checked
    // against real axios 1.20's own "should display error while parsing
    // params" test) - plan.md phase 2 "fix: remaining error-shape gaps",
    // item 2 ("a synchronous config-normalization error ... should be
    // wrapped as an AxiosError"). `config` is built from what's already
    // resolved at this point (this function runs before
    // `HttpInterceptorRequest` exists yet, so there's no lazy-config request
    // object to hand `AxiosError` here).
    const rawUrlString = typeof rawUrl === 'string' ? rawUrl : String(rawUrl);
    try {
      url = buildURL(
        url.toString(),
        mergedParams,
        paramsSerializer ??
          defaults?.paramsSerializer ??
          instance.paramsSerializer,
      );
    } catch (err) {
      throw AxiosError.from(
        err,
        AxiosError.ERR_BAD_REQUEST,
        {
          url: rawUrlString,
          baseURL,
          params: mergedParams,
          method: lowerMethod,
        } as any,
        undefined,
        undefined,
        { url: rawUrlString, exists: true },
      );
    }
  }

  // Headers, lowest to highest priority: module (`register()`) headers ->
  // axiosRef defaults (the axios-style request defaults, including the
  // built-in Accept/User-Agent/Accept-Encoding, and seeded from module
  // headers at setup - see `createAxiosRefDefaults`) -> per-request headers.
  // Each axios-style source is itself `common` -> `<method>` -> flat, so a
  // header set for one method (or unqualified) is overridden by a more
  // specific one from the same source before the next source is applied.
  // `base` is already merged (one casing per header, string values), so
  // with no per-request headers a shallow copy gives the same result.
  const headers = headerBase
    ? options.headers === undefined
      ? { ...headerBase.base }
      : mergeHeaders(headerBase.base, options.headers)
    : mergeHeaders(
        instanceHeaders?.common,
        instanceHeaders?.[lowerMethod],
        flatDefaultHeaders(instanceHeaders),
        defaultHeaders?.common,
        defaultHeaders?.[lowerMethod],
        flatDefaultHeaders(defaultHeaders),
        options.headers,
      );

  // `auth` overrides any Authorization header, as in axios
  if (auth) {
    const token = Buffer.from(
      `${auth.username || ''}:${auth.password || ''}`,
    ).toString('base64');
    Object.keys(headers).forEach(key => {
      if (key.toLowerCase() === 'authorization') delete headers[key];
    });
    headers.Authorization = `Basic ${token}`;
  }

  // Precedence: request > axiosRef.defaults (module options are seeded into
  // defaults at setup - see `DEFAULTS_PASSTHROUGH_KEYS` in
  // `axios-ref.factory.ts`), matching every other passthrough default.
  if (
    options.onUploadProgress === undefined &&
    defaults?.onUploadProgress !== undefined
  ) {
    options.onUploadProgress = defaults.onUploadProgress;
  }
  if (
    options.onDownloadProgress === undefined &&
    defaults?.onDownloadProgress !== undefined
  ) {
    options.onDownloadProgress = defaults.onDownloadProgress;
  }
  if (options.maxRate === undefined && defaults?.maxRate !== undefined) {
    options.maxRate = defaults.maxRate;
  }
  if (
    options.parseReviver === undefined &&
    defaults?.parseReviver !== undefined
  ) {
    options.parseReviver = defaults.parseReviver;
  }
  if (
    options.sensitiveHeaders === undefined &&
    defaults?.sensitiveHeaders !== undefined
  ) {
    options.sensitiveHeaders = defaults.sensitiveHeaders;
  }
  const formSerializer: FormSerializerOptions | undefined =
    options.formSerializer ?? defaults?.formSerializer;
  if (options.formSerializer === undefined && formSerializer !== undefined) {
    options.formSerializer = formSerializer;
  }

  if (options.body === undefined) {
    if (data !== undefined) {
      options.body = serializeRequestData(
        data,
        headers,
        method,
        formSerializer,
      );
    } else if (method === 'POST' || method === 'PUT' || method === 'PATCH') {
      // axios' dispatchRequest sets this default unconditionally for these
      // 3 methods, even with no `data` at all (`config.headers
      // .setContentType('application/x-www-form-urlencoded', false)`).
      setHeaderIfMissing(headers, 'Content-Type', FORM_URLENCODED);
    }
  }
  options.headers = headers;

  if (maxRedirects !== undefined && options.maxRedirections === undefined) {
    options.maxRedirections = maxRedirects;
  }
  if (options.timeout === undefined && defaultTimeout !== undefined) {
    options.timeout = defaultTimeout;
  }
  // `validateStatus`/`responseType` from `axiosRef.defaults`, read at
  // request time (not seeded once) so a runtime mutation takes effect
  // immediately, even on this fast path (no axiosRef interceptors/adapter/
  // transforms in play) - `toAxiosLikeResponse` reads both straight off
  // `request.options`.
  if (!validateStatusProvided && defaults?.validateStatus !== undefined) {
    options.validateStatus = defaults.validateStatus;
  }
  if (
    options.responseType === undefined &&
    defaults?.responseType !== undefined
  ) {
    options.responseType = defaults.responseType;
  }
  // Per-request wins over axiosRef.defaults/module, as in axios
  // (`defaultToConfig2`) - see `plan/reports/axios-compat.md`'s "a
  // module-level `maxContentLength` overrides the per-request value" bug.
  // CodeRabbit review finding: these 5 used to fall back to `instance`
  // (module options) only, never `defaults` - so `axiosRef.create({
  // maxContentLength: ... })`/a runtime `axiosRef.defaults.maxContentLength
  // = ...` had no effect. `defaultX` above already resolves `defaults ??
  // instance`, matching every other passthrough default in this function.
  if (
    options.maxContentLength === undefined &&
    defaultMaxContentLength !== undefined
  ) {
    options.maxContentLength = defaultMaxContentLength;
  }
  if (
    options.maxBodyLength === undefined &&
    defaultMaxBodyLength !== undefined
  ) {
    options.maxBodyLength = defaultMaxBodyLength;
  }
  if (
    options.timeoutErrorMessage === undefined &&
    defaultTimeoutErrorMessage !== undefined
  ) {
    options.timeoutErrorMessage = defaultTimeoutErrorMessage;
  }
  if (options.decompress === undefined && defaultDecompress !== undefined) {
    options.decompress = defaultDecompress;
  }
  if (options.socketPath === undefined && defaultSocketPath !== undefined) {
    options.socketPath = defaultSocketPath;
  }
  if (
    options.beforeRedirect === undefined &&
    defaultBeforeRedirect !== undefined
  ) {
    options.beforeRedirect = defaultBeforeRedirect;
  }
  // Precedence: request > axiosRef.defaults - module options are already
  // folded into `defaults` at setup (`DEFAULTS_PASSTHROUGH_KEYS`), matching
  // `parseReviver`/`sensitiveHeaders` above (no separate `instance.
  // transitional` fallback needed).
  if (
    options.transitional === undefined &&
    defaults?.transitional !== undefined
  ) {
    options.transitional = defaults.transitional;
  }

  const signal = resolveSignal(options.signal, cancelToken);
  if (signal) options.signal = signal;

  return {
    url,
    options,
    raw: { url: rawUrl, baseURL, params: mergedParams, method: lowerMethod },
  };
}

/**
 * Lazily builds the axios-shaped config for `response.config` / `error.config`
 * from a `HttpInterceptorRequest`. Prefers the already-normalised `raw` seed
 * a request built through `normalizeAxiosRequest` carries (cheap: no combined
 * URL, no serialisation, no `AxiosHeaders` wrap); falls back to reconstructing
 * from `options` for requests that reach here some other way.
 *
 * Callers (`AxiosLikeResponseImpl`, `AxiosError`) call this from a `config`
 * getter on first read and cache the result themselves - *not* from a
 * per-instance `Object.defineProperty`, which measurably costs more than a
 * plain field write on every request, defeating the point of being lazy.
 */
export function buildLazyAxiosConfig(
  request: HttpInterceptorRequest & { raw?: NormalizedRequestSeed },
): InternalAxiosLikeRequestConfig {
  if (request.axiosConfig !== undefined)
    return request.axiosConfig as InternalAxiosLikeRequestConfig;
  const options: any = request.options || {};
  const raw = request.raw;
  const url = raw ? raw.url : request.url;
  const method = raw
    ? raw.method
    : String(options.method || 'GET').toLowerCase();
  const headers = new AxiosHeaders(
    options.headers && typeof options.headers === 'object'
      ? (options.headers as Record<string, string | string[]>)
      : undefined,
  );
  return {
    url: typeof url === 'string' ? url : String(url),
    baseURL: raw?.baseURL,
    params: raw?.params,
    method,
    data: options.body,
    headers,
    timeout: options.headersTimeout || options.bodyTimeout,
    maxRedirects: options.maxRedirections,
    validateStatus: options.validateStatus,
    responseType: options.responseType,
  };
}

// ---------------------------------------------------------------------------
// The axiosRef interceptor pipeline: build a raw (unserialised) axios config,
// let request interceptors see/mutate it, then serialise it into undici
// dispatch options. Used only when the service has axiosRef request/response
// interceptors or a `transformRequest`/`transformResponse` in play - see
// `HttpService.request()`, which otherwise keeps the fast path above.
// ---------------------------------------------------------------------------

/**
 * Builds the single, mutable, axios-shaped config object that flows through
 * axiosRef request interceptors, dispatch, and `response.config` /
 * `error.config`: raw `data`, `params`, `baseURL` and `url` as given, a
 * lower-case `method`, and `headers` as `AxiosHeaders`. Mirrors axios'
 * `mergeConfig(this.defaults, config)` step (defaults + module + per-request
 * merged, nothing serialised or combined yet).
 */
export function buildAxiosConfig(
  urlOrConfig: Url | ({ url?: Url } & Record<string, any>),
  requestOptions: Record<string, any> | undefined,
  context: AxiosRequestContext = {},
): InternalAxiosLikeRequestConfig {
  let url: Url;
  let input: Record<string, any>;
  if (isAxiosRequestConfig(urlOrConfig)) {
    input = { ...urlOrConfig, ...requestOptions };
    url = urlOrConfig.url ?? '';
  } else {
    input = requestOptions || {};
    url = urlOrConfig as Url;
  }

  const defaults = context.defaults;
  const instance: Record<string, any> = context.instanceOptions || {};
  const method = String(input.method || 'GET').toUpperCase();
  const lowerMethod = method.toLowerCase();

  const defaultHeaders = defaults?.headers as Record<string, any> | undefined;
  const instanceHeaders = instance.headers as Record<string, any> | undefined;
  const headerBase = getHeaderBase(
    defaults ?? instance,
    defaultHeaders,
    instanceHeaders,
    lowerMethod as any,
  );

  const baseURL = input.baseURL ?? defaults?.baseURL ?? instance.baseURL;
  const auth = input.auth ?? defaults?.auth ?? instance.auth;
  const defaultTimeout =
    defaults?.timeout ??
    (instance.headersTimeout === undefined ? instance.timeout : undefined);
  const maxRedirects =
    input.maxRedirects ?? defaults?.maxRedirects ?? instance.maxRedirects;
  const allowAbsoluteUrls =
    input.allowAbsoluteUrls ??
    defaults?.allowAbsoluteUrls ??
    instance.allowAbsoluteUrls;
  // See the matching comment in `normalizeAxiosRequest`: an own key (even
  // `null`) always wins over `defaults`/`instance`.
  const validateStatusProvided = Object.prototype.hasOwnProperty.call(
    input,
    'validateStatus',
  );

  const {
    url: _url,
    baseURL: _baseURL,
    params,
    paramsSerializer,
    data,
    auth: _auth,
    cancelToken,
    maxRedirects: _maxRedirects,
    headers: inputHeaders,
    method: _method,
    ...rest
  } = input;

  const baseParams = defaults?.params ?? instance.params;
  const mergedParams =
    isPlainObject(baseParams) && isPlainObject(params)
      ? { ...baseParams, ...params }
      : (params ?? baseParams);

  // Precedence: request > axiosRef.defaults > module - see the matching
  // comment in `normalizeAxiosRequest` above.
  const headerPlain = headerBase
    ? inputHeaders === undefined
      ? { ...headerBase.base }
      : mergeHeaders(headerBase.base, inputHeaders)
    : mergeHeaders(
        instanceHeaders?.common,
        instanceHeaders?.[lowerMethod],
        flatDefaultHeaders(instanceHeaders),
        defaultHeaders?.common,
        defaultHeaders?.[lowerMethod],
        flatDefaultHeaders(defaultHeaders),
        inputHeaders,
      );

  const headers = new AxiosHeaders(headerPlain);

  if (auth) {
    const token = Buffer.from(
      `${auth.username || ''}:${auth.password || ''}`,
    ).toString('base64');
    headers.setAuthorization(`Basic ${token}`);
  }

  const config: InternalAxiosLikeRequestConfig = {
    ...rest,
    url: typeof url === 'string' ? url : String(url),
    baseURL,
    params: mergedParams,
    paramsSerializer:
      paramsSerializer ??
      defaults?.paramsSerializer ??
      instance.paramsSerializer,
    method: lowerMethod,
    data,
    headers,
    auth,
    cancelToken,
    timeout: input.timeout ?? defaultTimeout,
    maxRedirects,
    allowAbsoluteUrls,
    // CodeRabbit review finding: these 5 (plus `auth`/`allowAbsoluteUrls`
    // above) used to fall back to `instance` (module options) only, never
    // `defaults` - so `axiosRef.create({ maxContentLength: ... })`/a
    // runtime `axiosRef.defaults.maxContentLength = ...` had no effect on
    // an instance's own axiosRef pipeline requests. `timeoutErrorMessage`
    // wasn't even read here at all before (it only ever reached `config` via
    // the `...rest` spread above, i.e. request-level only).
    beforeRedirect:
      input.beforeRedirect ??
      defaults?.beforeRedirect ??
      instance.beforeRedirect,
    sensitiveHeaders:
      input.sensitiveHeaders ??
      defaults?.sensitiveHeaders ??
      instance.sensitiveHeaders,
    validateStatus: validateStatusProvided
      ? input.validateStatus
      : (defaults?.validateStatus ?? instance.validateStatus),
    responseType:
      input.responseType ?? defaults?.responseType ?? instance.responseType,
    decompress: input.decompress ?? defaults?.decompress ?? instance.decompress,
    maxContentLength:
      input.maxContentLength ??
      defaults?.maxContentLength ??
      instance.maxContentLength,
    maxBodyLength:
      input.maxBodyLength ?? defaults?.maxBodyLength ?? instance.maxBodyLength,
    timeoutErrorMessage:
      input.timeoutErrorMessage ??
      defaults?.timeoutErrorMessage ??
      instance.timeoutErrorMessage,
    transformRequest:
      input.transformRequest ??
      defaults?.transformRequest ??
      instance.transformRequest,
    transformResponse:
      input.transformResponse ??
      defaults?.transformResponse ??
      instance.transformResponse,
    socketPath: input.socketPath ?? defaults?.socketPath ?? instance.socketPath,
    adapter: input.adapter ?? defaults?.adapter ?? instance.adapter,
    onUploadProgress: input.onUploadProgress ?? defaults?.onUploadProgress,
    onDownloadProgress:
      input.onDownloadProgress ?? defaults?.onDownloadProgress,
    maxRate: input.maxRate ?? defaults?.maxRate,
    formSerializer: input.formSerializer ?? defaults?.formSerializer,
    parseReviver: input.parseReviver ?? defaults?.parseReviver,
    // plan.md phase 2 "transitional.silentJSONParsing": request >
    // axiosRef.defaults, the same precedence as every other passthrough
    // default above - module options are already folded into `defaults` at
    // setup (`DEFAULTS_PASSTHROUGH_KEYS`), so no separate `instance.
    // transitional` fallback is needed here, matching `parseReviver`/
    // `formSerializer` just above.
    transitional: input.transitional ?? defaults?.transitional,
  };

  return config;
}

/**
 * Serialises a (possibly interceptor-mutated) axios config into the
 * undici-level `{ url, options }` pair `executeRequest` dispatches, mutating
 * `config.data` to the final serialised body and `config.headers` to a
 * canonical `AxiosHeaders` instance - exactly like axios' `dispatchRequest`
 * mutating the same config object in place. The returned request carries the
 * config back for `response.config` / `error.config`.
 */
export function serializeAxiosConfig(
  config: InternalAxiosLikeRequestConfig,
): HttpInterceptorRequest {
  const headers =
    config.headers instanceof AxiosHeaders
      ? config.headers
      : new AxiosHeaders(config.headers as any);
  config.headers = headers;

  const lowerMethod = String(config.method || 'get').toLowerCase();
  const upperMethod = lowerMethod.toUpperCase();
  config.method = lowerMethod;

  let dispatchUrl: Url = config.url ?? '';
  if (
    typeof dispatchUrl === 'string' &&
    config.baseURL &&
    (!isAbsoluteURL(dispatchUrl) || (config as any).allowAbsoluteUrls === false)
  ) {
    dispatchUrl = combineURLs(config.baseURL, dispatchUrl);
  }
  // Credentials embedded in the URL become Basic auth, as in axios - but
  // only when `config.auth` didn't already win.
  let auth = config.auth;
  if (!auth && typeof dispatchUrl === 'string') {
    const credentials = extractUrlCredentials(dispatchUrl);
    if (credentials) {
      auth = { username: credentials.username, password: credentials.password };
      dispatchUrl = credentials.url;
    }
  }
  if (config.params) {
    // Same fix as `normalizeAxiosRequest`'s own `buildURL` call above - see
    // its doc comment. `config` is already the full, resolved axios config
    // here, so it's handed to `AxiosError.from` directly, exactly as axios'
    // own `AxiosError.from(err, AxiosError.ERR_BAD_REQUEST, config, null,
    // null, { url: own('url'), exists: true })`.
    try {
      dispatchUrl = buildURL(
        dispatchUrl.toString(),
        config.params,
        config.paramsSerializer,
      );
    } catch (err) {
      const rawUrlString =
        typeof config.url === 'string' ? config.url : String(config.url);
      throw AxiosError.from(
        err,
        AxiosError.ERR_BAD_REQUEST,
        config,
        undefined,
        undefined,
        { url: rawUrlString, exists: true },
      );
    }
  }

  if (auth) {
    const token = Buffer.from(
      `${auth.username || ''}:${auth.password || ''}`,
    ).toString('base64');
    headers.setAuthorization(`Basic ${token}`);
  }

  let body: any;
  if (config.transformRequest) {
    const transforms = Array.isArray(config.transformRequest)
      ? config.transformRequest
      : [config.transformRequest];
    body = transforms.reduce(
      (value: any, fn: any) => fn.call(config, value, headers),
      config.data,
    );
  } else {
    body = serializeRequestData(
      config.data,
      headers as any,
      upperMethod,
      config.formSerializer,
    );
  }
  config.data = body;

  const options: Record<string, any> = {
    method: upperMethod,
    body,
    headers: headers.toJSON(),
  };

  if (config.timeout !== undefined) {
    // The raw axios timeout (ms), read by `executeRequest`'s own deadline
    // timer; `headersTimeout`/`bodyTimeout` stay a backstop against
    // undici's idle timers.
    options.timeout = config.timeout;
    options.headersTimeout = config.timeout;
    options.bodyTimeout = config.timeout;
  }
  if (config.timeoutErrorMessage !== undefined) {
    options.timeoutErrorMessage = config.timeoutErrorMessage;
  }
  if (config.transitional !== undefined) {
    options.transitional = config.transitional;
  }
  if (config.maxRedirects !== undefined) {
    options.maxRedirections = config.maxRedirects;
  }
  if (config.beforeRedirect !== undefined) {
    options.beforeRedirect = config.beforeRedirect;
  }
  if (config.sensitiveHeaders !== undefined) {
    options.sensitiveHeaders = config.sensitiveHeaders;
  }
  if (config.validateStatus !== undefined) {
    options.validateStatus = config.validateStatus;
  }
  if (config.responseType !== undefined) {
    options.responseType = config.responseType;
  }
  if (config.decompress !== undefined) {
    options.decompress = config.decompress;
  }
  if (config.maxContentLength !== undefined) {
    options.maxContentLength = config.maxContentLength;
  }
  if (config.maxBodyLength !== undefined) {
    options.maxBodyLength = config.maxBodyLength;
  }
  if ((config as any).dispatcher !== undefined) {
    options.dispatcher = (config as any).dispatcher;
  }
  if (config.socketPath !== undefined) {
    options.socketPath = config.socketPath;
  }
  if (config.onUploadProgress !== undefined) {
    options.onUploadProgress = config.onUploadProgress;
  }
  if (config.onDownloadProgress !== undefined) {
    options.onDownloadProgress = config.onDownloadProgress;
  }
  if (config.maxRate !== undefined) {
    options.maxRate = config.maxRate;
  }
  if (config.parseReviver !== undefined) {
    options.parseReviver = config.parseReviver;
  }

  const signal = resolveSignal(
    (config as any).signal,
    config.cancelToken as any,
  );
  if (signal) options.signal = signal;

  const interceptorRequest: HttpInterceptorRequest = {
    url: dispatchUrl,
    options,
    axiosConfig: config,
  };
  return interceptorRequest;
}
