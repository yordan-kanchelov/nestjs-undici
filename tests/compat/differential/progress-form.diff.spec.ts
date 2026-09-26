/**
 * Differential: progress callbacks (`onUploadProgress`/`onDownloadProgress`)
 * and `formSerializer` (plan.md phase 2 "Progress callbacks ...
 * formSerializer"). See harness.ts.
 *
 * Progress events are timing-dependent (real wall-clock throttling, chunk
 * boundaries that depend on the OS/loopback), so these cases compare only
 * the stable parts: the final `loaded`/`total`, that `progress` reaches 1,
 * that `loaded` never decreases across events, and the `upload`/`download`
 * flags - not the raw event stream or its timing. `formSerializer` output is
 * deterministic, so those cases compare the server-received field
 * names/values (or the raw url-encoded body) exactly.
 */
import { differential, Ctx } from './harness';

const DOWNLOAD_SIZE = 200_000;
const UPLOAD_SIZE = 300_000;

const routes = {
  '/echo': (req: any, res: any, body: string) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        method: req.method,
        headers: req.headers,
        body,
      }),
    );
  },
  '/download': (_req: any, res: any) => {
    const buf = Buffer.alloc(DOWNLOAD_SIZE, 'a');
    res.writeHead(200, {
      'Content-Type': 'text/plain',
      'Content-Length': String(buf.length),
    });
    res.end(buf);
  },
  '/redirect': (_req: any, res: any) => {
    res.writeHead(307, { Location: '/echo' });
    res.end();
  },
};

const echo = (ctx: Ctx) => `${ctx.base}/echo`;
const download = (ctx: Ctx) => `${ctx.base}/download`;
const redirect = (ctx: Ctx) => `${ctx.base}/redirect`;

/**
 * Splits a multipart body into `[name, value]` pairs by its own
 * `Content-Disposition: form-data; name="..."` headers - just enough to
 * compare field names/values across two different multipart encoders
 * (axios' own `formDataToStream` vs. this library's `globalFormDataToStream`/
 * undici's `Response`-based encoder), which use different boundary strings
 * and byte layouts for the exact same logical fields.
 */
function multipartFields(
  contentType: string | undefined,
  body: string,
): Array<[string, string]> {
  const m = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType || '');
  const boundary = m ? m[1] || m[2] : '';
  if (!boundary) return [];
  const parts = body
    .split(`--${boundary}`)
    .filter(p => p.trim() && p.trim() !== '--');
  const fields: Array<[string, string]> = [];
  for (const part of parts) {
    const nameMatch = /name="([^"]*)"/.exec(part);
    if (!nameMatch) continue;
    const headerEnd = part.indexOf('\r\n\r\n');
    const value =
      headerEnd === -1 ? '' : part.slice(headerEnd + 4).replace(/\r\n$/, '');
    fields.push([nameMatch[1], value]);
  }
  return fields;
}

/** The stable summary of a collected progress-event array - see the file doc comment. */
function summarizeProgress(events: any[], flag: 'upload' | 'download') {
  if (events.length === 0) return { count: 0 };
  const loadedSeq = events.map(e => e.loaded);
  const monotonic = loadedSeq.every(
    (v: number, i: number) => i === 0 || v >= loadedSeq[i - 1],
  );
  const last = events[events.length - 1];
  return {
    hasEvents: true,
    monotonic,
    finalLoadedEqualsTotal: last.loaded === last.total,
    finalProgressIsOne: last.progress === 1,
    lengthComputable: last.lengthComputable,
    allFlagged: events.every(e => e[flag] === true),
    noOppositeFlag: events.every(
      e => !e[flag === 'upload' ? 'download' : 'upload'],
    ),
    // `bytes`/`rate`/`estimated`/`event` are deliberately excluded - timing-
    // dependent, not compared.
  };
}

