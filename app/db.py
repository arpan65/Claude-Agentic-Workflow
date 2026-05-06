import json
import logging
import os
import pathlib
import sqlite3
import uuid
from contextlib import contextmanager
from datetime import datetime, timezone
from typing import Optional

logger = logging.getLogger("db")

_USE_DYNAMO = os.environ.get("USE_DYNAMODB", "").lower() in ("1", "true", "yes")

# ── SQLite setup ───────────────────────────────────────────────────────────────

_DB_PATH = pathlib.Path(__file__).parent.parent / "travel_runs.db"
_dynamodb = None


@contextmanager
def _sqlite():
    conn = sqlite3.connect(_DB_PATH, check_same_thread=False)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    try:
        yield conn
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()


def _init_sqlite() -> None:
    with _sqlite() as conn:
        conn.executescript("""
            CREATE TABLE IF NOT EXISTS runs (
                id TEXT PRIMARY KEY,
                created_at TEXT NOT NULL,
                input_message TEXT NOT NULL,
                session_id TEXT,
                status TEXT NOT NULL DEFAULT 'running',
                result_json TEXT,
                total_duration_ms INTEGER
            );
            CREATE TABLE IF NOT EXISTS agent_calls (
                id TEXT PRIMARY KEY,
                run_id TEXT NOT NULL,
                phase TEXT NOT NULL,
                model TEXT NOT NULL,
                started_at TEXT NOT NULL,
                status TEXT NOT NULL DEFAULT 'running',
                duration_ms INTEGER,
                input_tokens INTEGER,
                output_tokens INTEGER,
                cache_read_tokens INTEGER,
                cache_write_tokens INTEGER,
                tool_calls_count INTEGER,
                output_text TEXT
            );
            CREATE TABLE IF NOT EXISTS tool_calls (
                id TEXT PRIMARY KEY,
                agent_call_id TEXT NOT NULL,
                run_id TEXT NOT NULL,
                tool_name TEXT NOT NULL,
                input_json TEXT,
                output_text TEXT,
                duration_ms INTEGER,
                success INTEGER
            );
        """)
    logger.info("SQLite DB ready at %s", _DB_PATH)


# ── DynamoDB setup ─────────────────────────────────────────────────────────────

RUNS_TABLE        = "tripai-runs"
AGENT_CALLS_TABLE = "tripai-agent-calls"
TOOL_CALLS_TABLE  = "tripai-tool-calls"


def _ddb():
    global _dynamodb
    if _dynamodb is None:
        import boto3
        _dynamodb = boto3.resource("dynamodb", region_name=os.environ.get("AWS_REGION", "us-east-1"))
    return _dynamodb


def _init_dynamo() -> None:
    try:
        from botocore.exceptions import ClientError
        _ddb().Table(RUNS_TABLE).load()
        logger.info("DynamoDB tables verified: %s, %s, %s", RUNS_TABLE, AGENT_CALLS_TABLE, TOOL_CALLS_TABLE)
    except Exception:
        logger.warning("DynamoDB table check failed — tracing may be disabled", exc_info=True)


# ── Public init ────────────────────────────────────────────────────────────────

def init_db() -> None:
    if _USE_DYNAMO:
        _init_dynamo()
    else:
        _init_sqlite()


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


# ── Run lifecycle ──────────────────────────────────────────────────────────────

def create_run(run_id: str, input_message: str, session_id: Optional[str]) -> None:
    try:
        if _USE_DYNAMO:
            _ddb().Table(RUNS_TABLE).put_item(Item={
                "id": run_id, "created_at": _now(),
                "input_message": input_message,
                "session_id": session_id or "", "status": "running",
            })
        else:
            with _sqlite() as conn:
                conn.execute(
                    "INSERT INTO runs (id, created_at, input_message, session_id, status) VALUES (?,?,?,?,?)",
                    (run_id, _now(), input_message, session_id or "", "running"),
                )
    except Exception:
        logger.warning("create_run failed", exc_info=True)


def complete_run(run_id: str, result_json: str, duration_ms: int) -> None:
    try:
        if _USE_DYNAMO:
            _ddb().Table(RUNS_TABLE).update_item(
                Key={"id": run_id},
                UpdateExpression="SET #s = :s, result_json = :r, total_duration_ms = :d",
                ExpressionAttributeNames={"#s": "status"},
                ExpressionAttributeValues={":s": "complete", ":r": result_json, ":d": duration_ms},
            )
        else:
            with _sqlite() as conn:
                conn.execute(
                    "UPDATE runs SET status=?, result_json=?, total_duration_ms=? WHERE id=?",
                    ("complete", result_json, duration_ms, run_id),
                )
    except Exception:
        logger.warning("complete_run failed", exc_info=True)


def fail_run(run_id: str, error: str, duration_ms: int) -> None:
    try:
        if _USE_DYNAMO:
            _ddb().Table(RUNS_TABLE).update_item(
                Key={"id": run_id},
                UpdateExpression="SET #s = :s, result_json = :r, total_duration_ms = :d",
                ExpressionAttributeNames={"#s": "status"},
                ExpressionAttributeValues={
                    ":s": "error", ":r": json.dumps({"error": error}), ":d": duration_ms,
                },
            )
        else:
            with _sqlite() as conn:
                conn.execute(
                    "UPDATE runs SET status=?, result_json=?, total_duration_ms=? WHERE id=?",
                    ("error", json.dumps({"error": error}), duration_ms, run_id),
                )
    except Exception:
        logger.warning("fail_run failed", exc_info=True)


