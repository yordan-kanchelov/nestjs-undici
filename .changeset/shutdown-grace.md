---
'nestjs-axios-undici': minor
---

Fix: `HttpService.onModuleDestroy` no longer waits forever on an abandoned `responseType: 'stream'` response.

`app.close()`/`onModuleDestroy` still closes every dispatcher this library created gracefully first (`Dispatcher#close()` - lets in-flight requests finish, exactly as before). Past a short internal grace period (a few seconds, not configurable, and unrelated to a request `timeout`), anything still open is force-aborted instead of left hanging shutdown indefinitely - in practice, this only ever matters for a `responseType: 'stream'` response that was never read and never `.destroy()`d, since every other response shape is always fully drained by this library itself. Every cached per-path `socketPath` `Agent` closes concurrently too, so several of them no longer add up to several times the grace period. A dispatcher you supplied yourself is still never touched here - you own its lifecycle.

No public API change (the grace period is an internal constant, not an option).
