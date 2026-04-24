import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createServer as createHttpServer, type IncomingMessage, type Server as NodeHttpServer } from "node:http";
import { randomUUID } from "node:crypto";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ListResourcesRequestSchema,
  ReadResourceRequestSchema,
  ListPromptsRequestSchema,
  GetPromptRequestSchema,
  McpError,
  ErrorCode
} from "@modelcontextprotocol/sdk/types.js";
import { RateLimiter, ConnectionMonitor, validateMessageSize } from "./utils/security.js";
import { Tool } from "./types.js";
import { z } from "zod";
import path from "path";
import os from 'os';
import {
  listVaultResources,
  readVaultResource
} from "./resources/resources.js";
import { listPrompts, getPrompt, registerPrompt } from "./utils/prompt-factory.js";
import { listVaultsPrompt } from "./prompts/list-vaults/index.js";

// Utility function to expand home directory
function expandHome(filepath: string): string {
  if (filepath.startsWith('~/') || filepath === '~') {
    return path.join(os.homedir(), filepath.slice(1));
  }
  return filepath;
}

export class ObsidianServer {
  private server: Server;
  private tools: Map<string, Tool<any>> = new Map();
  private vaults: Map<string, string> = new Map();
  private rateLimiter: RateLimiter;
  private connectionMonitor: ConnectionMonitor;

  private httpServer?: NodeHttpServer;
  private httpTransport?: StreamableHTTPServerTransport;

  constructor(vaultConfigs: { name: string; path: string }[]) {
    if (!vaultConfigs || vaultConfigs.length === 0) {
      throw new McpError(
        ErrorCode.InvalidRequest,
        'No vault configurations provided. At least one valid Obsidian vault is required.'
      );
    }

    // Initialize vaults
    vaultConfigs.forEach(config => {
      const expandedPath = expandHome(config.path);
      const resolvedPath = path.resolve(expandedPath);

      this.vaults.set(config.name, resolvedPath);
    });
    this.server = new Server(
      {
        name: "obsidian-mcp",
        version: "1.0.6"
      },
      {
        capabilities: {
          resources: {},
          tools: {},
          prompts: {}
        }
      }
    );

    // Initialize security features
    this.rateLimiter = new RateLimiter();
    this.connectionMonitor = new ConnectionMonitor();

    // Register prompts
    registerPrompt(listVaultsPrompt);

    this.setupHandlers();

    // Setup connection monitoring with grace period for initialization
    this.connectionMonitor.start(() => {
      console.error("Connection monitor timeout: shutting down server");
      
      // Force exit if graceful shutdown hangs
      setTimeout(() => {
        console.error("Graceful shutdown timed out, forcing exit...");
        process.exit(1);
      }, 3000).unref();
      
      this.stop().catch(console.error).finally(() => {
        process.exit(0);
      });
    });
    
    // Update activity during initialization
    this.connectionMonitor.updateActivity();

    // Setup error handler
    this.server.onerror = (error) => {
      console.error("Server error:", error);
    };
  }

  registerTool<T>(tool: Tool<T>) {
    console.error(`Registering tool: ${tool.name}`);
    this.tools.set(tool.name, tool);
    console.error(`Current tools: ${Array.from(this.tools.keys()).join(', ')}`);
  }

  private validateRequest(request: any) {
    try {
      // Validate message size
      validateMessageSize(request);

      // Update connection activity
      this.connectionMonitor.updateActivity();

      // Check rate limit (using method name as client id for basic implementation)
      if (!this.rateLimiter.checkLimit(request.method)) {
        throw new McpError(ErrorCode.InvalidRequest, "Rate limit exceeded");
      }
    } catch (error) {
      console.error("Request validation failed:", error);
      throw error;
    }
  }

