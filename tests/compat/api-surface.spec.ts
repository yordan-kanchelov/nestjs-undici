/**
 * API-surface parity with @nestjs/axios.
 *
 * Compares the runtime members of @nestjs/axios' `HttpService`, its
 * `axiosRef` (an axios instance: methods, `defaults` keys, the
 * `interceptors` API) and axios' `AxiosHeaders` against ours.
 *
 * Fails when:
 *  - an upstream member is missing here and isn't in ALLOWLIST below, so a
 *    new upstream member (e.g. `query()`, added in @nestjs/axios 12) is
 *    caught instead of silently going unimplemented;
 *  - an ALLOWLIST entry now exists on our side, so the allowlist gets
 *    cleaned up instead of drifting from reality.
 *
 * Port of plan/prototypes/automation/api-surface-parity.cjs
 * (plan.md phase 1 item C, plan/reports/automation.md §3).
 */
import 'reflect-metadata';
import { Test, TestingModule } from '@nestjs/testing';
import {
  HttpModule as RefHttpModule,
  HttpService as RefHttpService,
} from '@nestjs/axios';
import { AxiosHeaders as RefAxiosHeaders } from 'axios';

import {
  AxiosHeaders as OurAxiosHeaders,
  HttpModule as OurHttpModule,
  HttpService as OurHttpService,
} from '../../src';

/** One documented, tracked gap. */
interface AllowedGap {
  /** Why our side doesn't have this member (yet). */
  reason: string;
  /** The plan item or doc section that tracks closing the gap. */
  tracked: string;
}

/** Adds one allowlist entry per member, keyed `${surface}:${member}`. */
function allow(
  target: Record<string, AllowedGap>,
  surface: string,
  members: string[],
  gap: AllowedGap,
): void {
  for (const member of members) target[`${surface}:${member}`] = gap;
}

// Known, documented gaps. Anything else missing on our side fails the test.
const ALLOWLIST: Record<string, AllowedGap> = {};

allow(ALLOWLIST, 'HttpService', ['instance', 'makeObservable'], {
  reason:
    'protected @nestjs/axios internals (TypeScript `protected` is still enumerable at runtime), not part of the public API',
  tracked: 'plan/reports/automation.md §3 (API-surface parity)',
});
// axiosRef is now a real, callable axios instance (plan.md "feat(axiosRef):
// make it a real axios instance"): callable, getUri/create/*Form/query,
// full defaults (validateStatus/params/responseType/transformRequest/
// transformResponse/timeout/baseURL/headers/adapter/withCredentials/
// paramsSerializer), HttpService.query(). What's left, all separately
// tracked:
allow(
  ALLOWLIST,
  'axiosRef.defaults',
  ['hasOwnProperty', 'xsrfCookieName', 'xsrfHeaderName', 'env'],
  {
    reason:
      'not part of this item: axios options this library never maps at module level either (xsrfCookieName/xsrfHeaderName are a documented no-op; env/hasOwnProperty are axios internals with no equivalent here). `transitional` is now populated - see plan.md phase 2 "transitional.silentJSONParsing". `maxContentLength`/`maxBodyLength` are now populated too - see the CodeRabbit review fix for `axiosRef.create()`/`axiosRef.defaults` dropping options (docs/axios-supported-options.md).',
    tracked: 'docs/axios-supported-options.md',
  },
);
allow(ALLOWLIST, 'axiosRef.interceptors.request', ['handlers', 'forEach'], {
  reason:
    'internal @nestjs/axios/axios interceptor-manager implementation details (an array of registered handlers, and a raw forEach over it), not part of the public API this library mirrors',
  tracked: 'plan.md phase 2 "types: axios interop"',
});

// This class' public members are deliberately a *subset* of axios' own
// AxiosHeaders (not a superset): axios registers Accept-Encoding as a
// runtime accessor (`AxiosHeaders.accessor([...])` in its own
// core/AxiosHeaders.js) but never declares it in its own `.d.ts` - adding it
// here would make this class *wider* than axios' declared type, breaking
// the mutual TypeScript assignability plan.md "feat(axiosRef): make it a
// real axios instance" needs. Use `setContentEncoding`/`set('Accept-Encoding',
// ...)` instead (see axios-headers.ts).
/** Public own keys along the whole prototype chain (methods and data props alike). */
function ownMembers(value: unknown): Set<string> {
  const out = new Set<string>();
  for (
    let o: any = value;
    o !== null &&
    o !== undefined &&
    o !== Object.prototype &&
    o !== Function.prototype;
    o = Object.getPrototypeOf(o)
  ) {
    for (const key of Reflect.ownKeys(o)) {
      if (
        typeof key === 'string' &&
        key !== 'constructor' &&
        !key.startsWith('_')
      ) {
        out.add(key);
      }
    }
  }
  return out;
}

describe('API-surface parity with @nestjs/axios', () => {
  let refModule: TestingModule;
  let ourModule: TestingModule;
  let refService: RefHttpService;
  let ourService: OurHttpService;

  beforeAll(async () => {
    [refModule, ourModule] = await Promise.all([
      Test.createTestingModule({
        imports: [RefHttpModule.register({})],
      }).compile(),
      Test.createTestingModule({
        imports: [OurHttpModule.register({})],
      }).compile(),
    ]);
    refService = refModule.get(RefHttpService);
    ourService = ourModule.get(OurHttpService);
  });

  afterAll(async () => {
    await Promise.all([refModule.close(), ourModule.close()]);
  });

  function surfaces(): Record<string, [unknown, unknown]> {
    return {
      HttpService: [refService, ourService],
      axiosRef: [refService.axiosRef, ourService.axiosRef],
      'axiosRef.defaults': [
        refService.axiosRef.defaults,
        ourService.axiosRef.defaults,
      ],
      'axiosRef.interceptors.request': [
        refService.axiosRef.interceptors.request,
        ourService.axiosRef.interceptors.request,
      ],
      'AxiosHeaders instance': [
        new RefAxiosHeaders({ a: '1' }),
        new OurAxiosHeaders({ a: '1' }),
      ],
    };
  }

  it('has no un-allowlisted missing members', () => {
    const failures: string[] = [];
    for (const [surface, [refValue, ourValue]] of Object.entries(surfaces())) {
      const refMembers = ownMembers(refValue);
      const ourMembers = ownMembers(ourValue);
      for (const member of refMembers) {
        if (ourMembers.has(member)) continue;
        const key = `${surface}:${member}`;
        if (!ALLOWLIST[key]) {
          failures.push(
            `${key} is missing and not allowlisted. Either implement it, or add ` +
              `an ALLOWLIST entry with a reason and a tracking link.`,
          );
        }
      }
    }
    expect(failures).toEqual([]);
  });

  it('has no stale allowlist entries (member now exists on our side)', () => {
    const surfaceValues = surfaces();
    const failures: string[] = [];
    for (const key of Object.keys(ALLOWLIST)) {
      const separatorIndex = key.indexOf(':');
      const surface = key.slice(0, separatorIndex);
      const member = key.slice(separatorIndex + 1);
      const pair = surfaceValues[surface];
      if (!pair) continue;
      const [, ourValue] = pair;
      if (ownMembers(ourValue).has(member)) {
        failures.push(
          `${key} is allowlisted as missing, but now exists on our side. Remove it from ALLOWLIST.`,
        );
      }
    }
    expect(failures).toEqual([]);
  });
});
