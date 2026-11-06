/** Environment-only configuration parsing. This module never logs or persists secrets. */
export interface SamConfig {
  modelProvider:"minimax"|"none";
  model:string|null;
  minimaxApiKey:string|null;
  minimaxBaseUrl:string;
  secondShiftMcpUrl:string|null;
  secondShiftMcpToken:string|null;
  logLevel:"debug"|"info"|"warn"|"error";
}
function optional(value:string|undefined):string|null {
  const trimmed=value?.trim();
  return trimmed||null;
}
function secureUrl(value:string,field:string,allowLoopback=false):string {
  let url:URL;
  try {url=new URL(value);} catch {throw new Error(`Invalid ${field} URL`);}
  const loopback=allowLoopback&&url.protocol==="http:"&&
    (url.hostname==="localhost"||url.hostname==="127.0.0.1"||url.hostname==="[::1]");
  if((url.protocol!=="https:"&&!loopback)||url.username||url.password||url.hash)
    throw new Error(`Invalid ${field} URL: HTTPS required and credentials/fragments forbidden`);
  return url.toString();
}
/** Parse without side effects. Missing credentials are permitted for CLI-only operation. */
export function parseSamConfig(env:NodeJS.ProcessEnv):SamConfig {
  const provider=optional(env.SAM_MODEL_PROVIDER)??"none";
  if(provider!=="none"&&provider!=="minimax")throw new Error("Unsupported SAM_MODEL_PROVIDER");
  const level=optional(env.SAM_LOG_LEVEL)??"info";
  if(!["debug","info","warn","error"].includes(level))throw new Error("Invalid SAM_LOG_LEVEL");
  const endpoint=optional(env.SECOND_SHIFT_MCP_URL);
  const base=optional(env.MINIMAX_BASE_URL)??"https://api.minimax.io/v1";
  return {
    modelProvider:provider,
    model:optional(env.SAM_MODEL),
    minimaxApiKey:optional(env.MINIMAX_API_KEY),
    minimaxBaseUrl:secureUrl(base,"MINIMAX_BASE_URL"),
    secondShiftMcpUrl:endpoint?secureUrl(endpoint,"SECOND_SHIFT_MCP_URL",true):null,
    secondShiftMcpToken:optional(env.SECOND_SHIFT_MCP_TOKEN),
    logLevel:level as SamConfig["logLevel"]
  };
}
/** Readiness only. Never echo key values or endpoint tokens in diagnostics. */
export function configReadiness(config:SamConfig):{modelReady:boolean;mcpReady:boolean} {
  return {
    modelReady:config.modelProvider==="minimax"&&!!config.model&&!!config.minimaxApiKey,
    mcpReady:!!config.secondShiftMcpUrl&&!!config.secondShiftMcpToken
  };
}
