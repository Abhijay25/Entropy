// Daytona MCP over stdio (`daytona mcp start`). Tool names and argument shapes are
// discovered with listTools and recorded; nothing here hardcodes an unverified schema.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { Client, type Tool } from '@modelcontextprotocol/client';
import { getDefaultEnvironment, StdioClientTransport } from '@modelcontextprotocol/client/stdio';

import { config } from '../config.js';
import { ENTROPY_DIR } from './payloadManifest.js';

export const MCP_TOOLS_FILE = path.join(ENTROPY_DIR, 'mcp-tools.json');
const CALL_TIMEOUT_MS = 45_000;
const RESULT_LIMIT = 4096;

export interface ToolBinding {
  tool: string;
  sandboxArg: string;
  valueArg: string;
}

export interface McpToolMapping {
  discoveredAt: string;
  toolNames: string[];
  readFile: ToolBinding;
  execute?: ToolBinding;
  schemas: Record<string, unknown>;
}

export interface McpCallResult {
  toolName: string;
  ok: boolean;
  text: string;
}

function properties(tool: Tool): string[] {
  const schema = tool.inputSchema as { properties?: Record<string, unknown> } | undefined;
  return Object.keys(schema?.properties ?? {});
}

function pick(names: string[], patterns: RegExp[]): string | undefined {
  for (const pattern of patterns) {
    const found = names.find((name) => pattern.test(name));
    if (found) return found;
  }
  return undefined;
}

function bind(tools: Tool[], namePatterns: RegExp[], valuePatterns: RegExp[]): ToolBinding | undefined {
  for (const pattern of namePatterns) {
    for (const tool of tools.filter((candidate) => pattern.test(candidate.name))) {
      const props = properties(tool);
      const sandboxArg = pick(props, [/^sandbox_?id$/i, /^id$/i, /sandbox/i]);
      const valueArg = pick(props.filter((prop) => prop !== sandboxArg), valuePatterns);
      if (sandboxArg && valueArg) return { tool: tool.name, sandboxArg, valueArg };
    }
  }
  return undefined;
}

/** Maps discovered tools to the two fixed diagnostic capabilities. Throws when no read tool exists. */
export function deriveMapping(tools: Tool[]): McpToolMapping {
  const readFile = bind(tools, [/^download_?file$/i, /read_?file/i, /file.*(download|read|content)/i, /(download|read).*file/i], [/^file_?path$/i, /^path$/i, /path/i, /file/i]);
  if (!readFile) throw new Error(`No Daytona MCP file-read tool found among: ${tools.map((tool) => tool.name).join(', ') || 'none'}`);
  const execute = bind(tools, [/^execute_?command$/i, /exec/i, /command/i, /process/i], [/^command$/i, /cmd/i, /command/i]);
  return {
    discoveredAt: new Date().toISOString(),
    toolNames: tools.map((tool) => tool.name),
    readFile,
    ...(execute ? { execute } : {}),
    schemas: Object.fromEntries(tools.map((tool) => [tool.name, tool.inputSchema]))
  };
}

export function saveMapping(mapping: McpToolMapping): void {
  mkdirSync(path.dirname(MCP_TOOLS_FILE), { recursive: true });
  writeFileSync(MCP_TOOLS_FILE, `${JSON.stringify(mapping, null, 2)}\n`);
}

export function loadMapping(): McpToolMapping | undefined {
  if (!existsSync(MCP_TOOLS_FILE)) return undefined;
  return JSON.parse(readFileSync(MCP_TOOLS_FILE, 'utf8')) as McpToolMapping;
}

/** The child gets only the default safe environment plus CLI-relevant variables; never Nosana/Neo4j keys. */
function childEnvironment(): Record<string, string> {
  const env = getDefaultEnvironment();
  for (const key of ['XDG_CONFIG_HOME', 'DAYTONA_API_URL']) {
    const value = process.env[key];
    if (value) env[key] = value;
  }
  return env;
}

function textOf(result: { content?: unknown; structuredContent?: unknown }): string {
  const parts = Array.isArray(result.content)
    ? result.content.map((block: { type?: string; text?: string }) => (block.type === 'text' && typeof block.text === 'string' ? block.text : `[${block.type ?? 'content'}]`))
    : [];
  if (!parts.length && result.structuredContent !== undefined) parts.push(JSON.stringify(result.structuredContent));
  return parts.join('\n').slice(0, RESULT_LIMIT);
}

export class DaytonaMcpClient {
  private constructor(private readonly client: Client, private readonly transport: StdioClientTransport, readonly stderrTail: () => string) {}

  static async connect(): Promise<DaytonaMcpClient> {
    const transport = new StdioClientTransport({ command: config.daytonaCli.path, args: ['mcp', 'start'], env: childEnvironment(), stderr: 'pipe' });
    let stderr = '';
    transport.stderr?.on('data', (chunk: Buffer) => { stderr = `${stderr}${chunk.toString('utf8')}`.slice(-2048); });
    const client = new Client({ name: 'entropy-diagnostic', version: '0.1.0' });
    await client.connect(transport);
    return new DaytonaMcpClient(client, transport, () => stderr);
  }

  async listAllTools(): Promise<Tool[]> {
    const tools: Tool[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 20; page += 1) {
      const result = await this.client.listTools(cursor ? { cursor } : undefined);
      tools.push(...result.tools);
      cursor = result.nextCursor;
      if (!cursor) break;
    }
    return tools;
  }

  /** Calls one bound tool with a fixed backend-chosen value. Transport errors and isError both surface as ok=false. */
  async call(binding: ToolBinding, sandboxId: string, value: string): Promise<McpCallResult> {
    try {
      const result = await this.client.callTool({ name: binding.tool, arguments: { [binding.sandboxArg]: sandboxId, [binding.valueArg]: value } }, { timeout: CALL_TIMEOUT_MS });
      return { toolName: binding.tool, ok: !result.isError, text: textOf(result) || '(empty result)' };
    } catch (error) {
      return { toolName: binding.tool, ok: false, text: `MCP call failed: ${error instanceof Error ? error.message : String(error)}`.slice(0, RESULT_LIMIT) };
    }
  }

  async close(): Promise<void> {
    await this.client.close().catch(() => undefined);
    await this.transport.close().catch(() => undefined);
  }
}
