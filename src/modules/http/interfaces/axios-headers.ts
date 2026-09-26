/**
 * Axios-compatible header types
 * These types match axios header definitions for compatibility
 */

/**
 * Valid axios header value types. Matches axios' own `AxiosHeaderValue`
 * exactly (including the `AxiosHeaders` branch, and no `undefined`):
 * methods that accept "no value" (meaning "skip/remove", see
 * `AxiosHeaders#set`) type it as an *optional* parameter (`value?:
 * AxiosHeaderValue`) instead, the same way axios' own `.d.ts` does. This
 * exact match matters for mutual assignability with axios' own
 * `AxiosHeaders` class (plan.md "feat(axiosRef): make it a real axios
 * instance") - `get()`'s parser-callback overload is contravariant in this
 * type, so a narrower union here breaks it.
 */
export type AxiosHeaderValue =
  AxiosHeaders | string | string[] | number | boolean | null;

/**
 * Common HTTP request headers with proper typing
 */
export interface CommonRequestHeaders {
  Accept?: AxiosHeaderValue;
  'Accept-Encoding'?: AxiosHeaderValue;
  'Accept-Language'?: AxiosHeaderValue;
  Authorization?: AxiosHeaderValue;
  'Cache-Control'?: AxiosHeaderValue;
  'Content-Encoding'?: AxiosHeaderValue;
  'Content-Length'?: AxiosHeaderValue;
  'Content-Type'?: AxiosHeaderValue;
  Cookie?: AxiosHeaderValue;
  Host?: AxiosHeaderValue;
  Origin?: AxiosHeaderValue;
  Referer?: AxiosHeaderValue;
  'User-Agent'?: AxiosHeaderValue;
  'X-Requested-With'?: AxiosHeaderValue;
}

/**
 * Raw axios headers interface - allows any string key with AxiosHeaderValue
 */
export interface RawAxiosHeaders {
  [key: string]: AxiosHeaderValue;
}

/**
 * Combined axios request headers type
 * Supports common headers with proper typing and any custom headers
 */
export type AxiosRequestHeaders = Partial<
  RawAxiosHeaders & CommonRequestHeaders
>;

// ---------------------------------------------------------------------------
// Header value sanitization (plan.md phase 2: "sanitize CRLF / non-Latin1
// header values like axios")
// ---------------------------------------------------------------------------

/**
 * axios sanitizes a header value *twice*, at two different points in time,
 * with two different allowed sets (`lib/helpers/sanitizeHeaderValue.js`,
 * checked against real axios 1.20) - not composable into one pass, because
 * axiosRef request interceptors run *between* them and can observe/rewrite
 * the value in between (see `sanitizeByteStringHeaderValue`'s doc comment
 * below for the concrete case this matters for):
 *
 * 1. When a value is set on an `AxiosHeaders` instance (`sanitizeHeaderValue`
 *    below): strips every C0/DEL control character (CRLF and friends) -
 *    `INVALID_UNICODE_HEADER_VALUE_CHARS` in axios' source. A non-ASCII
 *    Unicode character (an emoji, `请求用户`, ...) is *not* touched here.
 * 2. Right before the request is actually dispatched, once
 *    (`sanitizeByteStringHeaderValue` below, called by `toByteStringHeader
 *    Object` in axios, and by `HttpService.executeRequest`'s own
 *    `sanitizeHeadersToByteString` here): strips anything outside the
 *    Latin-1 byte range - `INVALID_BYTE_STRING_HEADER_VALUE_CHARS`, a
 *    strictly *wider* set than pass 1's (every character pass 1 removes is
 *    also outside pass 2's allowed range, so pass 2 alone is a safe,
 *    idempotent superset check, useful as a defense-in-depth final pass even
 *    where pass 1 already ran).
 *
 * Where undici would otherwise throw `InvalidArgumentError` for a header
 * value axios' Node `http` transport silently rewrites (a bare `\n`, an
 * emoji, ...), these strip it the same way up front, so undici never sees
 * the invalid bytes and the two libraries send the same bytes on the wire -
 * checked against real axios 1.20 (`tests/compat/differential/errors.diff
 * .spec.ts`, "header value with an embedded newline").
 */
// eslint-disable-next-line no-control-regex -- intentionally targets C0/DEL controls, matching axios' own `INVALID_UNICODE_HEADER_VALUE_CHARS`.
const HEADER_VALUE_CONTROL_CHARS_RE = /[\u0000-\u0008\u000a-\u001f\u007f]/;
// eslint-disable-next-line no-control-regex -- see HEADER_VALUE_CONTROL_CHARS_RE above.
const HEADER_VALUE_CONTROL_CHARS_RE_G = /[\u0000-\u0008\u000a-\u001f\u007f]+/g;
const HEADER_VALUE_NON_LATIN1_RE = /[^\t\x20-\x7e\x80-\xff]/;
const HEADER_VALUE_NON_LATIN1_RE_G = /[^\t\x20-\x7e\x80-\xff]+/g;

