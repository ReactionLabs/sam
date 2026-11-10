import type { ConversationRequest, ConversationResponse, ModelProvider } from "./model-conversation.js";
import { validateConversation } from "./model-conversation.js";
import { WORKSPACE_TOOLS } from "./workspace-tools.js";
import { MEMORY_SEARCH_TOOL, validateToolTurn, type ToolMessage, type ToolTurn } from "./memory-tool.js";

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

/** Opt-in OpenAI-compatible chat completions transport. No tools or automatic calls. */
export class OpenAICompatibleProvider implements ModelProvider {
  readonly id = "openai-compatible";
  // Token spend accounting (P11): when set, every response that carries a
  // provider usage object is reported here. Best-effort - a failing sink
  // never breaks a model call.
  onUsage?: (usage: TokenUsage, model: string) => void;
  private reportUsage(payload: unknown, model: string): void {
    try {
      const usage = parseTokenUsage(payload);
      if (usage) this.onUsage?.(usage, model);
    } catch { /* accounting never breaks a turn */ }
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
      if (error instanceof TypeError) throw new Error("Model tool network request failed");
      throw error;
    } finally { clearTimeout(timer); }
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
    let lastError: unknown;
    for (let attempt = 0; attempt < 3; attempt++) {
      try { return await this.connectorTurnOnce(model, messages, tools); }
      catch (e) { if (e instanceof Error && (e.message === "Empty model response" || e.message === "Unsafe model output")) { lastError = e; continue; } throw e; }
    }
    throw lastError;
  }
  private async connectorTurnOnce(model:string,messages:Array<Record<string,unknown>>,tools:Array<Record<string,unknown>>):Promise<{content:string|null;calls:Array<{id:string;name:string;args:Record<string,unknown>}>}>{
    if(!model.trim()||messages.length<1||messages.length>50||tools.length>20)throw Error("Invalid connector model request");
    const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),this.timeoutMs);
    try{
      const response=await fetch(this.endpoint,{method:"POST",redirect:"error",signal:controller.signal,
        headers:{"Content-Type":"application/json",...(this.apiKey?{Authorization:"Bearer "+this.apiKey}:{})},
        body:JSON.stringify({model,messages,...(tools.length?{tools,tool_choice:"auto"}:{tool_choice:"none"}),stream:false})});
      if(!response.ok)throw Error("Model connector request failed (HTTP "+response.status+")");
      const reader=response.body?.getReader();if(!reader)throw Error("Empty model response");
      const chunks:Uint8Array[]=[];let length=0;
      try{for(;;){const {done,value}=await reader.read();if(done)break;length+=value.byteLength;if(length>1000000)throw Error("Model response too large");chunks.push(value);}}finally{reader.releaseLock();}
      const data=JSON.parse(Buffer.concat(chunks).toString("utf8")) as {choices?:Array<{message?:{content?:unknown;tool_calls?:unknown}}>};
      this.reportUsage(data, model);
      const msg=data.choices?.[0]?.message;
      if(!msg)throw Error("Invalid model response");
      const rawContent=typeof msg.content==="string"?msg.content:null;
      const content=rawContent===null?null:stripModelMarkup(rawContent);
      if(rawContent&&!content&&!(Array.isArray(msg.tool_calls)&&msg.tool_calls.length))throw Error("Unsafe model output");
      const raw=msg.tool_calls;
      if(raw!==undefined&&!Array.isArray(raw))throw Error("Invalid tool calls");
      if(Array.isArray(raw)&&raw.length>4)throw Error("Too many tool calls");
      const calls:Array<{id:string;name:string;args:Record<string,unknown>}>=[];
      for(const call of (raw??[]) as Array<{id?:unknown;type?:unknown;function?:{name?:unknown;arguments?:unknown}}>){
        if(typeof call.id!=="string"||call.id.length>128||call.type!=="function"||typeof call.function?.name!=="string"||typeof call.function.arguments!=="string"||call.function.arguments.length>4000)throw Error("Invalid tool call");
        const args:unknown=JSON.parse(call.function.arguments);
        if(!args||typeof args!=="object"||Array.isArray(args))throw Error("Invalid tool arguments");
        calls.push({id:call.id,name:call.function.name,args:args as Record<string,unknown>});
      }
      if(!content&&!calls.length)throw Error("Empty model response");
      return {content:content||null,calls};
    }catch(e){if(e instanceof Error&&e.name==="AbortError")throw Error("Model connector request timed out");if(e instanceof TypeError)throw Error("Model connector network error");throw e;}finally{clearTimeout(timer);}
  }
  async complete(request: ConversationRequest): Promise<ConversationResponse> {
    validateConversation(request);
    if (!this.apiKey.trim() && !new URL(this.endpoint).hostname.match(/^(localhost|127\.0\.0\.1|\[::1\])$/))
      throw new Error("Remote model requires an API key");
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
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
      if (error instanceof TypeError) throw new Error("Model network request failed");
      throw error;
    } finally { clearTimeout(timer); }
  }
}
