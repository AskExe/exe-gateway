/**
 * LLM Proxy — transparent Anthropic API proxy with auth, metering, and margin.
 *
 * Speaks the Anthropic Messages protocol. Clients (exe-wiki) configure:
 *   ANTHROPIC_BASE_URL=https://api.askexe.com
 *   ANTHROPIC_API_KEY=exe_sk_<customer_key>
 *
 * The proxy:
 *   1. Authenticates the customer key
 *   2. Forwards the raw request to Anthropic (preserving all params)
 *   3. Streams or returns the response transparently
 *   4. Meters token usage for billing (fire-and-forget)
 *
 * Zero code changes required in exe-wiki — the Anthropic SDK works unmodified.
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import { validateApiKey, type CustomerInfo } from "./api-keys.js";
import { logUsage } from "./metering.js";

const ANTHROPIC_API_URL = "https://api.anthropic.com";
const PROXY_BODY_LIMIT = 4 * 1_048_576; // 4 MB (prompts can include base64 images)

export interface LLMProxyConfig {
  /** Our master Anthropic API key (we pay Anthropic, customer pays us) */
  anthropicApiKey: string;
  /** Margin percentage applied to cost (e.g., 20 = 20%) */
  marginPercent: number;
}

/**
 * Handle an LLM proxy request.
 * Called by WebhookServer for POST /v1/messages.
 */
export async function handleProxyRequest(
  req: IncomingMessage,
  res: ServerResponse,
  config: LLMProxyConfig,
): Promise<void> {
  // 1. Extract API key
  const apiKey = extractApiKey(req);
  if (!apiKey) {
    sendProxyError(
      res,
      401,
      "authentication_error",
      "Missing or invalid API key. Use x-api-key header with your exe_sk_* key.",
    );
    return;
  }

  // 2. Validate customer
  let customer: CustomerInfo;
  try {
    const result = await validateApiKey(apiKey);
    if (!result) {
      sendProxyError(res, 401, "authentication_error", "Invalid or revoked API key.");
      return;
    }
    customer = result;
  } catch {
    sendProxyError(res, 500, "api_error", "Authentication service unavailable.");
    return;
  }

  // 3. Read request body
  let rawBody: string;
  try {
    rawBody = await readRawBody(req, PROXY_BODY_LIMIT);
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Bad request";
    sendProxyError(res, 400, "invalid_request_error", msg);
    return;
  }

  let body: Record<string, unknown>;
  try {
    body = JSON.parse(rawBody);
  } catch {
    sendProxyError(res, 400, "invalid_request_error", "Invalid JSON in request body.");
    return;
  }

  const isStreaming = body.stream === true;
  const model = (body.model as string) ?? "unknown";
  const start = Date.now();

  // 4. Forward to Anthropic — same body, swap API key
  const anthropicVersion =
    (req.headers["anthropic-version"] as string) ?? "2023-06-01";

  let upstream: Response;
  try {
    upstream = await fetch(`${ANTHROPIC_API_URL}/v1/messages`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": config.anthropicApiKey,
        "anthropic-version": anthropicVersion,
      },
      body: rawBody,
    });
  } catch {
    sendProxyError(res, 502, "api_error", "Failed to reach upstream LLM provider.");
    return;
  }

  // 5. Handle upstream error (non-2xx, non-streaming)
  if (!upstream.ok && !isStreaming) {
    const errorBody = await upstream.text();
    res.writeHead(upstream.status, {
      "Content-Type": "application/json",
      "Connection": "close",
    });
    res.end(errorBody);
    return;
  }

  if (isStreaming) {
    await handleStreamingResponse(res, upstream, customer, model, start, config);
  } else {
    await handleNonStreamingResponse(res, upstream, customer, model, start, config);
  }
}

