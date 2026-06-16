"use strict";

const { Readable } = require("stream");
const OllamaLlmAdapter = require("../../src/infrastructure/llm/OllamaLlmAdapter");

/*------------------------------------------------------------------------------
            _________________________________________________________
            |        OLLAMALLMADAPTER.STREAM — UNIT TESTS           |
            |  Verifies chatCompletionStreamWithCallback: per-token  |
            |  onChunk callbacks, partial-line buffering across TCP  |
            |  segments, callback-less use, error propagation,       |
            |  callback-throw resilience and malformed-JSON skipping.|
        ____|_______________                                        |
        | ndjsonStream() | -> Readable                              |
        ------------------                                          |
            |_______________________________________________________|
------------------------------------------------------------------------------*/

/*
     IN -> ____|_____________
          | ndjsonStream() | -> Readable
           ------------------
    Builds a Readable that emits the given NDJSON lines as buffers.
*/
function ndjsonStream(lines) {
  return Readable.from(lines.map((l) => Buffer.from(l + "\n", "utf8")));
}

describe("OllamaLlmAdapter.chatCompletionStreamWithCallback", () => {
  test("invokes onChunk per token and returns concatenated text", async () => {
    const adapter = new OllamaLlmAdapter({ baseUrl: "http://test.local", model: "qwen2.5" });
    const tokens = ["Hola", " ", "mundo", "."];
    const stream = ndjsonStream(
      tokens.map((t) => JSON.stringify({ message: { role: "assistant", content: t }, done: false }))
        .concat([JSON.stringify({ message: { role: "assistant", content: "" }, done: true })])
    );
    adapter.chatCompletionStream = async () => stream;

    const received = [];
    const full = await adapter.chatCompletionStreamWithCallback(
      [{ role: "user", content: "saluda" }],
      {},
      (token) => received.push(token)
    );

    expect(received).toEqual(tokens);
    expect(full).toBe("Hola mundo.");
  });

  test("handles chunks split across TCP segments (partial line buffering)", async () => {
    const adapter = new OllamaLlmAdapter({ baseUrl: "http://test.local", model: "qwen2.5" });
    const lineA = JSON.stringify({ message: { content: "AAA" }, done: false }) + "\n";
    const lineB = JSON.stringify({ message: { content: "BBB" }, done: false }) + "\n";
    const lineDone = JSON.stringify({ message: { content: "" }, done: true }) + "\n";
    const stream = Readable.from([
      Buffer.from(lineA.slice(0, 10), "utf8"),
      Buffer.from(lineA.slice(10) + lineB + lineDone, "utf8"),
    ]);
    adapter.chatCompletionStream = async () => stream;

    const received = [];
    const full = await adapter.chatCompletionStreamWithCallback([], {}, (t) => received.push(t));
    expect(received).toEqual(["AAA", "BBB"]);
    expect(full).toBe("AAABBB");
  });

  test("works without an onChunk callback (returns full text only)", async () => {
    const adapter = new OllamaLlmAdapter({ baseUrl: "http://test.local", model: "qwen2.5" });
    adapter.chatCompletionStream = async () =>
      ndjsonStream([
        JSON.stringify({ message: { content: "uno" }, done: false }),
        JSON.stringify({ message: { content: " dos" }, done: false }),
        JSON.stringify({ done: true }),
      ]);
    const full = await adapter.chatCompletionStreamWithCallback([], {});
    expect(full).toBe("uno dos");
  });

  test("propagates stream errors so the orchestrator can fall back", async () => {
    const adapter = new OllamaLlmAdapter({ baseUrl: "http://test.local", model: "qwen2.5" });
    const stream = new Readable({ read() {} });
    adapter.chatCompletionStream = async () => stream;
    const promise = adapter.chatCompletionStreamWithCallback([], {}, () => {});
    process.nextTick(() => stream.emit("error", new Error("network down")));
    await expect(promise).rejects.toThrow("network down");
  });

  test("a callback that throws does not crash the stream", async () => {
    const adapter = new OllamaLlmAdapter({ baseUrl: "http://test.local", model: "qwen2.5" });
    adapter.chatCompletionStream = async () =>
      ndjsonStream([
        JSON.stringify({ message: { content: "x" }, done: false }),
        JSON.stringify({ message: { content: "y" }, done: false }),
        JSON.stringify({ done: true }),
      ]);
    const full = await adapter.chatCompletionStreamWithCallback(
      [],
      {},
      () => {
        throw new Error("SSE write failed");
      }
    );
    expect(full).toBe("xy");
  });

  test("ignores malformed JSON lines instead of breaking the stream", async () => {
    const adapter = new OllamaLlmAdapter({ baseUrl: "http://test.local", model: "qwen2.5" });
    adapter.chatCompletionStream = async () =>
      ndjsonStream([
        "this is not json",
        JSON.stringify({ message: { content: "OK" }, done: false }),
        JSON.stringify({ done: true }),
      ]);
    const received = [];
    const full = await adapter.chatCompletionStreamWithCallback(
      [],
      {},
      (t) => received.push(t)
    );
    expect(received).toEqual(["OK"]);
    expect(full).toBe("OK");
  });
});
