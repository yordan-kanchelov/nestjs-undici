// Only the public, axios-compatible error surface is re-exported here. The
// internal helpers `axios-error.ts` also exports (`toAxiosError`,
// `createStatusError`, `createTimeoutError`, `createUnsupportedProtocolError`,
// `isDeadlineTimeoutReason`, `DeadlineTimeoutReason`, `EffectiveAbortSignal`)
// are consumed directly by `HttpService` and are not part of the public API
// (plan.md phase 3 "Trim the public API").
export {
  AxiosError,
  CanceledError,
  isAxiosError,
  isCancel,
} from './axios-error';
