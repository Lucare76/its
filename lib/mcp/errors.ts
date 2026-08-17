export type McpErrorCode =
  | "MCP_UNAUTHORIZED"
  | "MCP_FORBIDDEN"
  | "MCP_INVALID_INPUT"
  | "MCP_NOT_FOUND"
  | "MCP_INTERNAL_ERROR"
  | "MCP_RATE_LIMITED";

const STATUS_BY_CODE: Record<McpErrorCode, number> = {
  MCP_UNAUTHORIZED: 401,
  MCP_FORBIDDEN: 403,
  MCP_INVALID_INPUT: 400,
  MCP_NOT_FOUND: 404,
  MCP_INTERNAL_ERROR: 500,
  MCP_RATE_LIMITED: 429,
};

export class McpError extends Error {
  readonly code: McpErrorCode;
  readonly status: number;

  constructor(code: McpErrorCode, message: string) {
    super(message);
    this.name = "McpError";
    this.code = code;
    this.status = STATUS_BY_CODE[code];
  }
}

/**
 * Converte qualunque errore (incluse le eccezioni Postgres/Supabase grezze) in un
 * McpError sicuro da restituire al client MCP, senza propagare stack trace o
 * dettagli interni del DB.
 */
export function toSafeMcpError(error: unknown): McpError {
  if (error instanceof McpError) return error;
  return new McpError("MCP_INTERNAL_ERROR", "Errore interno del server MCP.");
}
