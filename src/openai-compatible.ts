import type { ConversationRequest, ConversationResponse, ModelProvider } from "./model-conversation.js";
import { validateConversation } from "./model-conversation.js";
import { isTransientHttpStatus, providerHttpStatus, TRANSIENT_RETRY_DELAYS_MS, TRANSIENT_RETRY_LIMIT } from "./provider-retry.js";
import { WORKSPACE_TOOLS } from "./workspace-tools.js";
import { MEMORY_SEARCH_TOOL, validateToolTurn, type ToolMessage, type ToolTurn } from "./memory-tool.js";

/** One tool call's arguments string, in characters. The bound is
 * the whole-response bound (1,000,000 bytes, enforced on the
 * stream below): arguments ride inside the response, so no single
 * call can legitimately outgrow it, and the artifact tool's own
 * content cap (ARTIFACT_CONTENT_MAX_BYTES, the same 1,000,000)
 * refuses an oversized deliverable downstream. The old 4,000-char
 * cap contradicted that contract outright - a tool whose whole
 * purpose is delivering a complete page or document could never
 * carry one, so a routine "make me a calculator" turn died on
 * this validator (Dip live defect, 2026-11-15: two turns in a
 * row, "Invalid tool call", no retry, no word to the owner). */
export const TOOL_CALL_ARGUMENTS_MAX_CHARS = 1_000_000;
/** Total attempts for a completion whose tool calls fail
 * validation - the same three-attempt shape as the empty/unsafe
 * budget. Nothing has executed for a malformed completion, so a
 * fresh attempt is safe; models usually self-correct. */
export const MALFORMED_COMPLETION_ATTEMPTS = 3;
/** A completion arrived but its tool calls failed validation.
 * The message stays the historical plain text; `detail` names
 * WHICH check failed and the sizes involved - never any argument
 * content - so the rejection is ledgerable and the next
 * occurrence is pinnable instead of a bare "Invalid tool call"
 * in a turn-failed line. */
export class MalformedToolCallError extends Error {
  readonly detail: string;
  constructor(message: string, detail: string) {
    super(message);
    this.name = "MalformedToolCallError";
    this.detail = detail;
  }
}

/** The sanitized cause a converted transport error may carry
 * (gap found 2026-11-16, hourly run 09:04 EST). The provider's
 * TypeError conversions below deliberately discard the original
 * error - "never echo network errors or response bodies: they
 * can contain secrets" - but discarding it whole also discarded
 * the one diagnosable fact it held, so a turn dying on a dead
 * endpoint ledgered the plain conversion and named nothing.
 * This extracts ONLY the errno-style codes from the original
 * cause chain (ENOTFOUND, ECONNREFUSED, ECONNRESET,
 * UND_ERR_SOCKET and kin): a code is not a secret, carries no
 * message, no URL, and no body. No code in the chain, no cause
 * attached, and the converted error reads exactly as before. */
export function transportCause(error: unknown): Error | undefined {
  const codes: string[] = [];
  let current: unknown = error;
  for (let depth = 0; depth < 4 && current !== null && current !== undefined; depth++) {
    const code = (current as { code?: unknown })?.code;
    if (typeof code === "string" && code && !codes.includes(code)) codes.push(code);
    current = (current as { cause?: unknown })?.cause;
  }
  return codes.length ? new Error(codes.join(", ")) : undefined;
}

function networkError(message: string, error: unknown): Error {
  const cause = transportCause(error);
  return cause ? new Error(message, { cause }) : new Error(message);
}

/** MiniMax-class models sometimes leak their tool-call machinery into
 * the visible content as markup (<tool_call> spans, <invoke> spans,
 * <|tool_call|> tokens, stray think tags, the ]<]minimax token). The
 * prose around a leak is a real answer; failing the whole turn over
 * the leak killed owner turns in the wild (2026-11-10, twice in one
 * conversation). Strip the machinery, keep the prose. Callers still
 * fail when nothing usable remains. */