  private setupHandlers() {
    // List available prompts
    this.server.setRequestHandler(ListPromptsRequestSchema, async (request) => {
      this.validateRequest(request);
      return listPrompts();
    });

    // Get specific prompt
    this.server.setRequestHandler(GetPromptRequestSchema, async (request) => {
      this.validateRequest(request);
      const { name, arguments: args } = request.params;
      
      if (!name || typeof name !== 'string') {
        throw new McpError(ErrorCode.InvalidParams, "Missing or invalid prompt name");
      }

      const result = await getPrompt(name, this.vaults, args);
      return {
        ...result,
        _meta: {
          promptName: name,
          timestamp: new Date().toISOString()
        }
      };
    });

    // List available tools
    this.server.setRequestHandler(ListToolsRequestSchema, async (request) => {
      this.validateRequest(request);
      return {
        tools: Array.from(this.tools.values()).map(tool => ({
          name: tool.name,
          description: tool.description,
          inputSchema: tool.inputSchema.jsonSchema
        }))
      };
    });

    // List available resources
    this.server.setRequestHandler(ListResourcesRequestSchema, async (request) => {
      this.validateRequest(request);
      const resources = await listVaultResources(this.vaults);
      return {
        resources,
        resourceTemplates: []
      };
    });

    // Read resource content
    this.server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
      this.validateRequest(request);
      const uri = request.params?.uri;
      if (!uri || typeof uri !== 'string') {
        throw new McpError(ErrorCode.InvalidParams, "Missing or invalid URI parameter");
      }

      if (!uri.startsWith('obsidian-vault://')) {
        throw new McpError(ErrorCode.InvalidParams, "Invalid URI format. Only vault resources are supported.");
      }

      return {
        contents: [await readVaultResource(this.vaults, uri)]
      };
    });

    this.server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
      this.validateRequest(request);
      const params = request.params;
      if (!params || typeof params !== 'object') {
        throw new McpError(ErrorCode.InvalidParams, "Invalid request parameters");
      }
      
      const name = params.name;
      const args = params.arguments;
      
      if (!name || typeof name !== 'string') {
        throw new McpError(ErrorCode.InvalidParams, "Missing or invalid tool name");
      }

      const tool = this.tools.get(name);
      if (!tool) {
        throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${name}`);
      }

      try {
        // Validate and transform arguments using tool's schema handler
        const validatedArgs = tool.inputSchema.parse(args);
        
        // Execute tool with validated arguments
        const result = await tool.handler(validatedArgs);
        
        return {
          _meta: {
            toolName: name,
            timestamp: new Date().toISOString(),
            success: true
          },
          content: result.content
        };
      } catch (error: unknown) {
        if (error instanceof z.ZodError) {
          const formattedErrors = error.errors.map(e => {
            const path = e.path.join(".");
            const message = e.message;
            return `${path ? path + ': ' : ''}${message}`;
          }).join("\n");
          
          throw new McpError(
            ErrorCode.InvalidParams,
            `Invalid arguments:\n${formattedErrors}`
          );
        }
        
        // Enhance error reporting
        if (error instanceof McpError) {
          throw error;
        }
        
        // Convert unknown errors to McpError with helpful message
        throw new McpError(
          ErrorCode.InternalError,
          `Tool execution failed: ${error instanceof Error ? error.message : String(error)}`
        );
      }
    });
  }

  async start() {
    const transport = new StdioServerTransport();
    await this.server.connect(transport);
    console.error("Obsidian MCP Server running on stdio");
  }

  async startHttp(options: {
    host: string;
    port: number;
    path?: string;
    token: string;
    corsOrigin?: string;
    enableJsonResponse?: boolean;
  }) {
    const pathPrefix = (options.path ?? "/mcp").replace(/\/+$/, "") || "/mcp";

    if (!options.token || typeof options.token !== 'string') {
      throw new McpError(ErrorCode.InvalidRequest, "HTTP/SSE enabled but no token provided (OBSIDIAN_MCP_HTTP_TOKEN)");
    }

    if (this.httpServer) {
      throw new McpError(ErrorCode.InvalidRequest, "HTTP server already started");
    }

    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      enableJsonResponse: options.enableJsonResponse ?? false
    });
    this.httpTransport = transport;
    await this.server.connect(transport);

    const setCorsHeaders = (res: any) => {
      if (!options.corsOrigin) return;
      res.setHeader("Access-Control-Allow-Origin", options.corsOrigin);
      res.setHeader("Access-Control-Allow-Methods", "GET,POST,DELETE,OPTIONS");
      res.setHeader("Access-Control-Allow-Headers", "Content-Type,Authorization,MCP-Protocol-Version");
      res.setHeader("Access-Control-Max-Age", "600");
    };

    const isAuthed = (req: IncomingMessage): boolean => {
      const header = req.headers['authorization'];
      if (!header || Array.isArray(header)) return false;
      const expected = `Bearer ${options.token}`;
      return header.trim() === expected;
    };

    const readJsonBody = async (req: IncomingMessage, maxBytes: number): Promise<unknown> => {
      const chunks: Buffer[] = [];
      let total = 0;
      for await (const chunk of req) {
        const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        total += buf.length;
        if (total > maxBytes) {
          throw new McpError(ErrorCode.InvalidRequest, `Request body too large (>${maxBytes} bytes)`);
        }
        chunks.push(buf);
      }
      if (chunks.length === 0) return undefined;
      const text = Buffer.concat(chunks).toString('utf8');
      if (!text) return undefined;
      try {
        return JSON.parse(text);
      } catch {
        throw new McpError(ErrorCode.ParseError, "Invalid JSON body");
      }
    };

    this.httpServer = createHttpServer(async (req, res) => {
      try {
        const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
        const pathname = url.pathname.replace(/\/+$/, '') || '/';

        // CORS preflight
        if (req.method === 'OPTIONS') {
          setCorsHeaders(res);
          res.statusCode = 204;
          res.end();
          return;
        }

        // Unauthed health check can be helpful for local ops
        if (req.method === 'GET' && pathname === '/health') {
          setCorsHeaders(res);
          res.statusCode = 200;
          res.setHeader('Content-Type', 'application/json; charset=utf-8');
          res.end(JSON.stringify({ ok: true }));
          return;
        }

        if (!isAuthed(req)) {
          setCorsHeaders(res);
          res.statusCode = 401;
          res.setHeader('Content-Type', 'application/json; charset=utf-8');
          res.end(JSON.stringify({ error: 'Unauthorized' }));
          return;
        }

        if (pathname !== pathPrefix) {
          setCorsHeaders(res);
          res.statusCode = 404;
          res.setHeader('Content-Type', 'application/json; charset=utf-8');
          res.end(JSON.stringify({ error: 'Not Found' }));
          return;
        }

        setCorsHeaders(res);
        let parsedBody: unknown = undefined;
        if (req.method === 'POST') {
          parsedBody = await readJsonBody(req, 5 * 1024 * 1024);
        }

        await transport.handleRequest(req as IncomingMessage & { auth?: any }, res, parsedBody);
      } catch (error) {
        // Avoid stdout; keep errors on stderr.
        console.error("HTTP transport error:", error);
        if (!res.headersSent) {
          res.statusCode = 500;
          res.setHeader('Content-Type', 'application/json; charset=utf-8');
          res.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
        }
      }
    });

    await new Promise<void>((resolve, reject) => {
      this.httpServer!.once('error', reject);
      this.httpServer!.listen(options.port, options.host, () => resolve());
    });

    console.error(`Obsidian MCP HTTP/SSE listening on http://${options.host}:${options.port}${pathPrefix}`);
  }

  async stop() {
    this.connectionMonitor.stop();

    if (this.httpServer) {
      const srv = this.httpServer;
      this.httpServer = undefined;
      await new Promise<void>((resolve) => srv.close(() => resolve()));
    }

    if (this.httpTransport) {
      const t = this.httpTransport;
      this.httpTransport = undefined;
      try {
        await t.close();
      } catch (e) {
        console.error("Error closing HTTP transport:", e);
      }
    }

    await this.server.close();
    console.error("Obsidian MCP Server stopped");
  }
}
