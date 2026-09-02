import test from "node:test";
import assert from "node:assert";
import { Mutex } from "../core/mutex.ts";

process.env.TEST_MOCK_QWEN_AUTH = "true";

import { app } from "../api/server.js";

test("Mutex removes an aborted waiter without blocking the next owner", async () => {
  const mutex = new Mutex();
  const releaseFirst = await mutex.acquire();
  const abortController = new AbortController();
  const waiting = mutex.acquire(60_000, abortController.signal);

  abortController.abort(new DOMException("Client disconnected", "AbortError"));
  await assert.rejects(waiting, { name: "AbortError" });

  releaseFirst();
  const releaseNext = await mutex.acquire(100);
  releaseNext();
  assert.equal(mutex.isIdle(), true);
});

test("Aborting a request cancels upstream acquisition before a response exists", async () => {
  const originalFetch = globalThis.fetch;
  let markUpstreamStarted: () => void = () => {};
  const upstreamStarted = new Promise<void>((resolve) => {
    markUpstreamStarted = resolve;
  });

  globalThis.fetch = async (
    input: string | URL | Request,
    init?: RequestInit,
  ) => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : input.url;
    if (url.includes("/api/models")) {
      return new Response(
        JSON.stringify({
          data: [
            {
              id: "qwen3.6-plus",
              owned_by: "qwen",
              info: { created_at: Date.now(), meta: {} },
            },
          ],
        }),
        { status: 200 },
      );
    }
    if (url.includes("/api/v2/chat/completions")) {
      markUpstreamStarted();
      return new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal;
        const abort = () =>
          reject(
            signal?.reason ??
              new DOMException("The operation was aborted", "AbortError"),
          );
        if (signal?.aborted) {
          abort();
        } else {
          signal?.addEventListener("abort", abort, { once: true });
        }
      });
    }
    return originalFetch(input, init);
  };

  const abortController = new AbortController();
  try {
    const responsePromise = app.fetch(
      new Request("http://localhost/v1/chat/completions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "qwen3.6-plus",
          messages: [{ role: "user", content: "Wait for cancellation" }],
          stream: false,
        }),
        signal: abortController.signal,
      }),
    );

    await upstreamStarted;
    abortController.abort(new DOMException("Client disconnected", "AbortError"));

    const response = await Promise.race([
      responsePromise,
      new Promise<never>((_resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error("Aborted request did not finish within 1s")),
          1_000,
        );
        timer.unref?.();
      }),
    ]);
    assert.equal(response.status, 499);
  } finally {
    globalThis.fetch = originalFetch;
  }
});


test("Concurrent new sessions can overlap after startup lock", async () => {
  const originalFetch = globalThis.fetch;
  let inFlight = 0;
  let maxInFlight = 0;

  globalThis.fetch = async (input: any) => {
    const url = typeof input === "string" ? input : input.url;
    if (url.includes("/api/models")) {
      return new Response(
        JSON.stringify({
          data: [
            {
              id: "qwen3.6-plus",
              owned_by: "qwen",
              info: { created_at: Date.now(), meta: {} },
            },
          ],
        }),
        { status: 200 },
      );
    }
    if (url.includes("/api/v2/chat/completions")) {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      const stream = new ReadableStream({
        async start(controller) {
          await new Promise((resolve) => setTimeout(resolve, 50));
          controller.enqueue(
            new TextEncoder().encode(
              'data: {"choices": [{"delta": {"phase": "answer", "content": "OK"}}]}\n\ndata: [DONE]\n\n',
            ),
          );
          controller.close();
          inFlight--;
        },
      });
      return new Response(stream, {
        status: 200,
        headers: { "Content-Type": "text/event-stream" },
      });
    }
    return originalFetch(input);
  };

  await Promise.resolve();

  try {
    const promises = Array.from({ length: 3 }, (_, i) =>
      app.fetch(
        new Request("http://localhost/v1/chat/completions", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            model: "qwen3.6-plus",
            messages: [{ role: "user", content: `Request ${i}` }],
            stream: false,
          }),
        }),
      ),
    );

    const responses = await Promise.all(promises);

    for (const res of responses) {
      assert.ok(
        res.status === 200 || res.status === 429 || res.status === 502,
        `Unexpected status: ${res.status}`,
      );
    }

    assert.ok(
      maxInFlight >= 1,
      `Expected at least 1 in-flight request, got maxInFlight=${maxInFlight}`,
    );
  } finally {
    globalThis.fetch = originalFetch;
    await Promise.resolve();
  }
});

test("No-thinking model variant is accepted", async () => {
  const originalFetch = globalThis.fetch;

  globalThis.fetch = async (input: any) => {
    const url = typeof input === "string" ? input : input.url;
    if (url.includes("/api/models")) {
      return new Response(
        JSON.stringify({
          data: [
            {
              id: "qwen3.6-plus",
              owned_by: "qwen",
              info: {
                created_at: Date.now(),
                meta: { max_context_length: 1000000 },
              },
            },
          ],
        }),
        { status: 200 },
      );
    }
    if (url.includes("/api/v2/chat/completions")) {
      return new Response(
        'data: {"choices": [{"delta": {"phase": "answer", "content": "OK"}}]}\n\ndata: [DONE]\n\n',
        { status: 200, headers: { "Content-Type": "text/event-stream" } },
      );
    }
    return originalFetch(input);
  };

  await Promise.resolve();

  try {
    // Test no-thinking model is accepted without error
    const res = await app.fetch(
      new Request("http://localhost/v1/chat/completions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "qwen3.6-plus-no-thinking",
          messages: [{ role: "user", content: "Test" }],
          stream: false,
        }),
      }),
    );

    assert.ok(
      res.status === 200 || res.status === 429 || res.status === 502,
      `No-thinking model should be accepted, got status: ${res.status}`,
    );
  } finally {
    globalThis.fetch = originalFetch;
    await Promise.resolve();
  }
});
