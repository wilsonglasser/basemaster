-- Per-connection MCP guardrail policy. NULL = inherit the global mcp.block_*
-- settings (default). Otherwise a JSON blob: {"mode":"read_only"} or
-- {"mode":"custom","block_dml":bool,"block_ddl":bool,"block_perms":bool,"block_tx":bool}.
ALTER TABLE connection_profiles ADD COLUMN mcp_access TEXT;