/** axios' `trimSPorHTAB` (`sanitizeHeaderValue.js`): trims only space/tab, never other whitespace. */
function trimSpaceOrTab(value: string): string {
  let start = 0;
  let end = value.length;
  while (start < end) {
    const c = value.charCodeAt(start);
    if (c !== 0x09 && c !== 0x20) break;
    start++;
  }
  while (end > start) {
    const c = value.charCodeAt(end - 1);
    if (c !== 0x09 && c !== 0x20) break;
    end--;
  }
  return start === 0 && end === value.length ? value : value.slice(start, end);
}

/**
 * Pass 1 (see the doc comment above): strips CRLF and every other C0/DEL
 * control character - what axios applies whenever a header value is *set*
 * (`AxiosHeaders#set`, and `axios-request.adapter.ts`'s `mergeHeaders` for
 * the fast, plain-object dispatch path, which never builds an `AxiosHeaders`
 * instance). Deliberately leaves a non-Latin1 Unicode character untouched -
 * only pass 2 (`sanitizeByteStringHeaderValue`) removes those, once, right
 * before dispatch. A `test()` pass first, with no allocation, keeps the
 * overwhelming common case (a value with no invalid characters) at exactly
 * its prior cost. Axios' own `sanitizeValue` trims unconditionally (even a
 * value with no invalid characters can have a leading/trailing space/tab
 * trimmed), so a value that needs no character removal still gets the cheap
 * trim check.
 */
export function sanitizeHeaderValue(value: string): string {
  const cleaned = HEADER_VALUE_CONTROL_CHARS_RE.test(value)
    ? value.replace(HEADER_VALUE_CONTROL_CHARS_RE_G, '')
    : value;
  return trimSpaceOrTab(cleaned);
}

/**
 * Pass 2 (see the doc comment above): strips anything outside the Latin-1
 * byte range - what axios applies exactly once, right before a request is
 * actually dispatched (`toByteStringHeaderObject`), *after* axiosRef request
 * interceptors have already run. This distinction is what lets an
 * interceptor read/transform a header value pass 1 left untouched - e.g.
 * axios' own "should allow request interceptors to encode Unicode header
 * values before Node sends them" test: a request is built with a raw
 * Unicode header value, a request interceptor `encodeURIComponent`s it
 * (reading the *original* Unicode text, only possible because pass 1 never
 * touched it), and only the *interceptor's own* (now Latin1-only) result
 * ever reaches pass 2. Sanitizing at set-time with this pass' wider set
 * instead - the mistake this doc comment is here to prevent regressing back
 * into - would strip the Unicode text before the interceptor ever sees it,
 * breaking exactly that case. Same `test()`-first shape as
 * `sanitizeHeaderValue` above.
 */
export function sanitizeByteStringHeaderValue(value: string): string {
  const cleaned = HEADER_VALUE_NON_LATIN1_RE.test(value)
    ? value.replace(HEADER_VALUE_NON_LATIN1_RE_G, '')
    : value;
  return trimSpaceOrTab(cleaned);
}

/**
 * axios' `toByteStringHeaderObject`: applies `sanitizeByteStringHeaderValue`
 * (pass 2 above) to every value of a plain headers object, once, right
 * before it's handed to the actual transport - called from
 * `HttpService.executeRequest`, after axiosRef request interceptors (if any)
 * have already run, on both the fast and axiosRef-pipeline dispatch paths.
 * Returns the *same* object (no allocation at all) when nothing needs
 * stripping - the overwhelming common case - and otherwise a shallow copy,
 * so the original (e.g. `response.config.headers`/`error.config.headers`,
 * which reads the pre-pass-2 value, matching axios) is never mutated.
 */
export function sanitizeHeadersToByteString(
  headers: Record<string, any>,
): Record<string, any> {
  let out: Record<string, any> | undefined;
  for (const key of Object.keys(headers)) {
    const value = headers[key];
    let sanitized: any = value;
    if (typeof value === 'string') {
      sanitized = sanitizeByteStringHeaderValue(value);
    } else if (Array.isArray(value)) {
      let changed = false;
      const mapped = value.map(v => {
        if (typeof v !== 'string') return v;
        const s = sanitizeByteStringHeaderValue(v);
        if (s !== v) changed = true;
        return s;
      });
      sanitized = changed ? mapped : value;
    }
    if (sanitized !== value) {
      (out ??= { ...headers })[key] = sanitized;
    }
  }
  return out ?? headers;
}

