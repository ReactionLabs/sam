import test from "node:test";
import assert from "node:assert/strict";
import {parseSamConfig,configReadiness} from "./config.js";

test("CLI-only mode needs no API key",()=>{
 const config=parseSamConfig({});
 assert.equal(config.modelProvider,"none");
 assert.deepEqual(configReadiness(config),{modelReady:false,mcpReady:false});
});
test("model and MCP readiness require explicit local credentials",()=>{
 const config=parseSamConfig({
  SAM_MODEL_PROVIDER:"minimax",SAM_MODEL:"MiniMax-M2",MINIMAX_API_KEY:"secret",
  SECOND_SHIFT_MCP_URL:"https://mcp.secondshift.site",SECOND_SHIFT_MCP_TOKEN:"token"
 });
 assert.deepEqual(configReadiness(config),{modelReady:true,mcpReady:true});
 assert.equal(config.secondShiftMcpUrl,"https://mcp.secondshift.site/");
});
test("tier models parse from SAM_MODEL_CHEAP / SAM_MODEL_DEEP (P11)",()=>{
 const config=parseSamConfig({SAM_MODEL:"main-1",SAM_MODEL_CHEAP:"cheap-1",SAM_MODEL_DEEP:"deep-1"});
 assert.equal(config.model,"main-1");
 assert.equal(config.cheapModel,"cheap-1");
 assert.equal(config.deepModel,"deep-1");
 assert.equal(parseSamConfig({}).cheapModel,null);
 assert.equal(parseSamConfig({}).deepModel,null);
});
test("rejects insecure remote endpoints, URL credentials, and unsupported providers",()=>{
 for(const url of ["http://example.com/mcp","https://user:pass@example.com","file:///tmp/mcp",
  "https://example.com/#secret"]) {
  assert.throws(()=>parseSamConfig({SECOND_SHIFT_MCP_URL:url}),/Invalid SECOND_SHIFT_MCP_URL/);
 }
 assert.equal(parseSamConfig({SECOND_SHIFT_MCP_URL:"http://localhost:3000/mcp"}).secondShiftMcpUrl,
  "http://localhost:3000/mcp");
 assert.throws(()=>parseSamConfig({SAM_MODEL_PROVIDER:"unknown"}),/Unsupported/);
 assert.throws(()=>parseSamConfig({SAM_LOG_LEVEL:"trace"}),/Invalid SAM_LOG_LEVEL/);
 assert.throws(()=>parseSamConfig({MINIMAX_BASE_URL:"http://example.com"}),/Invalid MINIMAX_BASE_URL/);
});