/** Pipe SSE stream through to client, intercept usage events for metering */
async function handleStreamingResponse(
  res: ServerResponse,
  upstream: Response,
  customer: CustomerInfo,
  model: string,
  start: number,
  config: LLMProxyConfig,
): Promise<void> {
  // Forward status + SSE headers
  const headers: Record<string, string> = {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    "Connection": "keep-alive",
  };

  // Forward request-id if present
  const requestId = upstream.headers.get("request-id");
  if (requestId) headers["request-id"] = requestId;

  res.writeHead(upstream.status, headers);

  if (!upstream.body) {
    res.end();
    return;
  }

  let inputTokens = 0;
  let outputTokens = 0;

  const reader = upstream.body.getReader();
  const decoder = new TextDecoder();

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      const chunk = decoder.decode(value, { stream: true });

      // Write to client immediately — zero buffering for low latency
      res.write(chunk);

      // Parse SSE events to extract usage (best-effort, never blocks stream)
      for (const line of chunk.split("\n")) {
        if (!line.startsWith("data: ")) continue;
        const jsonStr = line.slice(6).trim();
        if (jsonStr === "[DONE]") continue;
        try {
          const event = JSON.parse(jsonStr);
          if (event.type === "message_start" && event.message?.usage) {
            inputTokens = event.message.usage.input_tokens ?? 0;
          }
          if (event.type === "message_delta" && event.usage) {
            outputTokens = event.usage.output_tokens ?? 0;
          }
        } catch {
          // Not every data: line is valid JSON — skip
        }
      }
    }
  } catch {
    // Client disconnect or upstream error — log what we have
  } finally {
    res.end();
  }

  // Log usage after stream completes (fire-and-forget)
  const latencyMs = Date.now() - start;
  if (inputTokens > 0 || outputTokens > 0) {
    logUsage({
      customerId: customer.id,
      model,
      inputTokens,
      outputTokens,
      provider: "anthropic",
      latencyMs,
      marginPercent: config.marginPercent,
    }).catch((err) => {
      console.error(
        "[llm-proxy] Failed to log streaming usage:",
        err instanceof Error ? err.message : err,
      );
    });
  }
}

/** Read full response, forward to client, log usage */
async function handleNonStreamingResponse(
  res: ServerResponse,
  upstream: Response,
  customer: CustomerInfo,
  model: string,
  start: number,
  config: LLMProxyConfig,
): Promise<void> {
  const responseBody = await upstream.text();
  const latencyMs = Date.now() - start;

  // Forward response headers
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "Connection": "close",
  };
  const requestId = upstream.headers.get("request-id");
  if (requestId) headers["request-id"] = requestId;

  res.writeHead(upstream.status, headers);
  res.end(responseBody);

  // Log usage from response (fire-and-forget)
  try {
    const parsed = JSON.parse(responseBody);
    if (parsed.usage) {
      logUsage({
        customerId: customer.id,
        model: parsed.model ?? model,
        inputTokens: parsed.usage.input_tokens ?? 0,
        outputTokens: parsed.usage.output_tokens ?? 0,
        provider: "anthropic",
        latencyMs,
        marginPercent: config.marginPercent,
      }).catch((err) => {
        console.error(
          "[llm-proxy] Failed to log usage:",
          err instanceof Error ? err.message : err,
        );
      });
    }
  } catch {
    // Response wasn't parseable — unusual but don't crash
  }
}

// ---- Helpers ----

/** Extract API key from x-api-key header or Authorization: Bearer */
function extractApiKey(req: IncomingMessage): string | null {
  // Anthropic SDK sends x-api-key header
  const xApiKey = req.headers["x-api-key"] as string | undefined;
  if (xApiKey?.startsWith("exe_sk_")) return xApiKey;

  // Some clients might use Authorization: Bearer
  const auth = req.headers.authorization;
  if (auth?.startsWith("Bearer exe_sk_")) return auth.slice(7);

  return null;
}

/** Read raw body as string with size limit */
function readRawBody(req: IncomingMessage, limit: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let done = false;

    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > limit) {
        if (!done) {
          done = true;
          req.resume();
          reject(
            new Error(
              `Request body exceeds ${Math.round(limit / 1_048_576)}MB limit.`,
            ),
          );
        }
        return;
      }
      chunks.push(chunk);
    });

    req.on("end", () => {
      if (done) return;
      done = true;
      resolve(Buffer.concat(chunks).toString("utf-8"));
    });

    req.on("error", (err) => {
      if (!done) {
        done = true;
        reject(err);
      }
    });
  });
}

/** Send an Anthropic-formatted error response */
function sendProxyError(
  res: ServerResponse,
  status: number,
  type: string,
  message: string,
): void {
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Connection": "close",
  });
  res.end(
    JSON.stringify({
      type: "error",
      error: { type, message },
    }),
  );
}
