#!/usr/bin/env python3
"""
Transcript Relay — 手机 App 与 Claude Code 会话之间的轻量中继。

部署在跑 Claude Code 的机器上（主要面向 Windows + Windows Terminal），
通过 devtunnel 暴露给手机：

    python transcript_relay.py --token <secret> --port 19850
    devtunnel host -p 19850 --allow-anonymous

职责（保持「哑」，transcript 是唯一状态源，解析在手机端）：
  1. 会话发现        GET  /api/sessions
  2. JSONL 增量推送  GET  /api/session/<projectKey>/<sessionId>/stream   (SSE)
  3. 输入注入        POST /api/session/<projectKey>/<sessionId>/input
  4. 进程绑定        GET  /api/processes  +  POST .../bind

按键注入移植自 claude-code-webui/win_send_keys.py（AttachConsole +
WriteConsoleInputW），以子进程方式运行避免干扰本进程控制台。

协议详见同目录 protocol.md。仅依赖 Python 3.8+ 标准库。
"""

import argparse
import csv
import io
import json
import os
import subprocess
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, unquote, urlparse

IS_WINDOWS = os.name == "nt"

# AskUserQuestion 选项注入的按键策略。
# Claude Code TUI 的选项支持数字键快速选择；如你的版本需要回车确认，
# 把 OPTION_NEEDS_ENTER 改为 True 即可，无需改手机端。
OPTION_NEEDS_ENTER = False

SNAPSHOT_CHUNK_LINES = 500
POLL_INTERVAL_SECONDS = 0.5
HEARTBEAT_SECONDS = 15
SESSION_LIST_LIMIT = 50
TAIL_SCAN_BYTES = 256 * 1024
TITLE_SCAN_BYTES = 64 * 1024

ARGS = None
BINDINGS_LOCK = threading.Lock()
BINDINGS_FILE = os.path.join(
    os.path.expanduser("~"), ".transcript_relay_bindings.json"
)


# =============================================================================
# Windows 控制台按键注入（子进程模式，移植自 claude-code-webui）
# =============================================================================

def inject_keys(pid, keys, append_enter):
    """向目标控制台进程注入按键。非 Windows 平台返回 False。"""
    if ARGS and ARGS.dev_echo:
        print(f"[dev-echo] inject pid={pid} enter={append_enter} keys={keys!r}")
        return True
    if not IS_WINDOWS:
        return False
    payload = json.dumps({"keys": keys, "enter": append_enter})
    try:
        result = subprocess.run(
            [sys.executable, os.path.abspath(__file__), "--send-keys", str(pid)],
            input=payload.encode("utf-8"),
            capture_output=True,
            timeout=10,
        )
        return result.returncode == 0
    except (FileNotFoundError, subprocess.TimeoutExpired):
        return False


