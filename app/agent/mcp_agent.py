import asyncio
import os
import json
from contextlib import AsyncExitStack
from typing import Any, Dict, List
from anthropic import Anthropic
from mcp import ClientSession, StdioServerParameters
from mcp.client.stdio import stdio_client

# --- NICHE SERVER CONFIGURATIONS ---
SERVER_CONFIGS = {
    "researcher": StdioServerParameters(
        command="uvx", 
        args=["duckduckgo-mcp-server"]
    ),
    "insider_intel": StdioServerParameters(
        command="uvx", 
        args=["mcp-youtube-transcript"] # Fetches transcripts for hidden luxury gems
    ),
    "amenity_verifier": StdioServerParameters(
        command="npx",
        args=["-y", "@playwright/mcp@latest"],
        env={**os.environ, "PLAYWRIGHT_HEADLESS": "true"}
    ),
    "financial_quant": StdioServerParameters(
        command="uvx", 
        args=["calculator-mcp-server"] # Deterministic budget/carbon math
    )
}

class MCPAgent:
    def __init__(self, api_key: str, max_history: int = 20):
        self.client = Anthropic(api_key=api_key)
        self.history = []
        self.max_history = max_history
        self.stack = None
        self.sessions = []
        self.tools = []
        # Task 5.2: Set a hard budget cap for deterministic escalation
        self.GLOBAL_BUDGET_CAP = 15000.0 

    async def connect(self):
        """Connect to specialized luxury and quant servers."""
        if self.sessions: return
        self.stack = AsyncExitStack()
        self.sessions = []
        self.tools = []

        for name, params in SERVER_CONFIGS.items():
            print(f"[*] Activating {name} module...")
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
                        "server_name": name
                    })
                self.sessions.append(session)
                print(f"[✅] {name} online.")
            except Exception as e:
                print(f"[❌] Failed to connect to {name}: {e}")

    async def run_agent(self, user_input: str):
        if not self.sessions: await self.connect()

        # Task 1.1: System prompt defines specialized sub-roles
        system_prompt = (
            "You are the VoyageElite Concierge Coordinator. "
            "1. Use 'researcher' for live hotel/flight data. "
            "2. Use 'insider_intel' to extract 'hidden gems' from YouTube transcripts. "
            "3. Use 'amenity_verifier' to check hotel websites for sustainability certificates. "
            "4. Use 'financial_quant' for ALL budget and carbon footprint math. "
            f"STRICT LIMIT: Do not authorize any plan exceeding ${self.GLOBAL_BUDGET_CAP}."
        )

        self.history.append({"role": "user", "content": user_input})

        while True:
            claude_tools = [{k: v for k, v in t.items() if k != 'server_name'} for t in self.tools]
            
            response = self.client.messages.create(
                model="claude-haiku-4-5-20251001",
                system=system_prompt,
                max_tokens=3000,
                messages=self.history,
                tools=claude_tools
            )

            self.history.append({"role": "assistant", "content": response.content})
            tool_calls = [b for b in response.content if b.type == "tool_use"]
            
            if not tool_calls:
                return response.content[0].text

            for tool_call in tool_calls:
                # Task 1.5: Deterministic Safety Hook (Escalation Logic)
                # We intercept the 'calculator' or 'book' tools to enforce policy in code
                if tool_call.name == "calculate_sum" or tool_call.name == "finalize_booking":
                    potential_cost = float(tool_call.input.get("a", 0) or tool_call.input.get("total", 0))
                    if potential_cost > self.GLOBAL_BUDGET_CAP:
                        tool_output = self._format_error(
                            f"BUDGET_ESCALATION: Proposed cost ${potential_cost} exceeds luxury tier cap.",
                            "policy_violation",
                            is_retryable=False
                        )
                        self._inject_tool_result(tool_call.id, tool_output)
                        continue

                # Standard routing logic
                tool_def = next((t for t in self.tools if t['name'] == tool_call.name), None)
                session_idx = list(SERVER_CONFIGS.keys()).index(tool_def['server_name'])
                session = self.sessions[session_idx]

                try:
                    result = await session.call_tool(tool_call.name, tool_call.input)
                    # Task 5.5: Format with Provenance
                    tool_output = self._format_tool_result(result, tool_def['server_name'])
                except Exception as e:
                    # Task 2.2: Structured Error Feedback
                    tool_output = self._format_error(str(e), "execution_error")

                self._inject_tool_result(tool_call.id, tool_output)

    def _inject_tool_result(self, tool_id: str, content: str):
        self.history.append({
            "role": "user",
            "content": [{"type": "tool_result", "tool_use_id": tool_id, "content": content}]
        })

    def _format_tool_result(self, result: Any, server_name: str) -> str:
        content = getattr(result, "content", [])
        text = "\n".join([c.text for c in content if hasattr(c, "text")])
        
        # Domain 5.5: Adding Metadata for Grounding
        return json.dumps({
            "status": "success",
            "source": server_name,
            "verification_timestamp": "2026-04-26",
            "data": text
        })

    def _format_error(self, msg: str, category: str, is_retryable: bool = True) -> str:
        # Domain 2.2: Helps Claude decide to retry or pivot
        return json.dumps({
            "status": "error",
            "category": category,
            "is_retryable": is_retryable,
            "message": msg
        })

    async def disconnect(self):
        if self.stack:
            await self.stack.aclose()
            self.sessions = []
            self.stack = None