export function stripModelMarkup(text: string): string {
  const out = text
    .replace(/<think>[\s\S]*?<\/think>/gi, "")
    .replace(/<tool_call>[\s\S]*?<\/tool_call>/gi, "")
    .replace(/<invoke\b[\s\S]*?<\/invoke>/gi, "")
    .replace(/<tool_call>[\s\S]*$/i, "")
    .replace(/<invoke\b[\s\S]*$/i, "")
    .replace(/<\/?think>|<\|tool_call\|>|<\/?tool_call>/gi, "")
    .replace(/\]\s*<\]\s*minimax/gi, "")
    .replace(/[ \t]+\n/g, "\n")
    .trim();
  // Debris is not prose: a residue with no letter, digit, or emoji in
  // it ("[>" - the fragment of a leak that survived its own span) is
  // machinery remains, and returning it as an answer is worse than
  // the retry an empty result gets. (Live proof, 2026-11-10: the
  // first post-fix turn answered "[>".)
  if (out && !/[\p{L}\p{N}\p{Extended_Pictographic}]/u.test(out)) return "";
  return out;
}
export interface TokenUsage { promptTokens: number; completionTokens: number; totalTokens: number }
/** Extract a provider usage object (OpenAI-shaped) from a response payload. */
export function parseTokenUsage(payload: unknown): TokenUsage | null {
  if (!payload || typeof payload !== "object") return null;
  const usage = (payload as { usage?: unknown }).usage;
  if (!usage || typeof usage !== "object") return null;
  const u = usage as Record<string, unknown>;
  const pick = (...keys: string[]): number | null => {
    for (const key of keys) {
      const value = u[key];
      if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) return value;
    }
    return null;
  };
  const promptTokens = pick("prompt_tokens", "promptTokens", "input_tokens", "inputTokens");
  const completionTokens = pick("completion_tokens", "completionTokens", "output_tokens", "outputTokens");
  if (promptTokens === null && completionTokens === null) return null;
  const totalTokens = pick("total_tokens", "totalTokens") ?? (promptTokens ?? 0) + (completionTokens ?? 0);
  return { promptTokens: promptTokens ?? 0, completionTokens: completionTokens ?? 0, totalTokens };
}

export interface AssembledSse {
  content: string;
  toolCalls: Array<{ id: string; type: "function"; function: { name: string; arguments: string } }>;
  usage: TokenUsage | null;
}

// Fold an OpenAI-compatible SSE body into one completion. Incomplete
// trailing events are ignored so a killed stream still yields the text
// that already arrived. Tool-call deltas are joined by index.
export function assembleSse(raw: string): AssembledSse {
  let content = "";
  const calls: Array<{ id: string; name: string; arguments: string }> = [];
  let usage: TokenUsage | null = null;
  for (const event of raw.split(/\n\n/)) {
    const dataLine = event.split("\n").filter(line => line.startsWith("data:")).map(line => line.slice(5).trim()).join("");
    if (!dataLine || dataLine === "[DONE]") continue;
    let json: unknown;
    try { json = JSON.parse(dataLine); } catch { continue; }
    const parsed = parseTokenUsage(json);
    if (parsed) usage = parsed;
    const choice = (json as { choices?: Array<{ delta?: Record<string, unknown>; message?: Record<string, unknown> }> })?.choices?.[0];
    const delta = choice?.delta ?? choice?.message;
    if (!delta) continue;
    if (typeof delta.content === "string") content += delta.content;
    const toolCalls = delta.tool_calls;
    if (!Array.isArray(toolCalls)) continue;
    for (const call of toolCalls) {
      if (!call || typeof call !== "object") continue;
      const row = call as { index?: unknown; id?: unknown; function?: { name?: unknown; arguments?: unknown } };
      const index = typeof row.index === "number" ? row.index : calls.length;
      if (!calls[index]) calls[index] = { id: "", name: "", arguments: "" };
      if (typeof row.id === "string") calls[index].id = row.id;
      if (typeof row.function?.name === "string") calls[index].name += row.function.name;
      if (typeof row.function?.arguments === "string") calls[index].arguments += row.function.arguments;
    }
  }
  return {
    content,
    toolCalls: calls.filter(call => call && (call.id || call.name)).map(call => ({
      id: call.id || "call",
      type: "function" as const,
      function: { name: call.name, arguments: call.arguments || "{}" },
    })),
    usage,
  };
}

