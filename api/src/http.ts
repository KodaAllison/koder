/* A small node:http <-> Fetch (Request/Response) adapter, so main.ts keeps the
 * `handle(req: Request): Promise<Response>` shape it had under Deno.serve and
 * the routing code stays a line-for-line port. No framework: this is the
 * whole of it.
 *
 * The request body is a stream, never buffered here. A handler that only
 * wants the first N bytes (the GitHub webhook's 256 KiB cap) reads them and
 * cancels; cancelling stops delivering the body but does NOT destroy the
 * socket. Node then drains and discards whatever the client is still
 * sending, so the early 413 reaches a client that is mid-upload instead of
 * being lost to a connection reset. */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

export type Handler = (req: Request) => Promise<Response>;

/* What Deno.serve answers when the handler throws: a bare 500. */
function internalError(): Response {
  return new Response("Internal Server Error", { status: 500 });
}

function bodyStream(req: IncomingMessage): ReadableStream<Uint8Array> {
  let done = false;
  return new ReadableStream<Uint8Array>({
    start(controller) {
      req.on("data", (chunk: Buffer) => {
        if (done) return;
        controller.enqueue(new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength));
        // Backpressure: stop the socket while the reader is behind.
        if ((controller.desiredSize ?? 0) <= 0) req.pause();
      });
      req.on("end", () => {
        if (done) return;
        done = true;
        controller.close();
      });
      req.on("error", (err) => {
        if (done) return;
        done = true;
        controller.error(err);
      });
      req.pause();
    },
    pull() {
      req.resume();
    },
    cancel() {
      // Keep the connection: discard the rest of the body (flowing mode with
      // no consumer) rather than destroying the socket under the response.
      done = true;
      req.resume();
    },
  }, { highWaterMark: 64 * 1024, size: (chunk) => chunk.byteLength });
}

/* The URL a handler sees. Only the path and query matter to main.ts; the host
 * is the request's own when it parses, so nothing depends on it being right. */
function requestUrl(req: IncomingMessage): string {
  const path = req.url ?? "/";
  try {
    return new URL(path, `http://${req.headers.host ?? "localhost"}`).href;
  } catch {
    return new URL(path, "http://localhost").href;
  }
}

export function toRequest(req: IncomingMessage): Request {
  const headers = new Headers();
  const raw = req.rawHeaders;
  for (let i = 0; i + 1 < raw.length; i += 2) {
    try {
      headers.append(raw[i], raw[i + 1]);
    } catch {
      // A header value the Fetch API refuses (Node is laxer); drop it.
    }
  }
  const method = req.method ?? "GET";
  const hasBody = method !== "GET" && method !== "HEAD";
  return new Request(requestUrl(req), {
    method,
    headers,
    ...(hasBody ? { body: bodyStream(req), duplex: "half" } : {}),
  } as RequestInit);
}

async function writeResponse(res: ServerResponse, response: Response): Promise<void> {
  const headers: Record<string, string | string[]> = {};
  response.headers.forEach((value, name) => {
    headers[name] = value;
  });
  const setCookie = response.headers.getSetCookie();
  if (setCookie.length) headers["set-cookie"] = setCookie;
  if (!response.body) {
    res.writeHead(response.status, headers);
    res.end();
    return;
  }
  /* Bodies here are small (JSON documents, static files), so buffer them and
   * send a Content-Length rather than chunking. */
  const body = Buffer.from(await response.arrayBuffer());
  if (!("content-length" in headers)) headers["content-length"] = String(body.byteLength);
  res.writeHead(response.status, headers);
  res.end(body);
}

export function serve(handler: Handler): Server {
  return createServer(async (req, res) => {
    let response: Response;
    try {
      response = await handler(toRequest(req));
    } catch (err) {
      console.error(err);
      response = internalError();
    }
    try {
      await writeResponse(res, response);
    } catch (err) {
      console.error(err);
      res.destroy();
    }
    // A body the handler never read (a 401 on a PUT, say) is still paused on
    // the socket; drain it so a keep-alive connection can carry the next
    // request.
    if (!req.complete) {
      req.removeAllListeners("data");
      req.resume();
    }
  });
}

/* Listen and resolve once bound, with the port actually taken (PORT=0 picks a
 * free one, which is how the tests run it). */
export async function listen(server: Server, port: number): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, () => {
      server.off("error", reject);
      resolve();
    });
  });
  return (server.address() as AddressInfo).port;
}