def _send_keys_child(target_pid):
    """子进程入口：附加到目标控制台并写入键盘事件。"""
    import ctypes
    import ctypes.wintypes as wt

    payload = json.loads(sys.stdin.buffer.read().decode("utf-8"))
    text = payload["keys"]
    if payload.get("enter"):
        text = text.replace("\n", "\r") + "\r"
    else:
        text = text.replace("\n", "\r")

    kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
    kernel32.FreeConsole()
    if not kernel32.AttachConsole(target_pid):
        print(f"AttachConsole failed: {ctypes.get_last_error()}", file=sys.stderr)
        return 1

    try:
        GENERIC_READ_WRITE = 0x80000000 | 0x40000000
        FILE_SHARE_READ_WRITE = 0x1 | 0x2
        OPEN_EXISTING = 3
        INVALID_HANDLE = ctypes.c_void_p(-1).value
        kernel32.CreateFileW.restype = wt.HANDLE
        # GetStdHandle 在 FreeConsole+AttachConsole 后是陈旧句柄，必须 CONIN$
        handle = kernel32.CreateFileW(
            "CONIN$", GENERIC_READ_WRITE, FILE_SHARE_READ_WRITE,
            None, OPEN_EXISTING, 0, None,
        )
        if not handle or handle == INVALID_HANDLE:
            print(f"CreateFileW(CONIN$) failed: {ctypes.get_last_error()}", file=sys.stderr)
            return 1

        KEY_EVENT = 0x0001
        VK_RETURN = 0x0D

        class KEY_EVENT_RECORD(ctypes.Structure):
            _fields_ = [
                ("bKeyDown", wt.BOOL),
                ("wRepeatCount", wt.WORD),
                ("wVirtualKeyCode", wt.WORD),
                ("wVirtualScanCode", wt.WORD),
                ("uChar", ctypes.c_wchar),
                ("dwControlKeyState", wt.DWORD),
            ]

        class INPUT_RECORD_Event(ctypes.Union):
            _fields_ = [
                ("KeyEvent", KEY_EVENT_RECORD),
                ("_padding", ctypes.c_byte * 16),
            ]

        class INPUT_RECORD(ctypes.Structure):
            _fields_ = [
                ("EventType", wt.WORD),
                ("_padding", wt.WORD),
                ("Event", INPUT_RECORD_Event),
            ]

        records = []
        for ch in text:
            vk = VK_RETURN if ch == "\r" else 0
            for key_down in (True, False):
                rec = INPUT_RECORD()
                rec.EventType = KEY_EVENT
                rec.Event.KeyEvent.bKeyDown = key_down
                rec.Event.KeyEvent.wRepeatCount = 1
                rec.Event.KeyEvent.wVirtualKeyCode = vk
                rec.Event.KeyEvent.wVirtualScanCode = 0
                rec.Event.KeyEvent.uChar = ch
                rec.Event.KeyEvent.dwControlKeyState = 0
                records.append(rec)

        arr = (INPUT_RECORD * len(records))(*records)
        written = wt.DWORD()
        ok = kernel32.WriteConsoleInputW(handle, arr, len(records), ctypes.byref(written))
        if not ok:
            print(f"WriteConsoleInputW failed: {ctypes.get_last_error()}", file=sys.stderr)
            return 1
        kernel32.CloseHandle(handle)
        return 0 if written.value > 0 else 1
    finally:
        kernel32.FreeConsole()


# =============================================================================
# transcript 扫描与状态推导
# =============================================================================

def projects_dir():
    return os.path.expanduser(ARGS.projects_dir)


def session_path(project_key, session_id):
    # 防目录穿越
    if "/" in project_key or "\\" in project_key or ".." in project_key:
        return None
    if "/" in session_id or "\\" in session_id or ".." in session_id:
        return None
    path = os.path.join(projects_dir(), project_key, f"{session_id}.jsonl")
    return path if os.path.isfile(path) else None


def parse_tail_entries(path, max_bytes=TAIL_SCAN_BYTES):
    """读文件尾部若干字节，解析为 entry 列表（首个半行丢弃）。"""
    try:
        size = os.path.getsize(path)
        with open(path, "rb") as f:
            if size > max_bytes:
                f.seek(size - max_bytes)
                f.readline()  # 丢弃半行
            data = f.read()
    except OSError:
        return []
    entries = []
    for line in data.decode("utf-8", errors="replace").splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            obj = json.loads(line)
            if isinstance(obj, dict):
                entries.append(obj)
        except ValueError:
            continue
    return entries


def derive_state(entries):
    """从 transcript 尾部推导会话状态（与 claude-code-webui 同思路）。"""
    last_assistant = None
    last_assistant_index = -1
    for i in range(len(entries) - 1, -1, -1):
        e = entries[i]
        if e.get("type") == "assistant" and isinstance(
            e.get("message", {}).get("content"), list
        ):
            last_assistant = e
            last_assistant_index = i
            break

    # 最后一条是普通用户输入且其后还没有 assistant —— 正在思考
    for i in range(len(entries) - 1, -1, -1):
        e = entries[i]
        etype = e.get("type")
        if etype in ("user", "assistant"):
            if etype == "user" and i > last_assistant_index:
                content = e.get("message", {}).get("content")
                is_tool_result = isinstance(content, list) and any(
                    isinstance(b, dict) and b.get("type") == "tool_result"
                    for b in content
                )
                if not is_tool_result and not e.get("isMeta"):
                    return "busy"
            break

    if not last_assistant:
        return "idle"

    content = last_assistant["message"]["content"]
    tool_uses = [
        b for b in content
        if isinstance(b, dict) and b.get("type") == "tool_use"
    ]
    if not tool_uses:
        return "idle"

    resolved = set()
    for e in entries[last_assistant_index + 1:]:
        if e.get("type") != "user":
            continue
        c = e.get("message", {}).get("content")
        if not isinstance(c, list):
            continue
        for b in c:
            if isinstance(b, dict) and b.get("type") == "tool_result":
                resolved.add(b.get("tool_use_id"))

    unresolved = [t for t in tool_uses if t.get("id") not in resolved]
    if not unresolved:
        return "idle"
    names = {t.get("name") for t in unresolved}
    if "AskUserQuestion" in names:
        return "elicitation"
    if "ExitPlanMode" in names:
        return "plan_review"
    return "busy"