function payloadFromSse(assembled: AssembledSse): unknown {
  return {
    choices: [{
      message: {
        role: "assistant",
        content: assembled.content || null,
        ...(assembled.toolCalls.length ? { tool_calls: assembled.toolCalls } : {}),
      },
    }],
    ...(assembled.usage ? { usage: { prompt_tokens: assembled.usage.promptTokens, completion_tokens: assembled.usage.completionTokens, total_tokens: assembled.usage.totalTokens } } : {}),
  };
}

/** Opt-in OpenAI-compatible chat completions transport. No tools or automatic calls. */
export class OpenAICompatibleProvider implements ModelProvider {
  readonly id = "openai-compatible";
  // Token spend accounting (P11): when set, every response that carries a
  // provider usage object is reported here. Best-effort - a failing sink
  // never breaks a model call.
  onUsage?: (usage: TokenUsage, model: string) => void;
  // Set by a chat turn that persists partial output as it arrives.
  // When set, connector completions request a stream and report the
  // visible text so far. JSON responses (tests, non-streaming hosts)
  // still parse, and report once.
  //
  // Reasoning channel separation (Dip, live, twice on 2026-11-14):
  // this callback is the ANSWER channel, and it only ever carries
  // the text of a completion that ended the turn (no tool calls),
  // reported once, at that completion's end, markup-stripped. It is
  // never called while a healthy stream is still arriving and never
  // for a tool-call completion: mid-stream, nobody can know whether
  // the text so far is the answer or the reasoning in front of a
  // tool call - and the mid-stream snapshot is exactly how raw
  // reasoning reached the owner's screen, rendered as a bubble
  // while the turn worked underneath it. The one exception is
  // stream DEATH (salvageKilledStream): what already arrived is
  // reported once, at the death, routed by the disposition known
  // at that moment, so a killed answer stays resumable instead of
  // vanishing - the turn layer's strip and reply guard still judge
  // it before it persists.
  onPartial?: (accumulated: string) => void;
  // The narration channel, the answer channel's counterpart: when a
  // completion carries tool calls AND text, that text is
  // turn-internal narration (the model's process talk in front of
  // its calls), and it is reported here instead of onPartial. The
  // turn layer ledgers its size and drops it; it must never be
  // persisted as message content or rendered on any surface.
  onNarration?: (text: string) => void;
  // Provider overload resilience (provider-retry.ts): when a
  // chat turn sets this sink, every transient retry scheduled
  // by completeConnectorTurn is reported here as it is
  // scheduled, so the turn layer can ledger the hiccup (the
  // recovery is the turn's own success line). Best-effort - a
  // failing sink never breaks a model call.
  onProviderRetry?: (info: { status: number; retry: number; limit: number; delayMs: number }) => void;
  // Malformed completions (Dip live defect, 2026-11-15): when a
  // completion's tool calls fail validation and
  // completeConnectorTurn schedules a fresh attempt, the
  // rejection is reported here - which check failed and the
  // sizes, never the content - so the turn layer can ledger the
  // class. Best-effort, like every sink on this class.
  onMalformedCompletion?: (info: { detail: string; attempt: number; limit: number }) => void;
  // Turn control (turn-control.ts): a turn that must be stoppable
  // from outside - the interactive deadline, or the owner's Reset -
  // sets this signal, and every request below links its own abort
  // controller to it, so stopping the turn aborts the in-flight
  // request immediately instead of at the next round boundary.
  // The per-request timeout still applies on top.
  abortSignal?: AbortSignal;
  private linkAbort(controller: AbortController): () => void {
    const sig = this.abortSignal;
    if (!sig) return () => {};
    if (sig.aborted) { controller.abort(); return () => {}; }
    const onAbort = () => controller.abort();
    sig.addEventListener("abort", onAbort, { once: true });
    return () => sig.removeEventListener("abort", onAbort);
  }
  private reportUsage(payload: unknown, model: string): void {
    try {
      const usage = parseTokenUsage(payload);
      if (usage) this.onUsage?.(usage, model);
    } catch { /* accounting never breaks a turn */ }
  }
  private reportProviderRetry(status: number, retry: number, delayMs: number): void {
    try { this.onProviderRetry?.({ status, retry, limit: TRANSIENT_RETRY_LIMIT, delayMs }); } catch { /* accounting never breaks a turn */ }
  }
  private reportMalformedCompletion(detail: string, attempt: number): void {
    try { this.onMalformedCompletion?.({ detail, attempt, limit: MALFORMED_COMPLETION_ATTEMPTS }); } catch { /* accounting never breaks a turn */ }
  }
  // The transient-retry backoff, riding the turn's abort
  // signal: resolves true when the wait elapsed, false when
  // the signal aborted first - a Reset or the turn deadline
  // cancels a pending retry immediately instead of letting
  // it fire into a turn that is already closing.
  private async waitForRetry(delayMs: number): Promise<boolean> {
    const sig = this.abortSignal;
    if (!sig) { await new Promise<void>(resolvePromise => setTimeout(resolvePromise, delayMs)); return true; }
    if (sig.aborted) return false;
    return new Promise<boolean>((resolvePromise) => {
      const onAbort = () => { clearTimeout(timer); resolvePromise(false); };
      const timer = setTimeout(() => { sig.removeEventListener("abort", onAbort); resolvePromise(true); }, delayMs);
      sig.addEventListener("abort", onAbort, { once: true });
    });
  }
  private readonly endpoint: string;
  constructor(endpoint: string, private readonly apiKey: string, private readonly timeoutMs = 30_000) {
    const url = new URL(endpoint);
    const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
    if ((url.protocol !== "https:" && !(loopback && url.protocol === "http:")) ||
        url.username || url.password || url.hash || url.search ||
        !url.pathname.endsWith("/chat/completions"))
      throw new Error("Model endpoint must be HTTPS (HTTP allowed on loopback), without credentials, query or fragment, ending in /chat/completions");
    if (url.hostname === "0.0.0.0") throw new Error("Wildcard model endpoint forbidden");
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 120_000)
      throw new Error("Invalid model timeout");
    this.endpoint = url.toString();
  }
  async completeToolTurn(model: string, messages: ToolMessage[], toolsEnabled: boolean, workspaceEnabled = false): Promise<ToolTurn> {
    // Same empty-completion retry as the connector path: an
    // empty or reasoning-only reply executes nothing, so one
    // fresh attempt is safe before the failure surfaces.
    try { return await this.toolTurnOnce(model, messages, toolsEnabled, workspaceEnabled); }
    catch (e) {
      if (e instanceof Error && (e.message === "Empty model tool response" || e.message === "Model returned no safe visible content"))
        return await this.toolTurnOnce(model, messages, toolsEnabled, workspaceEnabled);
      throw e;
    }
  }
  private async toolTurnOnce(model: string, messages: ToolMessage[], toolsEnabled: boolean, workspaceEnabled = false): Promise<ToolTurn> {
    if (!model.trim() || messages.length < 1 || messages.length > 100)
      throw new Error("Invalid model tool request");
    if (!this.apiKey.trim() && !new URL(this.endpoint).hostname.match(/^(localhost|127\\.0\\.0\\.1|\\[::1\\])$/))
      throw new Error("Remote model requires an API key");
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    const unlinkAbort = this.linkAbort(controller);
    try {
      const response = await fetch(this.endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...(this.apiKey ? { Authorization: "Bearer " + this.apiKey } : {}) },
        body: JSON.stringify({
          model, messages, stream: false,
          ...(toolsEnabled ? { tools: workspaceEnabled ? [MEMORY_SEARCH_TOOL,...WORKSPACE_TOOLS] : [MEMORY_SEARCH_TOOL], tool_choice: "auto" } : { tool_choice: "none" })
        }),
        signal: controller.signal,
        redirect: "error"
      });
      if (!response.ok) throw new Error("Model tool request failed (HTTP " + response.status + ")");
      const reader = response.body?.getReader();
      if (!reader) throw new Error("Empty model tool response");
      const chunks: Uint8Array[] = [];
      let size = 0;
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > 1_000_000) { await reader.cancel(); throw new Error("Model tool response too large"); }
        chunks.push(value);
      }
      const bytes = new Uint8Array(size);
      let offset = 0;
      for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
      let payload: unknown;
      try { payload = JSON.parse(new TextDecoder().decode(bytes)); }
      catch { throw new Error("Invalid model tool JSON response"); }
      const obj = payload as { choices?: Array<{ message?: unknown }> };
      this.reportUsage(payload, model);
      const turn = validateToolTurn(obj?.choices?.[0]?.message, workspaceEnabled);
      if (typeof turn.content === "string") {
        if (/<think>/i.test(turn.content) && !/<\/think>/i.test(turn.content))
          throw new Error("Model returned unterminated reasoning content");
        const visible = stripModelMarkup(turn.content);
        if (!visible && !turn.tool_calls?.length) throw new Error("Model returned no safe visible content");
        turn.content = visible || null;
      }
      return turn;
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") throw new Error("Model tool request timed out");
      if (error instanceof TypeError) throw networkError("Model tool network request failed", error);
      throw error;
    } finally { clearTimeout(timer); unlinkAbort(); }
  }
  // Stream-death salvage (the resume contract, pre-dating the
  // channel separation): when a streamed completion's transport
  // dies mid-flight - socket hang up, provider cut - the text that
  // already arrived is the turn's partial, and the next turn
  // resumes from it instead of losing the answer's first half.
  // Routing follows the same disposition rule as a completed
  // completion, judged on what the death left behind: tool calls
  // already assembled make the text narration (narration channel,
  // counted and dropped); no calls yet make it answer-so-far,
  // reported on the answer channel, where the turn layer applies
  // its markup strip and the reply guard before anything persists.
  // Only SSE bodies salvage - a JSON body cut mid-flight is
  // unparseable and contributes nothing. Best-effort throughout:
  // salvage never masks the error that killed the stream.
  private salvageKilledStream(chunks:Uint8Array[]):void{
    if(!this.onPartial&&!this.onNarration)return;
    try{
      const raw=Buffer.concat(chunks).toString("utf8");
      if(!raw.trim()||raw.trimStart().startsWith("{"))return;
      const assembled=assembleSse(raw);
      const visible=stripModelMarkup(assembled.content);
      if(!visible)return;
      if(assembled.toolCalls.length){try{this.onNarration?.(visible);}catch{/* the narration sink never breaks a turn */}}
      else{try{this.onPartial?.(visible);}catch{/* persistence never breaks the read */}}
    }catch{/* salvage never masks the real error */}
  }
  /** Bounded dashboard connector tool turn. Only host-supplied tool definitions are advertised. */
  async completeConnectorTurn(model:string,messages:Array<Record<string,unknown>>,tools:Array<Record<string,unknown>>):Promise<{content:string|null;calls:Array<{id:string;name:string;args:Record<string,unknown>}>}>{
    // An empty completion (no content, no tool calls) is a known
    // provider hiccup - most often a reasoning model spending its
    // whole reply out of sight. No tool has executed for this
    // call, so one fresh attempt is safe; a second empty is a
    // real failure and surfaces as before (owner defect
    // 2026-11-10: a bare "Empty model response" killed the turn).
    // Leaks and empties arrive in streaks (2026-11-10: one retry was
    // not enough and the raw error reached the owner), so the fresh
    // attempt budget is three total. Nothing has executed for any of
    // these calls, so every retry is safe.
    // Malformed completions (Dip live defect, 2026-11-15: two
    // turns died on "Invalid tool call" with no retry and no word
    // to the owner) ride the fresh-attempt class too, on their
    // own counter: nothing executed, the model redraws.
    // Transient provider failures (provider-retry.ts, Dip live
    // defect 2026-11-15: a MiniMax 529 ate the owner's turn on the
    // spot) ride a SEPARATE bounded budget: an HTTP 429 or 5xx is
    // the provider blinking, so the same call retries in place on
    // the backoff schedule - 3.5s of added wait at most, far inside
    // the interactive deadline. A non-transient status surfaces
    // immediately, exactly as before. The backoff rides the turn's
    // abort signal: when it fires mid-wait (Reset, deadline), the
    // original error surfaces instead, so the turn layer's control
    // checks close the turn as they always have.
    let lastError: unknown;
    let emptyAttempts = 0;
    let transientRetries = 0;
    let malformedAttempts = 0;
    for (;;) {
      try { return await this.connectorTurnOnce(model, messages, tools); }
      catch (e) {
        if (e instanceof Error && (e.message === "Empty model response" || e.message === "Unsafe model output")) {
          lastError = e;
          emptyAttempts++;
          if (emptyAttempts < 3) continue;
          throw lastError;
        }
        // A malformed completion (Dip live defect, 2026-11-15):
        // the provider answered, but its tool calls failed
        // validation - a call shaped wrong, arguments that are
        // not a JSON object. Nothing has executed for it, so it
        // belongs to the same fresh-attempt class as an empty:
        // the model usually self-corrects on a second draw. The
        // rejection is reported through onMalformedCompletion
        // with its check and sizes, so the class is countable
        // even when the retry saves the turn.
        if (e instanceof MalformedToolCallError) {
          lastError = e;
          malformedAttempts++;
          this.reportMalformedCompletion(e.detail, malformedAttempts);
          if (malformedAttempts < MALFORMED_COMPLETION_ATTEMPTS) continue;
          throw lastError;
        }
        const status = providerHttpStatus(e);
        if (status !== null && isTransientHttpStatus(status) && transientRetries < TRANSIENT_RETRY_LIMIT) {
          transientRetries++;
          const delayMs = TRANSIENT_RETRY_DELAYS_MS[Math.min(transientRetries - 1, TRANSIENT_RETRY_DELAYS_MS.length - 1)];
          this.reportProviderRetry(status, transientRetries, delayMs);
          if (!await this.waitForRetry(delayMs)) throw e;
          continue;
        }
        throw e;
      }
    }
  }
  private async connectorTurnOnce(model:string,messages:Array<Record<string,unknown>>,tools:Array<Record<string,unknown>>):Promise<{content:string|null;calls:Array<{id:string;name:string;args:Record<string,unknown>}>}>{
    if(!model.trim()||messages.length<1||messages.length>50||tools.length>20)throw Error("Invalid connector model request");
    const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),this.timeoutMs);
    const unlinkAbort=this.linkAbort(controller);
    try{
      const stream=!!this.onPartial;
      // Streamed turns must ASK for usage: providers only emit a usage
      // event in SSE when include_usage is set. Without it every chat
      // turn (all of them stream since partial persistence landed)
      // metered nothing and the spend surfaces read zero (smoke F2,
      // 2026-11-10).
      const response=await fetch(this.endpoint,{method:"POST",redirect:"error",signal:controller.signal,
        headers:{"Content-Type":"application/json",...(this.apiKey?{Authorization:"Bearer "+this.apiKey}:{})},
        body:JSON.stringify({model,messages,...(tools.length?{tools,tool_choice:"auto"}:{tool_choice:"none"}),stream,...(stream?{stream_options:{include_usage:true}}:{})})});
      if(!response.ok)throw Error("Model connector request failed (HTTP "+response.status+")");
      const reader=response.body?.getReader();if(!reader)throw Error("Empty model response");
      const chunks:Uint8Array[]=[];let length=0;
      // No reporting while a healthy stream is still arriving (see
      // onPartial): the stream is buffered whole, and channel
      // routing happens once the completion's disposition - answer
      // or narration - is known at its end. A read that FAILS is
      // the stream's death, not its middle: the remains are
      // salvaged once (salvageKilledStream) and the error rethrows
      // exactly as before. A deliberate stop salvages nothing -
      // when the turn control's signal has aborted (the owner's
      // Reset, the turn deadline), that turn has its own closing
      // behavior and a salvaged partial would fight it.
      try{for(;;){
        const step=await reader.read().catch((readError:unknown)=>{if(!this.abortSignal?.aborted)this.salvageKilledStream(chunks);throw readError;});
        if(step.done)break;length+=step.value.byteLength;if(length>1000000)throw Error("Model response too large");chunks.push(step.value);
      }}finally{reader.releaseLock();}
      const rawText=Buffer.concat(chunks).toString("utf8");
      const data=(stream&&!rawText.trimStart().startsWith("{")?payloadFromSse(assembleSse(rawText)):JSON.parse(rawText)) as {choices?:Array<{message?:{content?:unknown;tool_calls?:unknown}}>};
      this.reportUsage(data, model);
      const msg=data.choices?.[0]?.message;
      if(!msg)throw Error("Invalid model response");
      const rawContent=typeof msg.content==="string"?msg.content:null;
      // An unterminated think span means the completion is all
      // reasoning with its closing tag missing: stripModelMarkup
      // would keep the prose and call it content. The tool-turn
      // path already refuses this shape; the connector path now
      // refuses it too, into the retry class above - a
      // reasoning-only completion is a provider hiccup to retry,
      // never text to show the owner.
      if(rawContent&&/<think>/i.test(rawContent)&&!/<\/think>/i.test(rawContent))throw Error("Unsafe model output");
      const content=rawContent===null?null:stripModelMarkup(rawContent);
      if(rawContent&&!content&&!(Array.isArray(msg.tool_calls)&&msg.tool_calls.length))throw Error("Unsafe model output");
      const raw=msg.tool_calls;
      if(raw!==undefined&&!Array.isArray(raw))throw new MalformedToolCallError("Invalid tool calls","tool_calls was not an array");
      // The cap is a sanity bound, not a workflow limit: SAM's own
      // guidance tells the model to batch independent calls in one
      // step, and a batch ask ("archive the other chats") legitimately
      // emits more than four. The old cap of 4 killed exactly that
      // turn with a raw error (owner defect 2026-11-10). The loops'
      // call budgets stub whatever overflows, gracefully.
      if(Array.isArray(raw)&&raw.length>12)throw new MalformedToolCallError("Too many tool calls",raw.length+" tool calls in one completion, over the cap of 12");
      const calls:Array<{id:string;name:string;args:Record<string,unknown>}>=[];
      for(const call of (raw??[]) as Array<{id?:unknown;type?:unknown;function?:{name?:unknown;arguments?:unknown}}>){
        // Every rejection names its check and the sizes involved
        // (never the content) on the error's detail, so the class
        // is ledgerable instead of a bare "Invalid tool call".
        if(typeof call.id!=="string")throw new MalformedToolCallError("Invalid tool call","a tool call id was not a string");
        if(call.id.length>128)throw new MalformedToolCallError("Invalid tool call","a tool call id ran "+call.id.length+" chars, over the cap of 128");
        if(call.type!=="function")throw new MalformedToolCallError("Invalid tool call","a tool call type was not \"function\"");
        if(typeof call.function?.name!=="string")throw new MalformedToolCallError("Invalid tool call","a tool call carried no function name");
        if(typeof call.function.arguments!=="string")throw new MalformedToolCallError("Invalid tool call","tool call "+call.function.name+" arguments were not a string");
        if(call.function.arguments.length>TOOL_CALL_ARGUMENTS_MAX_CHARS)throw new MalformedToolCallError("Invalid tool call","tool call "+call.function.name+" arguments ran "+call.function.arguments.length+" chars, over the cap of "+TOOL_CALL_ARGUMENTS_MAX_CHARS);
        let args:unknown;
        try{args=JSON.parse(call.function.arguments);}catch{throw new MalformedToolCallError("Invalid tool arguments","tool call "+call.function.name+" arguments were not valid JSON");}
        if(!args||typeof args!=="object"||Array.isArray(args))throw new MalformedToolCallError("Invalid tool arguments","tool call "+call.function.name+" arguments were not a JSON object");
        calls.push({id:call.id,name:call.function.name,args:args as Record<string,unknown>});
      }
      if(!content&&!calls.length)throw Error("Empty model response");
      // Channel routing, the structural rule: a completion that
      // carries tool calls is a working round, and any text riding
      // it is turn-internal narration - it goes to the narration
      // channel (ledgered by size upstream, then dropped) and can
      // never reach the partial/message path. Only a completion
      // that ends the turn (no calls) produces reply text, and
      // only its text is reported on the answer channel, once,
      // here at the completion's end.
      if(calls.length&&content){try{this.onNarration?.(content);}catch{/* the narration sink never breaks a turn */}}
      else if(content){try{this.onPartial?.(content);}catch{/* persistence never breaks the read */}}
      return {content:content||null,calls};
    }catch(e){if(e instanceof Error&&e.name==="AbortError")throw Error("Model connector request timed out");if(e instanceof TypeError)throw networkError("Model connector network error", e);throw e;}finally{clearTimeout(timer);unlinkAbort();}
  }
  async complete(request: ConversationRequest): Promise<ConversationResponse> {
    validateConversation(request);
    if (!this.apiKey.trim() && !new URL(this.endpoint).hostname.match(/^(localhost|127\.0\.0\.1|\[::1\])$/))
      throw new Error("Remote model requires an API key");
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    const unlinkAbort = this.linkAbort(controller);
    try {
      const response = await fetch(this.endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...(this.apiKey ? { Authorization: "Bearer " + this.apiKey } : {}) },
        body: JSON.stringify({ model: request.model, messages: request.messages, stream: false }),
        signal: controller.signal,
        redirect: "error"
      });
      if (!response.ok) throw new Error("Model request failed (HTTP " + response.status + ")");
      const length = Number(response.headers.get("content-length") ?? 0);
      if (length > 1_000_000) throw new Error("Model response too large");
      const reader = response.body?.getReader();
      if (!reader) throw new Error("Empty model response");
      const chunks: Uint8Array[] = [];
      let size = 0;
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > 1_000_000) { await reader.cancel(); throw new Error("Model response too large"); }
        chunks.push(value);
      }
      const bytes = new Uint8Array(size);
      let offset = 0;
      for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
      let payload: unknown;
      try { payload = JSON.parse(new TextDecoder().decode(bytes)); }
      catch { throw new Error("Invalid model JSON response"); }
      const obj = payload as { choices?: Array<{ message?: { role?: string; content?: unknown } }> };
      this.reportUsage(payload, request.model);
      const content = obj?.choices?.[0]?.message?.content;
      if (typeof content !== "string" || !content.trim()) throw new Error("Invalid model response content");
      // Some compatible providers embed private reasoning in text instead of a separate field.
      // Never display it or retain it in the next conversation turn.
      if (/<think>/i.test(content) && !/<\/think>/i.test(content))
        throw new Error("Model returned unterminated reasoning content");
      const visible = content.replace(/<think>[\s\S]*?<\/think>/gi, "").trim();
      if (!visible || /<\/?think>/i.test(visible))
        throw new Error("Model returned no safe visible content");
      return { provider: this.id, model: request.model, message: { role: "assistant", content: visible } };
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") throw new Error("Model request timed out");
      // Never echo network errors or response bodies: they can contain secrets.
      // The converted error carries only the sanitized code-only
      // cause (transportCause above), never the original message.
      if (error instanceof TypeError) throw networkError("Model network request failed", error);
      throw error;
    } finally { clearTimeout(timer); unlinkAbort(); }
  }
}