def get_latest_run() -> Optional[dict]:
    try:
        if _USE_DYNAMO:
            from boto3.dynamodb.conditions import Key
            resp = _ddb().Table(RUNS_TABLE).query(
                IndexName="status-created-index",
                KeyConditionExpression=Key("status").eq("complete"),
                ScanIndexForward=False, Limit=1,
            )
            items = resp.get("Items", [])
            if items:
                return {"input_message": items[0]["input_message"], "result_json": items[0]["result_json"]}
        else:
            with _sqlite() as conn:
                row = conn.execute(
                    "SELECT input_message, result_json FROM runs WHERE status='complete' ORDER BY created_at DESC LIMIT 1"
                ).fetchone()
                if row:
                    return {"input_message": row["input_message"], "result_json": row["result_json"]}
    except Exception:
        logger.warning("get_latest_run failed", exc_info=True)
    return None


# ── Agent call lifecycle ───────────────────────────────────────────────────────

def create_agent_call(agent_call_id: str, run_id: str, phase: str, model: str) -> None:
    try:
        if _USE_DYNAMO:
            _ddb().Table(AGENT_CALLS_TABLE).put_item(Item={
                "id": agent_call_id, "run_id": run_id, "phase": phase,
                "model": model, "started_at": _now(), "status": "running",
            })
        else:
            with _sqlite() as conn:
                conn.execute(
                    "INSERT INTO agent_calls (id, run_id, phase, model, started_at, status) VALUES (?,?,?,?,?,?)",
                    (agent_call_id, run_id, phase, model, _now(), "running"),
                )
    except Exception:
        logger.warning("create_agent_call failed", exc_info=True)


def complete_agent_call(
    agent_call_id: str, duration_ms: int,
    input_tokens: int, output_tokens: int,
    cache_read_tokens: int, cache_write_tokens: int,
    tool_calls_count: int, output_text: str,
) -> None:
    try:
        if _USE_DYNAMO:
            _ddb().Table(AGENT_CALLS_TABLE).update_item(
                Key={"id": agent_call_id},
                UpdateExpression=(
                    "SET #s = :s, duration_ms = :d, input_tokens = :it, output_tokens = :ot, "
                    "cache_read_tokens = :cr, cache_write_tokens = :cw, "
                    "tool_calls_count = :tc, output_text = :txt"
                ),
                ExpressionAttributeNames={"#s": "status"},
                ExpressionAttributeValues={
                    ":s": "complete", ":d": duration_ms, ":it": input_tokens,
                    ":ot": output_tokens, ":cr": cache_read_tokens,
                    ":cw": cache_write_tokens, ":tc": tool_calls_count,
                    ":txt": output_text[:10_000],
                },
            )
        else:
            with _sqlite() as conn:
                conn.execute(
                    """UPDATE agent_calls SET status=?, duration_ms=?, input_tokens=?,
                       output_tokens=?, cache_read_tokens=?, cache_write_tokens=?,
                       tool_calls_count=?, output_text=? WHERE id=?""",
                    ("complete", duration_ms, input_tokens, output_tokens,
                     cache_read_tokens, cache_write_tokens, tool_calls_count,
                     output_text[:10_000], agent_call_id),
                )
    except Exception:
        logger.warning("complete_agent_call failed", exc_info=True)


def fail_agent_call(agent_call_id: str, error: str, duration_ms: int) -> None:
    try:
        if _USE_DYNAMO:
            _ddb().Table(AGENT_CALLS_TABLE).update_item(
                Key={"id": agent_call_id},
                UpdateExpression="SET #s = :s, error = :e, duration_ms = :d",
                ExpressionAttributeNames={"#s": "status"},
                ExpressionAttributeValues={":s": "error", ":e": error, ":d": duration_ms},
            )
        else:
            with _sqlite() as conn:
                conn.execute(
                    "UPDATE agent_calls SET status=?, output_text=?, duration_ms=? WHERE id=?",
                    ("error", error, duration_ms, agent_call_id),
                )
    except Exception:
        logger.warning("fail_agent_call failed", exc_info=True)


# ── Tool call recording ────────────────────────────────────────────────────────

def record_tool_call(
    agent_call_id: str, run_id: str, tool_name: str,
    input_json: str, output_text: str, duration_ms: int, success: bool,
) -> None:
    try:
        if _USE_DYNAMO:
            _ddb().Table(TOOL_CALLS_TABLE).put_item(Item={
                "id": str(uuid.uuid4()), "agent_call_id": agent_call_id,
                "run_id": run_id, "tool_name": tool_name,
                "input_json": input_json, "output_text": output_text[:5_000],
                "duration_ms": duration_ms, "success": 1 if success else 0,
            })
        else:
            with _sqlite() as conn:
                conn.execute(
                    """INSERT INTO tool_calls (id, agent_call_id, run_id, tool_name, input_json, output_text, duration_ms, success)
                       VALUES (?,?,?,?,?,?,?,?)""",
                    (str(uuid.uuid4()), agent_call_id, run_id, tool_name,
                     input_json, output_text[:5_000], duration_ms, 1 if success else 0),
                )
    except Exception:
        logger.warning("record_tool_call failed", exc_info=True)