def extract_title(path):
    """从头尾各扫一段，找 customTitle / aiTitle / 首条用户输入。"""
    custom, ai, first_prompt = None, None, None
    try:
        size = os.path.getsize(path)
        with open(path, "rb") as f:
            head = f.read(TITLE_SCAN_BYTES)
            tail = b""
            if size > TITLE_SCAN_BYTES * 2:
                f.seek(size - TITLE_SCAN_BYTES)
                tail = f.read()
    except OSError:
        return None
    for blob in (head, tail):
        for line in blob.decode("utf-8", errors="replace").splitlines():
            line = line.strip()
            if not line or '"' not in line:
                continue
            try:
                obj = json.loads(line)
            except ValueError:
                continue
            if not isinstance(obj, dict):
                continue
            t = obj.get("type")
            if t == "custom-title" and obj.get("customTitle"):
                custom = obj["customTitle"]
            elif t == "ai-title" and obj.get("aiTitle"):
                ai = obj["aiTitle"]
            elif t == "user" and first_prompt is None:
                content = obj.get("message", {}).get("content")
                if isinstance(content, str) and not content.startswith("<"):
                    first_prompt = content.strip().replace("\n", " ")[:60]
    return custom or ai or first_prompt


def extract_cwd(entries):
    for e in entries:
        cwd = e.get("cwd")
        if isinstance(cwd, str) and cwd:
            return cwd
    return None


def list_sessions():
    base = projects_dir()
    candidates = []
    try:
        for project_key in os.listdir(base):
            project_path = os.path.join(base, project_key)
            if not os.path.isdir(project_path):
                continue
            for name in os.listdir(project_path):
                if not name.endswith(".jsonl"):
                    continue
                full = os.path.join(project_path, name)
                try:
                    stat = os.stat(full)
                except OSError:
                    continue
                candidates.append((stat.st_mtime, stat.st_size, project_key, name[:-6], full))
    except OSError:
        return []

    candidates.sort(reverse=True)
    bindings = load_bindings()
    sessions = []
    for mtime, size, project_key, session_id, full in candidates[:SESSION_LIST_LIMIT]:
        entries = parse_tail_entries(full, 64 * 1024)
        sessions.append({
            "projectKey": project_key,
            "sessionId": session_id,
            "title": extract_title(full),
            "state": derive_state(entries),
            "mtime": int(mtime),
            "size": size,
            "cwd": extract_cwd(entries),
            "boundPid": bindings.get(f"{project_key}/{session_id}"),
        })
    return sessions


def read_new_lines(path, offset, remainder):
    """从 offset 读新增字节，返回（完整行列表, 新 offset, 半行缓存）。"""
    try:
        size = os.path.getsize(path)
        if size <= offset:
            return [], offset, remainder
        with open(path, "rb") as f:
            f.seek(offset)
            data = f.read(size - offset)
    except OSError:
        return [], offset, remainder
    buf = remainder + data
    if b"\n" in buf:
        complete, remainder = buf.rsplit(b"\n", 1)
        lines = [
            l for l in complete.decode("utf-8", errors="replace").split("\n") if l.strip()
        ]
    else:
        lines, remainder = [], buf
    return lines, offset + len(data), remainder


# =============================================================================
# PID 绑定
# =============================================================================

def load_bindings():
    with BINDINGS_LOCK:
        try:
            with open(BINDINGS_FILE) as f:
                data = json.load(f)
            return data if isinstance(data, dict) else {}
        except (OSError, ValueError):
            return {}


def save_binding(session_key, pid):
    with BINDINGS_LOCK:
        try:
            with open(BINDINGS_FILE) as f:
                data = json.load(f)
            if not isinstance(data, dict):
                data = {}
        except (OSError, ValueError):
            data = {}
        data[session_key] = pid
        with open(BINDINGS_FILE, "w") as f:
            json.dump(data, f, indent=2)


