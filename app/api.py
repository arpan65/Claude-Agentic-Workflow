import asyncio
import json
import os
import uuid
from dataclasses import dataclass

from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field

from app.agent.mcp_agent import MCPAgent

load_dotenv()


class ChatRequest(BaseModel):
    message: str = Field(..., min_length=1)
    session_id: str | None = None


class ChatResponse(BaseModel):
    session_id: str
    reply: str


class ResetRequest(BaseModel):
    session_id: str


@dataclass
class AgentState:
    agent: MCPAgent


app = FastAPI(title="Claude MCP Backend", version="1.0.0")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

_agents: dict[str, AgentState] = {}
_api_key = os.getenv("ANTHROPIC_API_KEY")
if not _api_key:
    raise ValueError("Missing ANTHROPIC_API_KEY in environment")


def _get_or_create_state(session_id: str | None) -> tuple[str, AgentState]:
    if session_id and session_id in _agents:
        return session_id, _agents[session_id]

    new_session_id = session_id or str(uuid.uuid4())
    state = AgentState(agent=MCPAgent(api_key=_api_key))
    _agents[new_session_id] = state
    return new_session_id, state


@app.get("/health")
async def health() -> dict[str, str]:
    return {"status": "ok"}


@app.post("/api/chat", response_model=ChatResponse)
async def chat(payload: ChatRequest) -> ChatResponse:
    message = payload.message.strip()
    if not message:
        raise HTTPException(status_code=400, detail="Message cannot be empty")

    session_id, state = _get_or_create_state(payload.session_id)
    reply = await state.agent.run_agent(message)
    return ChatResponse(session_id=session_id, reply=reply)


@app.post("/api/chat/stream")
async def chat_stream(payload: ChatRequest) -> StreamingResponse:
    message = payload.message.strip()
    if not message:
        raise HTTPException(status_code=400, detail="Message cannot be empty")

    session_id, state = _get_or_create_state(payload.session_id)
    queue: asyncio.Queue = asyncio.Queue()

    async def progress_cb(msg: str) -> None:
        await queue.put({"type": "phase", "phase": msg})

    async def agent_task() -> None:
        try:
            result = await state.agent.run_agent(message, progress_callback=progress_cb)
            await queue.put({"type": "result", "reply": result})
        except Exception as exc:
            await queue.put({"type": "error", "message": str(exc)})
        finally:
            await queue.put(None)  # sentinel — signals end of stream

    async def generate():
        yield f"data: {json.dumps({'type': 'session', 'session_id': session_id})}\n\n"
        task = asyncio.create_task(agent_task())
        while True:
            item = await queue.get()
            if item is None:
                break
            yield f"data: {json.dumps(item)}\n\n"
        # Re-raise any task exception so FastAPI can log it
        if not task.cancelled():
            task.result()

    return StreamingResponse(
        generate(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "X-Accel-Buffering": "no",
            "Connection": "keep-alive",
        },
    )


@app.post("/api/reset")
async def reset(payload: ResetRequest) -> dict[str, str]:
    state = _agents.pop(payload.session_id, None)
    if state:
        await state.agent.disconnect()
    return {"status": "cleared"}


@app.on_event("shutdown")
async def shutdown_event() -> None:
    for state in _agents.values():
        await state.agent.disconnect()
    _agents.clear()
