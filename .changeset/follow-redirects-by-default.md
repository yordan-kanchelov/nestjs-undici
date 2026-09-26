---
'nestjs-axios-undici': minor
---

Requests now follow redirects by default, like axios: up to 21 redirects (`maxRedirects`, unset), matching follow-redirects/axios exactly - 301/302 turn `POST` into `GET` and drop the body, 303 turns anything but `HEAD` into `GET` and drops the body, 307/308 keep the method and body, `Authorization`/`Cookie`/`Proxy-Authorization` are dropped across a protocol downgrade or a host (including port) change, and exceeding the limit rejects with `ERR_FR_TOO_MANY_REDIRECTS` ("Maximum number of redirects exceeded", no `response`, same as axios).

To opt out and get the previous behaviour (the 3xx response returned as-is, subject to `validateStatus` like any other status), set `maxRedirects: 0` per request or at module level (`HttpModule.register({ maxRedirects: 0 })`).

Also new: the axios `beforeRedirect(options, responseDetails, requestDetails)` option, at request and module level, and `response.request.res.responseUrl` (the final hop's URL) once a redirect was followed.

A request body that's a Node.js stream (not a `Buffer`/string/`FormData`) can't be resent on a redirect that keeps it (307/308, or a non-POST 301/302) - that now rejects clearly with `ERR_FR_REDIRECTION_FAILURE` instead of sending a broken request. Buffer the body yourself first if you need it to survive a redirect, or set `maxRedirects: 0` and follow it manually.

Redirects are handled manually on the response (a 3xx status + `Location` check) rather than by composing undici's own redirect interceptor onto every request, so a non-redirecting response's cost is unchanged.

`timeout` covers the whole redirect chain, as in axios, and `axiosRef.defaults.maxRedirects` is honoured.