differential('progress callbacks / formSerializer', routes, [
  {
    name: 'onDownloadProgress: final loaded/total, monotonic, progress reaches 1, download flag only',
    run: async (s: any, ctx: Ctx) => {
      const events: any[] = [];
      const response = await s.axiosRef.get(download(ctx), {
        onDownloadProgress: (e: any) => events.push(e),
      });
      return {
        status: response.status,
        ...summarizeProgress(events, 'download'),
      };
    },
    normalize: (o: any) => (o.error ? { error: true } : o.result),
  },
  {
    name: 'onUploadProgress (Buffer body): final loaded/total, monotonic, progress reaches 1, upload flag only',
    run: async (s: any, ctx: Ctx) => {
      const events: any[] = [];
      const buf = Buffer.alloc(UPLOAD_SIZE, 'b');
      const response = await s.axiosRef.post(echo(ctx), buf, {
        onUploadProgress: (e: any) => events.push(e),
        headers: { 'Content-Type': 'application/octet-stream' },
      });
      return {
        status: response.status,
        ...summarizeProgress(events, 'upload'),
      };
    },
    normalize: (o: any) => (o.error ? { error: true } : o.result),
  },
  {
    // Review fix (PR #30): a metered upload used to turn a resendable
    // Buffer body into a one-shot stream *before* redirect handling ever
    // saw it, so a 307 redirect rejected here (but not without
    // `onUploadProgress`) - axios/follow-redirects resend it fine since they
    // buffer every byte written, regardless of any progress wrapper.
    name: 'a 307 redirect with a Buffer body + onUploadProgress succeeds, matching axios (upload progress reported, final loaded/total, monotonic)',
    run: async (s: any, ctx: Ctx) => {
      const events: any[] = [];
      const buf = Buffer.alloc(50_000, 'r');
      const response = await s.axiosRef.post(redirect(ctx), buf, {
        onUploadProgress: (e: any) => events.push(e),
        headers: { 'Content-Type': 'application/octet-stream' },
      });
      return {
        status: response.status,
        bodyLen: response.data.body.length,
        ...summarizeProgress(events, 'upload'),
      };
    },
    normalize: (o: any) => (o.error ? { error: true } : o.result),
  },
  {
    name: 'formSerializer indexes:true (postForm): exact multipart field names/values',
    run: async (s: any, ctx: Ctx) => {
      const response = await s.axiosRef.postForm(
        echo(ctx),
        { list: [10, 20] },
        { formSerializer: { indexes: true } },
      );
      const contentType = response.data.headers['content-type'] as string;
      return multipartFields(contentType, response.data.body);
    },
    normalize: (o: any) => (o.error ? { error: true } : o.result),
  },
  {
    name: 'formSerializer dots:true + metaTokens:false (postForm): exact multipart field names/values',
    run: async (s: any, ctx: Ctx) => {
      const response = await s.axiosRef.postForm(
        echo(ctx),
        { obj: { a: { b: 1 } }, 'meta{}': { x: 1 } },
        { formSerializer: { dots: true, metaTokens: false } },
      );
      const contentType = response.data.headers['content-type'] as string;
      return multipartFields(contentType, response.data.body);
    },
    normalize: (o: any) => (o.error ? { error: true } : o.result),
  },
  {
    name: 'formSerializer indexes:null (urlencoded body): exact raw body',
    run: async (s: any, ctx: Ctx) => {
      const response = await s.axiosRef.post(
        echo(ctx),
        { list: [1, 2] },
        {
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          formSerializer: { indexes: null },
        },
      );
      return response.data.body;
    },
    normalize: (o: any) => (o.error ? { error: true } : o.result),
  },
  {
    name: 'a real FormData sent with Content-Type: application/json is converted to JSON (formDataToJSON), like axios',
    run: async (s: any, ctx: Ctx) => {
      const form = new FormData();
      form.append('a', '1');
      form.append('b', '2');
      const response = await s.axiosRef.post(echo(ctx), form, {
        headers: { 'Content-Type': 'application/json' },
      });
      return {
        contentType: response.data.headers['content-type'],
        body: response.data.body,
      };
    },
    normalize: (o: any) => (o.error ? { error: true } : o.result),
  },
]);