def list_processes():
    """列出疑似 Claude Code 的进程，供手机端绑定 PID。"""
    if not IS_WINDOWS:
        return []
    try:
        result = subprocess.run(
            ["tasklist", "/v", "/fo", "csv"],
            capture_output=True, timeout=10, text=True, errors="replace",
        )
    except (FileNotFoundError, subprocess.TimeoutExpired):
        return []
    processes = []
    reader = csv.reader(io.StringIO(result.stdout))
    for row in reader:
        if len(row) < 2:
            continue
        name, pid = row[0], row[1]
        title = row[-1] if len(row) >= 9 else ""
        lowered = name.lower()
        if any(key in lowered for key in ("claude", "node", "bun")):
            try:
                processes.append({"pid": int(pid), "name": name, "title": title})
            except ValueError:
                continue
    return processes


# =============================================================================
# HTTP / SSE
# =============================================================================

class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt, *args):
        if ARGS.verbose:
            sys.stderr.write(f"{self.address_string()} {fmt % args}\n")

    # ---- 基础设施 ----

    def _cors(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")

    def _json(self, obj, status=200):
        body = json.dumps(obj).encode("utf-8")
        self.send_response(status)
        self._cors()
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _check_token(self, query):
        if not ARGS.token:
            return True
        return query.get("token", [""])[0] == ARGS.token

    def _read_body(self):
        length = int(self.headers.get("Content-Length", 0))
        if length <= 0 or length > 1024 * 1024:
            return None
        try:
            return json.loads(self.rfile.read(length).decode("utf-8"))
        except (ValueError, OSError):
            return None

    # ---- 路由 ----

    def do_OPTIONS(self):
        self.send_response(204)
        self._cors()
        self.send_header("Content-Length", "0")
        self.end_headers()

    def do_GET(self):
        parsed = urlparse(self.path)
        query = parse_qs(parsed.query)
        if not self._check_token(query):
            return self._json({"error": "unauthorized"}, 401)
        parts = [unquote(p) for p in parsed.path.strip("/").split("/")]

        if parts == ["api", "sessions"]:
            return self._json(list_sessions())
        if parts == ["api", "processes"]:
            return self._json(list_processes())
        if (
            len(parts) == 5
            and parts[:2] == ["api", "session"]
            and parts[4] == "stream"
        ):
            return self._stream(parts[2], parts[3])
        return self._json({"error": "not found"}, 404)

    def do_POST(self):
        parsed = urlparse(self.path)
        query = parse_qs(parsed.query)
        if not self._check_token(query):
            return self._json({"error": "unauthorized"}, 401)
        parts = [unquote(p) for p in parsed.path.strip("/").split("/")]

        if len(parts) == 5 and parts[:2] == ["api", "session"]:
            project_key, session_id, action = parts[2], parts[3], parts[4]
            if action == "input":
                return self._input(project_key, session_id)
            if action == "bind":
                body = self._read_body()
                pid = body.get("pid") if isinstance(body, dict) else None
                if not isinstance(pid, int):
                    return self._json({"ok": False, "error": "需要整数 pid"}, 400)
                save_binding(f"{project_key}/{session_id}", pid)
                return self._json({"ok": True})
        return self._json({"error": "not found"}, 404)

    # ---- 输入注入 ----

    def _input(self, project_key, session_id):
        if session_path(project_key, session_id) is None:
            return self._json({"ok": False, "error": "会话不存在"}, 404)
        body = self._read_body()
        if not isinstance(body, dict) or "type" not in body:
            return self._json({"ok": False, "error": "请求体格式错误"}, 400)

        pid = load_bindings().get(f"{project_key}/{session_id}")
        if pid is None and not ARGS.dev_echo:
            return self._json({
                "ok": False,
                "error": "会话未绑定终端进程，先调用 bind（App 里选择进程）",
            })

        action = body["type"]
        if action == "prompt" or action == "text_answer":
            text = body.get("text", "")
            if not isinstance(text, str) or not text.strip():
                return self._json({"ok": False, "error": "缺少 text"}, 400)
            ok = inject_keys(pid, text, append_enter=True)
        elif action == "option":
            index = body.get("index")
            if not isinstance(index, int) or index < 0 or index > 8:
                return self._json({"ok": False, "error": "index 非法"}, 400)
            ok = inject_keys(pid, str(index + 1), append_enter=OPTION_NEEDS_ENTER)
        elif action == "interrupt":
            ok = inject_keys(pid, "\x03", append_enter=False)
        else:
            return self._json({"ok": False, "error": f"未知动作 {action}"}, 400)

        if ok:
            return self._json({"ok": True})
        return self._json({
            "ok": False,
            "error": "注入失败（进程已退出？仅支持 Windows 控制台）",
        })

    # ---- SSE 流 ----

    def _sse_event(self, event, data):
        payload = f"event: {event}\ndata: {json.dumps(data)}\n\n"
        self.wfile.write(payload.encode("utf-8"))
        self.wfile.flush()

    def _stream(self, project_key, session_id):
        path = session_path(project_key, session_id)
        if path is None:
            return self._json({"error": "会话不存在"}, 404)

        self.send_response(200)
        self._cors()
        self.send_header("Content-Type", "text/event-stream; charset=utf-8")
        self.send_header("Cache-Control", "no-cache")
        self.send_header("Connection", "keep-alive")
        self.end_headers()

        try:
            # 1. 全量 snapshot（分块）
            offset, remainder = 0, b""
            pending = []
            while True:
                lines, offset, remainder = read_new_lines(path, offset, remainder)
                pending.extend(lines)
                if not lines:
                    break
            if not pending:
                self._sse_event("snapshot", {"lines": [], "offset": offset, "done": True})
            for i in range(0, len(pending), SNAPSHOT_CHUNK_LINES):
                chunk = pending[i:i + SNAPSHOT_CHUNK_LINES]
                self._sse_event("snapshot", {
                    "lines": chunk,
                    "offset": 0 if i == 0 else offset,
                    "done": i + SNAPSHOT_CHUNK_LINES >= len(pending),
                })

            last_state = derive_state(parse_tail_entries(path))
            self._sse_event("state", {"state": last_state})

            # 2. 增量推送 + 心跳
            last_heartbeat = time.time()
            while True:
                time.sleep(POLL_INTERVAL_SECONDS)
                lines, offset, remainder = read_new_lines(path, offset, remainder)
                if lines:
                    self._sse_event("append", {"lines": lines, "offset": offset})
                    state = derive_state(parse_tail_entries(path))
                    if state != last_state:
                        last_state = state
                        self._sse_event("state", {"state": state})
                elif time.time() - last_heartbeat > HEARTBEAT_SECONDS:
                    self.wfile.write(b": ping\n\n")
                    self.wfile.flush()
                    last_heartbeat = time.time()
                    # 心跳间隙也复查状态（如工具结束但无新行的边缘情况）
                    state = derive_state(parse_tail_entries(path))
                    if state != last_state:
                        last_state = state
                        self._sse_event("state", {"state": state})
        except (BrokenPipeError, ConnectionResetError, OSError):
            return  # 客户端断开


# =============================================================================
# 入口
# =============================================================================

def main():
    global ARGS
    # 子进程模式：--send-keys <pid>，stdin 读 JSON payload
    if len(sys.argv) >= 3 and sys.argv[1] == "--send-keys":
        sys.exit(_send_keys_child(int(sys.argv[2])))

    parser = argparse.ArgumentParser(description="Transcript Relay server")
    parser.add_argument("--port", type=int, default=19850)
    parser.add_argument("--host", default="127.0.0.1",
                        help="默认仅本机；配合 devtunnel 无需改动")
    parser.add_argument("--token", default=os.environ.get("RELAY_TOKEN", ""),
                        help="共享密钥；客户端通过 ?token= 携带")
    parser.add_argument("--projects-dir", default="~/.claude/projects")
    parser.add_argument("--dev-echo", action="store_true",
                        help="开发模式：输入动作只打印不注入（非 Windows 联调用）")
    parser.add_argument("--verbose", action="store_true")
    ARGS = parser.parse_args()

    if not ARGS.token:
        print("警告：未设置 --token / RELAY_TOKEN，任何拿到 URL 的人都能访问", file=sys.stderr)

    server = ThreadingHTTPServer((ARGS.host, ARGS.port), Handler)
    server.daemon_threads = True
    print(f"Transcript Relay listening on {ARGS.host}:{ARGS.port}")
    print(f"projects dir: {os.path.expanduser(ARGS.projects_dir)}")
    server.serve_forever()


if __name__ == "__main__":
    main()
