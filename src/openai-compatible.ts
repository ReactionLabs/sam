import type { ConversationRequest, ConversationResponse, ModelProvider } from "./model-conversation.js";
import { validateConversation } from "./model-conversation.js";
import { WORKSPACE_TOOLS } from "./workspace-tools.js";
import { MEMORY_SEARCH_TOOL, validateToolTurn, type ToolMessage, type ToolTurn } from "./memory-tool.js";

/** Opt-in OpenAI-compatible chat completions transport. No tools or automatic calls. */
export class OpenAICompatibleProvider implements ModelProvider {
  readonly id = "openai-compatible";
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
      const turn = validateToolTurn(obj?.choices?.[0]?.message, workspaceEnabled);
      if (typeof turn.content === "string") {
        if (/<think>/i.test(turn.content) && !/<\/think>/i.test(turn.content))
          throw new Error("Model returned unterminated reasoning content");
        const visible = turn.content.replace(/<think>[\s\S]*?<\/think>/gi, "").trim();
        if (!visible && !turn.tool_calls?.length) throw new Error("Model returned no safe visible content");
        if (/<\/?think>/i.test(visible)) throw new Error("Model returned unsafe reasoning content");
        if (/(?:<\|tool_call\|>|<\|invoke\b|\]\s*<\]\s*minimax|<tool_call>|<invoke\b|<\/invoke>)/i.test(visible))
          throw new Error("Model returned raw tool markup instead of a final answer");
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
      const msg=data.choices?.[0]?.message;
      if(!msg)throw Error("Invalid model response");
      const content=typeof msg.content==="string"?msg.content.replace(/<think>[\\s\\S]*?<\\/think>/gi,"").trim():null;
      if(content&&/<\\/?think>|<\\|tool_call\\|>|<tool_call>/i.test(content))throw Error("Unsafe model output");
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
