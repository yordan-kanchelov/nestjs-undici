import { Agent as HttpAgent } from 'http';
import { Agent as HttpsAgent } from 'https';
import {
  getAxiosCompatibilityWarnings,
  mapAxiosConfigToUndici,
  resolveAgentOptions,
} from '../axios-config.adapter';

describe('resolveAgentOptions', () => {
  it('extracts TLS options from httpsAgent.options', () => {
    const httpsAgent = new HttpsAgent({
      ca: 'CA',
      cert: 'CERT',
      key: 'KEY',
      pfx: 'PFX',
      passphrase: 'pass',
      rejectUnauthorized: false,
      servername: 'example.com',
      ciphers: 'TLS_AES_256_GCM_SHA384',
      minVersion: 'TLSv1.2',
      maxVersion: 'TLSv1.3',
    });

    const resolved = resolveAgentOptions({ httpsAgent });

    expect(resolved?.tls).toEqual({
      ca: 'CA',
      cert: 'CERT',
      key: 'KEY',
      pfx: 'PFX',
      passphrase: 'pass',
      rejectUnauthorized: false,
      servername: 'example.com',
      ciphers: 'TLS_AES_256_GCM_SHA384',
      minVersion: 'TLSv1.2',
      maxVersion: 'TLSv1.3',
    });
  });

  it('maps maxSockets -> connections and keepAlive -> pipelining', () => {
    const httpAgent = new HttpAgent({ keepAlive: true, maxSockets: 7 });
    const resolved = resolveAgentOptions({ httpAgent });
    expect(resolved?.connections).toBe(7);
    expect(resolved?.pipelining).toBe(1);
  });

  it('keepAlive:false maps to pipelining 0', () => {
    const httpAgent = new HttpAgent({ keepAlive: false });
    const resolved = resolveAgentOptions({ httpAgent });
    expect(resolved?.pipelining).toBe(0);
  });

  it('does not extract TLS options from a plain httpAgent', () => {
    // http.Agent has no TLS fields, but even if something TLS-shaped were
    // set on it, only httpsAgent should ever produce `tls`.
    const httpAgent = new HttpAgent({ maxSockets: 3 }) as any;
    httpAgent.options.rejectUnauthorized = false;
    const resolved = resolveAgentOptions({ httpAgent });
    expect(resolved?.tls).toBeUndefined();
    expect(resolved?.connections).toBe(3);
  });

  it('agent timeout is used only when no axios timeout is set', () => {
    const httpAgent = new HttpAgent({ timeout: 5000 });
    expect(resolveAgentOptions({ httpAgent })?.agentTimeout).toBe(5000);
    expect(
      resolveAgentOptions({ httpAgent, timeout: 1000 })?.agentTimeout,
    ).toBeUndefined();
  });

  it('httpVersion 2 (number or string) sets allowH2', () => {
    expect(resolveAgentOptions({ httpVersion: 2 })?.allowH2).toBe(true);
    expect(resolveAgentOptions({ httpVersion: '2' })?.allowH2).toBe(true);
    expect(resolveAgentOptions({ httpVersion: 1 })).toBeUndefined();
    expect(resolveAgentOptions({})).toBeUndefined();
  });

  it('httpsAgent takes precedence over httpAgent for TLS options', () => {
    const httpAgent = new HttpAgent({ maxSockets: 1 });
    const httpsAgent = new HttpsAgent({ maxSockets: 2, ca: 'CA' });
    const resolved = resolveAgentOptions({ httpAgent, httpsAgent });
    expect(resolved?.connections).toBe(2);
    expect(resolved?.tls).toEqual({ ca: 'CA' });
  });
});

describe('mapAxiosConfigToUndici: transport options', () => {
  it('stores resolved agent options under __resolvedConfig.agentOptions', () => {
    const httpsAgent = new HttpsAgent({ rejectUnauthorized: false });
    const result = mapAxiosConfigToUndici({ httpsAgent }) as any;
    expect(result.__resolvedConfig.agentOptions.tls).toEqual({
      rejectUnauthorized: false,
    });
  });

  it('maps an explicit proxy object to __resolvedConfig.proxyAgent', () => {
    const result = mapAxiosConfigToUndici({
      proxy: {
        host: 'proxy.example.com',
        port: 8080,
        auth: { username: 'u', password: 'p' },
      },
    }) as any;
    expect(result.__resolvedConfig.proxyAgent.uri).toBe(
      'http://proxy.example.com:8080',
    );
    expect(result.__resolvedConfig.proxyAgent.token).toBe(
      `Basic ${Buffer.from('u:p').toString('base64')}`,
    );
  });

  it('proxy: false does not create a resolved proxyAgent', () => {
    const result = mapAxiosConfigToUndici({ proxy: false }) as any;
    expect(result.__resolvedConfig?.proxyAgent).toBeUndefined();
  });

  it('httpVersion: 2 alone (no agent) still produces __resolvedConfig.agentOptions.allowH2', () => {
    const result = mapAxiosConfigToUndici({ httpVersion: 2 }) as any;
    expect(result.__resolvedConfig.agentOptions.allowH2).toBe(true);
  });

  it('no longer produces __socketPath or __axiosCompat', () => {
    const result = mapAxiosConfigToUndici({
      socketPath: '/tmp/x.sock',
      baseURL: 'http://api',
    }) as any;
    expect(result.__socketPath).toBeUndefined();
    expect(result.__axiosCompat).toBeUndefined();
  });
});

describe('getAxiosCompatibilityWarnings', () => {
  it('no longer warns about socketPath', () => {
    const warnings = getAxiosCompatibilityWarnings({
      socketPath: '/tmp/x.sock',
    });
    expect(warnings).toEqual([]);
  });
});
