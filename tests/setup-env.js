// The library reads HTTP_PROXY/HTTPS_PROXY/NO_PROXY by default, as axios
// does. Tests talk to local servers and must not depend on (or be routed
// through) whatever proxy the machine running them has configured, so the
// variables are cleared here; the proxy e2e suite sets its own.
for (const key of [
  'HTTP_PROXY',
  'http_proxy',
  'HTTPS_PROXY',
  'https_proxy',
  'NO_PROXY',
  'no_proxy',
]) {
  delete process.env[key];
}