/** `has`/`delete`/`clear`'s optional value matcher, matching axios' `AxiosHeaderMatcher`. */
export type AxiosHeaderMatcher =
  | string
  | RegExp
  | ((this: AxiosHeaders, value: string, name: string) => boolean);

type AxiosHeaderParser = (
  this: AxiosHeaders,
  value: AxiosHeaderValue,
  header: string,
) => any;

/** Same as axios' own `isValidHeaderName`: a single token, not a raw multi-header string. */
const VALID_HEADER_NAME_RE = /^[-_a-zA-Z0-9^`|~,!#$%&'*+.]+$/;
function isValidHeaderName(name: string): boolean {
  return VALID_HEADER_NAME_RE.test(name.trim());
}

function matchHeaderValue(
  target: AxiosHeaders,
  value: AxiosHeaderValue,
  name: string,
  matcher: AxiosHeaderMatcher,
): boolean {
  if (typeof matcher === 'function')
    return matcher.call(target, String(value), name);
  if (value == null || typeof value !== 'string') return false;
  if (matcher instanceof RegExp) return matcher.test(value);
  return value.indexOf(matcher) !== -1;
}

/** `Content-Type: a; charset=utf-8` -> `{ charset: 'utf-8' }`, like axios' own `parseTokens`/`get(name, true)`. */
function parseTokens(str: string): Record<string, string | undefined> {
  const tokens: Record<string, string | undefined> = Object.create(null);
  const tokensRE = /([^\s,;=]+)\s*(?:=\s*([^,;]+))?/g;
  let match: RegExpExecArray | null;
  while ((match = tokensRE.exec(str))) {
    tokens[match[1]] = match[2];
  }
  return tokens;
}

/**
 * Title-cases a header name per hyphen/underscore-separated segment
 * (`content-type` -> `Content-Type`), exactly like axios' own `formatHeader`
 * (used by `normalize(true)`).
 */
function formatHeaderName(header: string): string {
  return header
    .trim()
    .toLowerCase()
    .replace(/([a-z\d])(\w*)/g, (_w, char: string, str: string) => {
      return char.toUpperCase() + str;
    });
}

/**
 * The per-instance backing store, keyed by lower-cased header name to
 * `[originalName, value]`. Kept under this module-private, `unique symbol`
 * key rather than a *named* field on purpose: a TypeScript class with any
 * `private`/`protected`/`#` member becomes nominally typed (only that exact
 * class, or a subclass, can satisfy it structurally) - axios' own `.d.ts`
 * declares `AxiosHeaders` with no private members at all, so any of those
 * would break the mutual assignability plan.md "feat(axiosRef): make it a
 * real axios instance" needs (this class assignable *to* axios' own
 * `AxiosHeaders`, and vice versa). A symbol-keyed field sidesteps that: it's
 * an ordinary (structurally-typed) class field, just one nothing outside
 * this module can name - declared `?:` (optional) below so axios' own
 * class, which naturally doesn't have it, still satisfies "this class
 * requires it" the same way any object satisfies an unset optional
 * property. It also happens to be the fastest option measured (a plain
 * property read/write): a `WeakMap`, tried first, cost ~200ns per
 * `.set()` alone (V8's weak-reference bookkeeping) - measurable, since this
 * class is constructed on every request that goes through the axiosRef
 * pipeline, or whose `response.config`/`error.config` is read.  Being
 * symbol-keyed also keeps it out of `Object.keys()`/`JSON.stringify()`/
 * `{...spread}` on its own, with no extra work in the `ownKeys` trap below.
 */
const STORE: unique symbol = Symbol('AxiosHeaders store');

/** The backing `Map` for `target` (always present - set at the top of the constructor). */
function store(target: AxiosHeaders): Map<string, [string, AxiosHeaderValue]> {
  return target[STORE]!;
}

/**
 * `target.set(name, value, rewrite)`'s single-header implementation,
 * operating directly on the resolved backing `Map` - callers setting many
 * headers at once (the constructor, `set()`'s bulk forms) resolve `store()`
 * once and reuse `map` across the whole batch, instead of paying a
 * `WeakMap.get` per header (measurable: this class is constructed on every
 * request that goes through the axiosRef pipeline, or reads `response.config`/
 * `error.config`, so its own construction cost is on the hot path - see the
 * class doc below).
 *
 * A free function, not a class method: axios has no equivalent public
 * method, and any *extra* public member this class declares beyond axios'
 * own `.d.ts` breaks the mutual assignability plan.md's "feat(axiosRef):
 * make it a real axios instance" needs (see the `setAcceptEncoding` note
 * further down) - a free function avoids the class surface entirely,
 * without needing TS `private` (which brings back the nominal-typing
 * problem `STORE`'s own doc comment explains).
 */
/**
 * Sanitizes a value being stored into this class' backing map, the same way
 * axios' `normalizeValue` (`AxiosHeaders.js`) does for a *string* value -
 * CRLF/non-Latin1 characters are only ever a concern for a string. Unlike
 * axios' own `normalizeValue` (which also unconditionally coerces every
 * other value with `String()`), a number/boolean/`null` is left exactly as
 * given: this class already preserves those types through `get()`/`toJSON()`
 * (see the "should handle different value types" test), a deliberate,
 * pre-existing difference from axios untouched by this fix - only the
 * string (and string-array) case, where an actual sanitization concern
 * exists, is touched here.
 */
function normalizeHeaderValue(value: AxiosHeaderValue): AxiosHeaderValue {
  if (typeof value === 'string') return sanitizeHeaderValue(value);
  if (Array.isArray(value)) {
    return value.map(v => (typeof v === 'string' ? sanitizeHeaderValue(v) : v));
  }
  return value;
}

function setInMap(
  map: Map<string, [string, AxiosHeaderValue]>,
  name: string,
  value: AxiosHeaderValue | undefined,
  rewrite: boolean | AxiosHeaderMatcher | undefined,
): void {
  const lower = name.trim().toLowerCase();
  if (!lower) return;
  if (value === undefined) return;
  const existing = map.get(lower);
  if (rewrite === false && existing && existing[1] !== undefined) return;
  // Preserve the casing a header was *first* set with, exactly like axios
  // (`utils.findKey` reuses the existing property name on every later
  // `set()` for the same header, regardless of the casing passed this
  // time).
  const preservedName = existing ? existing[0] : name;
  map.set(lower, [preservedName, normalizeHeaderValue(value)]);
}

/** Single-header `set()`, resolving `store(target)` itself - for the rare call outside a batch (see `setInMap`). */
function setOne(
  target: AxiosHeaders,
  name: string,
  value: AxiosHeaderValue | undefined,
  rewrite: boolean | AxiosHeaderMatcher | undefined,
): void {
  setInMap(store(target), name, value, rewrite);
}

/** `target.set(rawMultiHeaderString)` - see `setInMap` above for why this resolves the map once. */
function parseRawString(target: AxiosHeaders, raw: string): void {
  const map = store(target);
  raw.split('\n').forEach(line => {
    const [key, ...valueParts] = line.split(':');
    if (key && valueParts.length) {
      setInMap(map, key.trim(), valueParts.join(':').trim(), undefined);
    }
  });
}

/**
 * Iterates `target`'s headers in the preserved casing - used internally
 * (merging one `AxiosHeaders` into another in `set()`) instead of a public
 * `forEach()` method: axios' own `AxiosHeaders` has no `forEach` either (it
 * uses a module-private `utils.forEach(this, ...)` helper, not a class
 * method - see `core/AxiosHeaders.js`), so a free function here too keeps
 * this class's public surface matching axios' own exactly (see `setInMap`'s
 * doc comment for why that matters). External callers get the same
 * capability through `Array.from(headers)` (the class *does* implement
 * `[Symbol.iterator]`, which axios declares too).
 */
function forEachEntry(
  target: AxiosHeaders,
  callback: (value: AxiosHeaderValue, key: string) => void,
): void {
  store(target).forEach(([name, value]) => callback(value, name));
}

/**
 * AxiosHeaders class for advanced header manipulation.
 *
 * Case-insensitive lookup, casing preserved: the name a header is first set
 * with is the name `toJSON()`/`toString()`/`forEach()`/spread/`Object.keys()`
 * report back, exactly like axios' own `AxiosHeaders` (which stores each
 * header as an own property under whatever name it was first set with, and
 * finds it again case-insensitively via `utils.findKey`). Internally this is
 * a single `Map` from the lower-cased name to `[originalName, value]` - O(1)
 * case-insensitive get/set/has/delete, cheap to build per request (this class
 * is constructed on every request that goes through the axiosRef pipeline -
 * see `axios-request.adapter.ts`).
 */
export class AxiosHeaders {
  // Matches axios' own `AxiosHeaders` type declaration: lets bracket
  // notation (`config.headers['Authorization'] = ...`) type-check under
  // `strict`, on top of the Proxy that already supports it at runtime.
  [key: string]: any;
  /** See `STORE`'s doc comment above for why this is a symbol-keyed, optional field. */
  [STORE]?: Map<string, [string, AxiosHeaderValue]>;

  constructor(headers?: RawAxiosHeaders | AxiosHeaders | string) {
    this[STORE] = new Map();

    if (headers) {
      if (typeof headers === 'string') {
        parseRawString(this, headers);
      } else {
        this.set(headers);
      }
    }

    // Return a Proxy to support bracket notation. `store()` reads `[STORE]`
    // directly, which works whether it's given the raw instance above or
    // *this* proxy (the `get` trap below reads straight through to the
    // target's own `[STORE]` property either way, the same as any other
    // property) - e.g. `new AxiosHeaders(otherAxiosHeadersInstance)` passes
    // the proxy `otherAxiosHeadersInstance` to `set()`, which reaches
    // `store()` too (via `instanceof AxiosHeaders` + `forEachEntry`).
    // Methods invoked *through* the proxy see the raw `this` either way
    // (the trap `.bind(target)`s them to it before returning).
    return new Proxy(this, {
      get(target, prop: string | symbol) {
        // If it's a method or property of AxiosHeaders, return it
        if (prop in target) {
          const value = (target as any)[prop];
          if (typeof value === 'function') {
            return value.bind(target);
          }
          return value;
        }

        // Otherwise, treat it as a header key
        if (typeof prop === 'string') {
          return target.get(prop);
        }

        return undefined;
      },

      set(target, prop: string | symbol, value: AxiosHeaderValue) {
        // Don't allow setting methods or internal properties
        if (prop in target) {
          return false;
        }

        // Set as header
        if (typeof prop === 'string') {
          target.set(prop, value);
          return true;
        }

        return false;
      },

      has(target, prop: string | symbol) {
        // Check if it's a property/method first
        if (prop in target) {
          return true;
        }

        // Otherwise check headers
        if (typeof prop === 'string') {
          return target.has(prop);
        }

        return false;
      },

      deleteProperty(target, prop: string | symbol) {
        // Don't allow deleting methods or internal properties
        if (prop in target) {
          return false;
        }

        // Delete header
        if (typeof prop === 'string') {
          return target.delete(prop);
        }

        return false;
      },

      ownKeys(target) {
        // Header keys (original casing, as first set), plus the class'
        // method names (non-enumerable, so `Object.keys()`/`for...in`/spread
        // only ever see the header keys) - `Object.getOwnPropertyNames`
        // only returns *string*-keyed names, so the symbol-keyed `[STORE]`
        // field (see its doc comment) is never a candidate here either way.
        const classKeys = Object.getOwnPropertyNames(
          Object.getPrototypeOf(target),
        );
        const headerKeys = Array.from(store(target).values(), ([name]) => name);
        return [...new Set([...classKeys, ...headerKeys])];
      },

      getOwnPropertyDescriptor(target, prop: string | symbol) {
        // For class properties/methods
        if (prop in target) {
          return (
            Object.getOwnPropertyDescriptor(target, prop) ||
            Object.getOwnPropertyDescriptor(Object.getPrototypeOf(target), prop)
          );
        }

        // For headers
        if (typeof prop === 'string' && target.has(prop)) {
          return {
            configurable: true,
            enumerable: true,
            value: target.get(prop),
          };
        }

        return undefined;
      },
    });
  }

  /**
   * Set one header (`set(name, value, rewrite?)`), or merge many at once
   * from a plain object, another `AxiosHeaders` instance, a raw multi-header
   * string or a `[name, value]`-pair iterable (`set(headers, rewrite?)`) -
   * covers the same three call shapes as axios' own three `set()` overloads.
   * A single, wide signature (rather than three separate overloads, like
   * axios' own `.d.ts`) on purpose: TypeScript compares an overloaded
   * method's signatures against a target's overloads by trying to match
   * *some* source overload to *each* target overload, not positionally, and
   * in practice that comparison doesn't line up reliably even when each
   * pair of overloads is individually assignable - a single signature wide
   * enough to satisfy every one of axios' own three overloads (both
   * directions: this class assignable *to* axios' `AxiosHeaders`, and vice
   * versa - see plan.md "feat(axiosRef): make it a real axios instance")
   * sidesteps that entirely. `rewrite: false` only sets a header that isn't
   * already present (or is currently `undefined`); the default overwrites.
   * The `AxiosHeaderMatcher` third-parameter shape (a string/RegExp/function
   * "only rewrite if the existing value matches") is accepted for type
   * compatibility with axios' own overload but not implemented - `rewrite`
   * is only ever read as `=== false` here.
   */
  set(
    headerOrHeaders?:
      | string
      | RawAxiosHeaders
      | AxiosHeaders
      | Iterable<[string, AxiosHeaderValue]>,
    valueOrRewrite?: AxiosHeaderValue | boolean,
    rewrite?: boolean | AxiosHeaderMatcher,
  ): this {
    if (headerOrHeaders === undefined || headerOrHeaders === null) {
      return this;
    }

    if (typeof headerOrHeaders === 'string') {
      // A single, valid header token (`isValidHeaderName`, matching axios'
      // own check) is always the 3-arg `set(name, value, rewrite?)` shape,
      // *regardless of the value's type* - this is what lets `set('X', true)`
      // set a boolean value rather than being misread as `set(headers,
      // rewrite: true)`. Anything else (a multi-line "A: b\nC: d" string) is
      // the raw-headers-string shape, and the second argument is `rewrite`.
      if (isValidHeaderName(headerOrHeaders)) {
        setOne(
          this,
          headerOrHeaders,
          valueOrRewrite as AxiosHeaderValue,
          rewrite,
        );
      } else {
        parseRawString(this, headerOrHeaders);
      }
      return this;
    }

    // Every bulk form below sets 0+ headers from `headerOrHeaders` - resolve
    // the backing `Map` once (a single `WeakMap.get`) and reuse it, instead
    // of once per header (`setInMap`'s own doc comment explains why this
    // matters).
    const map = store(this);
    const asRewrite = valueOrRewrite as
      boolean | AxiosHeaderMatcher | undefined;
    if (headerOrHeaders instanceof AxiosHeaders) {
      forEachEntry(headerOrHeaders, (v, k) => setInMap(map, k, v, asRewrite));
      return this;
    }

    // A `[name, value]`-pair iterable (e.g. a `Map`) - matches axios' third
    // `set()` overload. Checked before the plain-object branch below: a
    // plain object literal has no `Symbol.iterator`, so this never matches
    // one.
    if (typeof (headerOrHeaders as any)[Symbol.iterator] === 'function') {
      for (const [key, value] of headerOrHeaders as Iterable<
        [string, AxiosHeaderValue]
      >) {
        setInMap(map, key, value, asRewrite);
      }
      return this;
    }

    for (const key in headerOrHeaders) {
      setInMap(map, key, (headerOrHeaders as RawAxiosHeaders)[key], asRewrite);
    }
    return this;
  }

  /**
   * Get a header value, case-insensitively. `parser === true` parses a
   * `key=value; key2=value2`-shaped value (as axios' `get(name, true)`
   * does); a function or `RegExp` parser works the same as axios'. A single
   * signature (return type `any`, `parser` loosely typed) rather than
   * three overloads mirroring axios' own three - see the doc comment on
   * `set()` above for why.
   */
  get(header: string, parser?: any): any {
    const lower = header?.trim().toLowerCase();
    if (!lower) return undefined;
    const entry = store(this).get(lower);
    if (!entry) return undefined;
    const [name, value] = entry;
    if (!parser) return value;
    if (parser === true) return parseTokens(String(value));
    if (parser instanceof RegExp) return parser.exec(String(value));
    if (typeof parser === 'function') return parser.call(this, value, name);
    return value;
  }

  /** Check if header exists, case-insensitively, optionally matching its value. */
  has(header: string, matcher?: AxiosHeaderMatcher): boolean {
    const lower = header?.trim().toLowerCase();
    if (!lower) return false;
    const entry = store(this).get(lower);
    if (!entry || entry[1] === undefined) return false;
    if (!matcher) return true;
    return matchHeaderValue(this, entry[1], entry[0], matcher);
  }

  /** Delete one or several headers, case-insensitively, optionally matching their value. */
  delete(header: string | string[], matcher?: AxiosHeaderMatcher): boolean {
    const names = Array.isArray(header) ? header : [header];
    let deleted = false;
    for (const name of names) {
      const lower = name?.trim().toLowerCase();
      if (!lower) continue;
      const entry = store(this).get(lower);
      if (!entry) continue;
      if (matcher && !matchHeaderValue(this, entry[1], entry[0], matcher))
        continue;
      store(this).delete(lower);
      deleted = true;
    }
    return deleted;
  }

  /** Clear all headers, optionally only those matching `matcher`. */
  clear(matcher?: AxiosHeaderMatcher): boolean {
    if (!matcher) {
      const had = store(this).size > 0;
      store(this).clear();
      return had;
    }
    let deleted = false;
    for (const [lower, [name, value]] of Array.from(store(this))) {
      if (matchHeaderValue(this, value, name, matcher)) {
        store(this).delete(lower);
        deleted = true;
      }
    }
    return deleted;
  }

  /**
   * Sets (or removes, with `false`) the `Authorization` header. Matches
   * axios' `AxiosHeaders#setAuthorization`.
   */
  setAuthorization(
    value: AxiosHeaderValue | false,
    rewrite?: boolean | AxiosHeaderMatcher,
  ): this {
    if (value === false) {
      this.delete('Authorization');
    } else {
      this.set('Authorization', value, rewrite);
    }
    return this;
  }

  /** Reads the `Authorization` header. Matches axios' `AxiosHeaders#getAuthorization`. */
  getAuthorization(parser?: any): any {
    return this.get('Authorization', parser);
  }

  /** Matches axios' `AxiosHeaders#hasAuthorization`. */
  hasAuthorization(): boolean {
    return this.has('Authorization');
  }

  /**
   * Sets (or removes, with `false`) the `Content-Type` header. Matches
   * axios' `AxiosHeaders#setContentType`.
   */
  setContentType(
    value: AxiosHeaderValue | false,
    rewrite?: boolean | AxiosHeaderMatcher,
  ): this {
    if (value === false) {
      this.delete('Content-Type');
    } else {
      this.set('Content-Type', value, rewrite);
    }
    return this;
  }

  /**
   * Reads the `Content-Type` header. Matches axios' `AxiosHeaders#getContentType`.
   */
  getContentType(parser?: any): any {
    return this.get('Content-Type', parser);
  }

  /** Matches axios' `AxiosHeaders#hasContentType`. */
  hasContentType(): boolean {
    return this.has('Content-Type');
  }

  /** Matches axios' `AxiosHeaders#setContentLength`. */
  setContentLength(
    value: AxiosHeaderValue | false,
    rewrite?: boolean | AxiosHeaderMatcher,
  ): this {
    if (value === false) {
      this.delete('Content-Length');
    } else {
      this.set('Content-Length', value, rewrite);
    }
    return this;
  }

  /** Matches axios' `AxiosHeaders#getContentLength`. */
  getContentLength(parser?: any): any {
    return this.get('Content-Length', parser);
  }

  /** Matches axios' `AxiosHeaders#hasContentLength`. */
  hasContentLength(): boolean {
    return this.has('Content-Length');
  }

  /** Matches axios' `AxiosHeaders#setAccept`. */
  setAccept(
    value: AxiosHeaderValue | false,
    rewrite?: boolean | AxiosHeaderMatcher,
  ): this {
    if (value === false) {
      this.delete('Accept');
    } else {
      this.set('Accept', value, rewrite);
    }
    return this;
  }

  /** Matches axios' `AxiosHeaders#getAccept`. */
  getAccept(parser?: any): any {
    return this.get('Accept', parser);
  }

  /** Matches axios' `AxiosHeaders#hasAccept`. */
  hasAccept(): boolean {
    return this.has('Accept');
  }

  // `setAcceptEncoding`/`getAcceptEncoding`/`hasAcceptEncoding` exist at
  // runtime (added to the prototype below the class), as in axios, which
  // registers them as accessors but doesn't declare them in its `.d.ts`.
  // Declaring them here would make this class wider than axios' declared
  // type and break assignability between the two.

  /** Matches axios' `AxiosHeaders#setContentEncoding` (in its `.d.ts`, though its own runtime accessor list uses `Accept-Encoding` instead - both are provided here). */
  setContentEncoding(
    value: AxiosHeaderValue | false,
    rewrite?: boolean | AxiosHeaderMatcher,
  ): this {
    if (value === false) {
      this.delete('Content-Encoding');
    } else {
      this.set('Content-Encoding', value, rewrite);
    }
    return this;
  }

  /** Matches axios' `AxiosHeaders#getContentEncoding`. */
  getContentEncoding(parser?: any): any {
    return this.get('Content-Encoding', parser);
  }

  /** Matches axios' `AxiosHeaders#hasContentEncoding`. */
  hasContentEncoding(): boolean {
    return this.has('Content-Encoding');
  }

  /** Matches axios' `AxiosHeaders#setUserAgent`. */
  setUserAgent(
    value: AxiosHeaderValue | false,
    rewrite?: boolean | AxiosHeaderMatcher,
  ): this {
    if (value === false) {
      this.delete('User-Agent');
    } else {
      this.set('User-Agent', value, rewrite);
    }
    return this;
  }

  /** Matches axios' `AxiosHeaders#getUserAgent`. */
  getUserAgent(parser?: any): any {
    return this.get('User-Agent', parser);
  }

  /** Matches axios' `AxiosHeaders#hasUserAgent`. */
  hasUserAgent(): boolean {
    return this.has('User-Agent');
  }

  /**
   * Merge other header sources onto a *new* `AxiosHeaders` seeded from this
   * one. Matches axios' `AxiosHeaders#concat` (`this.constructor.concat(this, ...targets)`).
   */
  concat(
    ...sources: Array<
      AxiosHeaders | RawAxiosHeaders | string | undefined | null
    >
  ): AxiosHeaders {
    return AxiosHeaders.concat(this, ...sources);
  }

  /**
   * Title-cases every header name per hyphen/underscore-separated segment
   * (`content-type` -> `Content-Type`) when `format` is true, and merges any
   * case-duplicates (there are never any here - this class only ever holds
   * one entry per case-insensitive name - so this only ever re-cases the
   * stored name). `normalize()`/`normalize(false)` is a no-op, like axios'
   * own (it only trims/re-cases already-differently-cased duplicate keys,
   * which a `Map`-backed store never has).
   */
  normalize(format?: boolean): this {
    if (!format) return this;
    for (const [lower, [name, value]] of Array.from(store(this))) {
      const titled = formatHeaderName(name);
      if (titled !== name) store(this).set(lower, [titled, value]);
    }
    return this;
  }

  /** Matches axios' `AxiosHeaders#getSetCookie`: always an array, even for one cookie. */
  getSetCookie(): string[] {
    const value = this.get('set-cookie');
    if (value == null || value === false) return [];
    return Array.isArray(value) ? value.map(String) : [String(value)];
  }

  /** `"key: value"` per header, newline-separated, like axios' `AxiosHeaders#toString`. */
  toString(): string {
    return Object.entries(this.toJSON())
      .map(([key, value]) => `${key}: ${value}`)
      .join('\n');
  }

  /**
   * Get all headers as a plain object, keyed by the preserved (first-set)
   * casing - matching axios' own `toJSON()`.
   */
  toJSON(asStrings?: boolean): Record<string, any> {
    const result: Record<string, any> = {};
    store(this).forEach(([name, value]) => {
      if (value == null || value === false) return;
      result[name] =
        asStrings && Array.isArray(value) ? value.join(', ') : value;
    });
    return result;
  }

  /**
   * Create AxiosHeaders from various input types
   * @param thing - Input to convert to AxiosHeaders
   * @returns AxiosHeaders instance with proxy support
   */
  static from(thing?: AxiosHeaders | RawAxiosHeaders | string): AxiosHeaders {
    return thing instanceof AxiosHeaders ? thing : new AxiosHeaders(thing);
  }

  /** Matches axios' `AxiosHeaders.parseParameters` (`get(name, AxiosHeaders.parseParameters)`). */
  static parseParameters(
    value: AxiosHeaderValue,
  ): Record<string, string | undefined> {
    return parseTokens(String(value ?? ''));
  }

  /**
   * Concatenate headers
   * @param sources - Headers to concatenate
   * @returns New AxiosHeaders instance with all headers
   */
  static concat(
    ...sources: Array<
      AxiosHeaders | RawAxiosHeaders | string | undefined | null
    >
  ): AxiosHeaders {
    const result = new AxiosHeaders();
    sources.forEach(source => {
      if (source) result.set(source as any);
    });
    return result;
  }

  /**
   * Accepted for axios API parity. Axios uses this internally to define its
   * `setXxx`/`getXxx`/`hasXxx` shorthands dynamically; this class already
   * defines them explicitly (see above), so this is a no-op.
   */
  static accessor(_header: string | string[]): typeof AxiosHeaders {
    return AxiosHeaders;
  }

  /**
   * Normalize header name
   */
  static normalizeHeader(header: string): string {
    return header.toLowerCase();
  }

  /**
   * Iterator support - yields `[name, value]` in the preserved casing,
   * exactly like axios' own (`Object.entries(this.toJSON())[Symbol.iterator]()`).
   * Deliberately the *only* iteration helper this class declares publicly
   * (no separate `entries()`/`keys()`/`values()`, unlike the previous
   * version of this class): axios' own `.d.ts` declares only
   * `[Symbol.iterator]`, and adding the other three would - like
   * `setAcceptEncoding` above - make this class wider than axios' own,
   * breaking mutual assignability. Use `Array.from(headers)`,
   * `Object.keys(headers.toJSON())` or `Object.values(headers.toJSON())`
   * instead.
   */
  [Symbol.iterator](): IterableIterator<[string, AxiosHeaderValue]> {
    return (Object.entries(this.toJSON()) as Array<[string, AxiosHeaderValue]>)[
      Symbol.iterator
    ]();
  }
}

// Runtime-only accessors, matching axios' `AxiosHeaders.accessor(['Accept-Encoding', ...])`:
// present on instances, not declared in the type (see the note in the class).
Object.defineProperties(AxiosHeaders.prototype, {
  setAcceptEncoding: {
    value(this: AxiosHeaders, value: AxiosHeaderValue | false, rewrite?: any) {
      if (value === false) this.delete('Accept-Encoding');
      else this.set('Accept-Encoding', value, rewrite);
      return this;
    },
    writable: true,
    configurable: true,
  },
  getAcceptEncoding: {
    value(this: AxiosHeaders, parser?: any) {
      return this.get('Accept-Encoding', parser);
    },
    writable: true,
    configurable: true,
  },
  hasAcceptEncoding: {
    value(this: AxiosHeaders) {
      return this.has('Accept-Encoding');
    },
    writable: true,
    configurable: true,
  },
});
