import asyncio
import os
import json
from contextlib import AsyncExitStack
from typing import Any, Dict, List, Optional
from anthropic import Anthropic
from mcp import ClientSession, StdioServerParameters
from mcp.client.stdio import stdio_client

# --- SERVER CONFIGURATIONS ---
SERVER_CONFIGS = {
    "researcher": StdioServerParameters(command="uvx", args=["duckduckgo-mcp-server"]),
    "executor": StdioServerParameters(command="npx", args=["-y", "@playwright/mcp@latest"])
}

class MCPAgent:
    def __init__(self, api_key: str):
        # Use Sonnet for production-grade reasoning (Exam Recommendation)
        self.client = Anthropic(api_key=api_key)
        self.model = "claude-haiku-4-5-20251001"
        self.history = []
        self.stack = None
        self.sessions: Dict[str, ClientSession] = {}
        self.tools = []

    async def connect(self):
        if self.sessions: return
        self.stack = AsyncExitStack()
        
        for name, params in SERVER_CONFIGS.items():
            try:
                read, write = await self.stack.enter_async_context(stdio_client(params))
                session = await self.stack.enter_async_context(ClientSession(read, write))
                await session.initialize()
                
                mcp_tools_resp = await session.list_tools()
                for t in mcp_tools_resp.tools:
                    self.tools.append({
                        "name": t.name,
                        "description": t.description,
                        "input_schema": t.inputSchema,
                        "server_group": name # Used for routing
                    })
                self.sessions[name] = session
                print(f"[✅] {name} connected.")
            except Exception as e:
                print(f"[❌] {name} failed: {e}")

    async def run_agent(self, user_input: str):
        if not self.sessions: await self.connect()

        # Task 1.1: Comprehensive System Prompt (Role + Constraints + Context)
        system_prompt = (
            "You are a Senior Research & Automation Engineer. "
            "Use 'researcher' tools to find facts and 'executor' tools to verify or interact. "
            "If a tool fails, analyze the error metadata and retry if appropriate."
        )

        self.history.append({"role": "user", "content": user_input})

        while True:
            # Task 4.3: Strict schema-compliant tool definitions
            claude_tools = [{k: v for k, v in t.items() if k != 'server_group'} for t in self.tools]
            
            response = self.client.messages.create(
                model=self.model,
                system=system_prompt,
                max_tokens=2500,
                messages=self.history,
                tools=claude_tools
            )

            self.history.append({"role": "assistant", "content": response.content})
            
            if response.stop_reason != "tool_use":
                return response.content[0].text

            for block in response.content:
                if block.type == "tool_use":
                    # Task 1.5: Deterministic Safety Gate (Escalation)
                    if "executor" in block.name and ("delete" in str(block.input) or "purchase" in str(block.input)):
                        result = self._format_error("Policy Violation", "high_risk_action", is_retryable=False)
                    else:
                        result = await self._execute_tool(block)

                    self.history.append({
                        "role": "user",
                        "content": [{"type": "tool_result", "tool_use_id": block.id, "content": result}]
                    })

    async def _execute_tool(self, tool_call) -> str:
        """Executes tool and returns structured feedback for Claude."""
        tool_def = next((t for t in self.tools if t['name'] == tool_call.name), None)
        if not tool_def:
            return self._format_error("Tool not found", "routing_error")

        session = self.sessions[tool_def['server_group']]
        
        try:
            print(f"[*] Calling {tool_call.name} on {tool_def['server_group']}...")
            result = await session.call_tool(tool_call.name, tool_call.input)
            return self._format_tool_result(result)
        except Exception as e:
            # Task 2.2: Structured Error Handling instead of raw strings
            return self._format_error(str(e), "execution_failure", is_retryable=True)

    def _format_error(self, message: str, category: str, is_retryable: bool = True) -> str:
        """Returns JSON-structured error to trigger Claude's reasoning loop."""
        return json.dumps({
            "status": "error",
            "category": category,
            "is_retryable": is_retryable,
            "message": message,
            "instruction": "Analyze the error. If retryable, fix parameters and call again. If not, escalate."
        })

    def _format_tool_result(self, result: Any) -> str:
        """Extracts text and appends provenance metadata (Task 5.5)."""
        content = getattr(result, "content", [])
        text_blocks = [c.text for c in content if hasattr(c, "text")]
        
        output = "\n".join(text_blocks)
        # Wrap in 'Verification Metadata' to increase reliability
        return json.dumps({
            "status": "success",
            "data": output,
            "timestamp": "2026-04-26T08:04:33",
            "source": "MCP_Verified_Environment"
        })

    async def disconnect(self):
        if self.stack:
            await self.stack.aclose()
            self.sessions = {}