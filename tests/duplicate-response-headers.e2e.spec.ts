/**
 * e2e: duplicate response headers must be collapsed the way axios (running
 * on Node's `http`) collapses them, not left as undici's raw, uniformly
 * arrayed values - see `joinDuplicateHeaders` in
 * `axios-response.adapter.ts` for the exact per-name rules ported from
 * Node's `_http_incoming.js`.
 *
 * The server below is a raw `net` socket, not Node's `http.Server`:
 * `res.setHeader(name, [...])` on a real `http.Server` already joins a
 * `Cookie` response header itself before it ever reaches the wire (it has
 * its own, separate "cookie" special-case in `_http_outgoing.js`), which
 * would hide the one thing this test needs to prove - that *this package*,
 * not the server, is what joins/collapses/arrays a genuinely duplicated
 * wire header the way Node's `IncomingMessage.headers` getter would.
 */
import { createServer, Server } from 'node:net';
import { AddressInfo } from 'node:net';
import { Test, TestingModule } from '@nestjs/testing';
import { firstValueFrom } from 'rxjs';
import { HttpModule, HttpService } from '../src';

describe('HttpService duplicate response headers', () => {
  let server: Server;
  let baseUrl: string;
  let service: HttpService;

  beforeAll(async () => {
    server = createServer(socket => {
      socket.once('data', data => {
        if (data.toString('latin1').startsWith('GET /redirect ')) {
          socket.end(
            [
              'HTTP/1.1 302 Found',
              'Location: /',
              'X-Foo: one',
              'X-Foo: two',
              'Content-Length: 0',
              'Connection: close',
              '',
              '',
            ].join('\r\n'),
          );
          return;
        }
        socket.end(
          [
            'HTTP/1.1 200 OK',
            'X-Foo: one',
            'X-Foo: two',
            'Content-Type: text/plain',
            'Content-Type: text/html',
            'Set-Cookie: a=1; Path=/',
            'Set-Cookie: b=2; Path=/',
            'Cookie: c=1',
            'Cookie: d=2',
            'Content-Length: 2',
            'Connection: close',
            '',
            'ok',
          ].join('\r\n'),
        );
      });
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    const module: TestingModule = await Test.createTestingModule({
      imports: [HttpModule.register({})],
    }).compile();
    service = module.get<HttpService>(HttpService);
  });

  afterAll(async () => {
    await new Promise<void>(resolve => server.close(() => resolve()));
  });

  it('joins a generic duplicate header with ", ", like axios/Node', async () => {
    const response = await firstValueFrom(service.request(baseUrl));
    expect(response.headers['x-foo']).toBe('one, two');
  });

  it('keeps only the first value of a "no duplicates" header, like axios/Node', async () => {
    const response = await firstValueFrom(service.request(baseUrl));
    expect(response.headers['content-type']).toBe('text/plain');
  });

  it('always arrays set-cookie, like axios/Node', async () => {
    const response = await firstValueFrom(service.request(baseUrl));
    expect(response.headers['set-cookie']).toEqual([
      'a=1; Path=/',
      'b=2; Path=/',
    ]);
  });

  it('joins a duplicate cookie header with "; ", like axios/Node', async () => {
    const response = await firstValueFrom(service.request(baseUrl));
    expect(response.headers['cookie']).toBe('c=1; d=2');
  });

  it('hands beforeRedirect the same joined headers, like axios/follow-redirects', async () => {
    let seen: Record<string, unknown> | undefined;
    const response = await firstValueFrom(
      service.request({
        url: `${baseUrl}/redirect`,
        beforeRedirect: (
          _options: unknown,
          details: { headers: Record<string, unknown> },
        ) => {
          seen = details.headers;
        },
      } as any),
    );
    expect(response.data).toBe('ok');
    expect(seen?.['x-foo']).toBe('one, two');
  });

  it('leaves a response with no duplicated headers untouched', async () => {
    // Companion sanity check, not a fix-flips-it case on its own: the
    // common (no duplicates) path must still work.
    const response = await firstValueFrom(service.request(baseUrl));
    expect(response.headers['content-length']).toBe('2');
    expect(response.data).toBe('ok');
  });
});
