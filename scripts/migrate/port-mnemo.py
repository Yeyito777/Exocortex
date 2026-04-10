#!/usr/bin/env python3
"""
Port conversations from mnemo format to Exocortex format.

Mnemo stores flat messages with roles: user, assistant, tool_call, tool_result.
Exocortex uses the Anthropic API message format where:
  - assistant messages contain tool_use blocks inline
  - tool_result blocks are grouped into user messages
  - each message has { role, content, metadata }

Usage:
  python3 scripts/migrate/port-mnemo.py [--all-pinned] [--dry-run] [title1] [title2] ...
  python3 scripts/migrate/port-mnemo.py --id <conversation-id>  (port by ID)
"""

import json
import os
import sys
import argparse
from pathlib import Path

MNEMO_DIR = Path.home() / ".config" / "mnemo" / "conversations"
MNEMO_INDEX = MNEMO_DIR / "index.json"
EXOCORTEX_DIR = Path.home() / "Workspace" / "Exocortex" / "config" / "data" / "conversations"

CURRENT_VERSION = 9
DEFAULT_EFFORT = "high"


def load_mnemo_index():
    """Load the mnemo conversation index."""
    with open(MNEMO_INDEX) as f:
        return json.load(f)


def load_mnemo_conversation(conv_id):
    """Load a mnemo conversation by ID."""
    path = MNEMO_DIR / f"{conv_id}.json"
    with open(path) as f:
        return json.load(f)


def convert_messages(mnemo_messages):
    """
    Convert mnemo flat message list to Exocortex StoredMessage format.

    Mnemo sequence:  user, assistant, tool_call*, tool_result*, assistant, ...
    Exocortex sequence: user, assistant (with tool_use), user (with tool_results), assistant, ...
    """
    result = []
    i = 0
    n = len(mnemo_messages)

    while i < n:
        msg = mnemo_messages[i]
        role = msg.get("role")

        if role == "user":
            # Plain user message
            stored = {
                "role": "user",
                "content": msg["text"],
                "metadata": None,
            }
            # Handle images: convert mnemo format to Exocortex API format
            images = msg.get("images", [])
            if images:
                content_blocks = []
                for img in images:
                    content_blocks.append({
                        "type": "image",
                        "source": {
                            "type": "base64",
                            "media_type": img["mediaType"],
                            "data": img["base64"],
                        }
                    })
                content_blocks.append({
                    "type": "text",
                    "text": msg["text"],
                })
                stored["content"] = content_blocks
            result.append(stored)
            i += 1

        elif role == "assistant":
            # Build content blocks from the assistant message
            content_blocks = []

            # 1. Add thinking block if present
            content_blocks_src = msg.get("contentBlocks", [])
            for cb in content_blocks_src:
                if cb.get("type") == "thinking":
                    content_blocks.append({
                        "type": "thinking",
                        "thinking": cb.get("thinking", ""),
                        "signature": cb.get("signature", ""),
                    })

            # 2. Add text block (from contentBlocks or top-level text)
            text_added = False
            for cb in content_blocks_src:
                if cb.get("type") == "text":
                    text = cb.get("text", "")
                    if text:
                        content_blocks.append({
                            "type": "text",
                            "text": text,
                        })
                        text_added = True

            # If no text from contentBlocks, use top-level text
            if not text_added and msg.get("text"):
                content_blocks.append({
                    "type": "text",
                    "text": msg["text"],
                })

            # 3. Look ahead for tool_call messages and fold them in
            j = i + 1
            while j < n and mnemo_messages[j].get("role") == "tool_call":
                tc = mnemo_messages[j]
                content_blocks.append({
                    "type": "tool_use",
                    "id": tc["toolCallId"],
                    "name": tc["toolName"],
                    "input": tc.get("toolInput", {}),
                })
                j += 1

            # Build metadata from assistant fields
            metadata = None
            if msg.get("model") or msg.get("tokens"):
                model = msg.get("model", "opus")
                # Map model names if needed
                model_map = {"opus": "opus", "sonnet": "sonnet", "haiku": "haiku"}
                model = model_map.get(model, model)
                # Try to reconstruct startedAt/endedAt
                duration_ms = msg.get("durationMs", 0)
                # We don't have exact timestamps, so we leave them approximate
                metadata = {
                    "startedAt": 0,
                    "endedAt": duration_ms if duration_ms else None,
                    "model": model,
                    "tokens": msg.get("tokens", 0),
                }

            # If content_blocks is empty (no text, no thinking, but had tool calls),
            # that's fine - the tool_use blocks are the content.
            # Note: do NOT emit empty text blocks — the API rejects them.

            result.append({
                "role": "assistant",
                "content": content_blocks,
                "metadata": metadata,
            })
            i = j  # skip past the tool_call messages we consumed

        elif role == "tool_result":
            # Group consecutive tool_result messages into one user message
            content_blocks = []
            while i < n and mnemo_messages[i].get("role") == "tool_result":
                tr = mnemo_messages[i]
                content_blocks.append({
                    "type": "tool_result",
                    "tool_use_id": tr["toolCallId"],
                    "content": tr.get("text", ""),
                    "is_error": tr.get("isError", False),
                })
                i += 1

            result.append({
                "role": "user",
                "content": content_blocks,
                "metadata": None,
            })

        elif role == "tool_call":
            # Orphan tool_call (not preceded by assistant) - shouldn't happen
            # but handle gracefully by creating a minimal assistant message
            content_blocks = []
            while i < n and mnemo_messages[i].get("role") == "tool_call":
                tc = mnemo_messages[i]
                content_blocks.append({
                    "type": "tool_use",
                    "id": tc["toolCallId"],
                    "name": tc["toolName"],
                    "input": tc.get("toolInput", {}),
                })
                i += 1
            result.append({
                "role": "assistant",
                "content": content_blocks,
                "metadata": None,
            })

        else:
            # Unknown role - skip
            print(f"  ⚠ Skipping unknown role: {role}", file=sys.stderr)
            i += 1

    return result


def validate_messages(messages):
    """
    Validate that the converted messages follow Anthropic API constraints:
    - Alternating user/assistant roles
    - No two consecutive messages with the same role
    """
    issues = []
    for i in range(1, len(messages)):
        if messages[i]["role"] == messages[i-1]["role"]:
            issues.append(f"  ⚠ Consecutive {messages[i]['role']} messages at index {i-1} and {i}")

    # First message should be user
    if messages and messages[0]["role"] != "user":
        issues.append(f"  ⚠ First message is {messages[0]['role']}, expected user")

    return issues


def convert_conversation(mnemo_conv, index_entry=None):
    """Convert a full mnemo conversation to Exocortex format."""
    conv_id = mnemo_conv["id"]
    title = mnemo_conv.get("title", "")
    model = mnemo_conv.get("model", "opus")

    # Get pinned/marked status from index if available
    pinned = False
    marked = False
    sort_order = 0
    if index_entry:
        pinned = index_entry.get("pinned", False)
        marked = index_entry.get("marked", False)
        sort_order = index_entry.get("order", 0)

    messages = convert_messages(mnemo_conv.get("messages", []))

    # Compute timestamps
    created_at = mnemo_conv.get("createdAt")
    updated_at = mnemo_conv.get("updatedAt")
    # If createdAt/updatedAt aren't in the file, derive from ID (timestamp-random)
    if not created_at:
        try:
            created_at = int(conv_id.split("-")[0])
        except (ValueError, IndexError):
            created_at = 0
    if not updated_at:
        updated_at = created_at
    # Convert ISO strings to epoch ms if needed
    if isinstance(created_at, str):
        from datetime import datetime
        created_at = int(datetime.fromisoformat(created_at.replace("Z", "+00:00")).timestamp() * 1000)
    if isinstance(updated_at, str):
        from datetime import datetime
        updated_at = int(datetime.fromisoformat(updated_at.replace("Z", "+00:00")).timestamp() * 1000)

    return {
        "version": CURRENT_VERSION,
        "id": conv_id,
        "model": model,
        "effort": DEFAULT_EFFORT,
        "messages": messages,
        "createdAt": created_at,
        "updatedAt": updated_at,
        "lastContextTokens": mnemo_conv.get("contextTokens", None),
        "marked": marked,
        "pinned": pinned,
        "sortOrder": sort_order,
        "title": title,
    }


def save_exocortex_conversation(conv, dry_run=False):
    """Save a converted conversation to the Exocortex directory."""
    dest = EXOCORTEX_DIR / f"{conv['id']}.json"
    if dry_run:
        print(f"  [DRY RUN] Would write {dest}")
        return

    os.makedirs(EXOCORTEX_DIR, exist_ok=True)

    # Atomic write
    tmp = str(dest) + ".tmp"
    with open(tmp, "w") as f:
        json.dump(conv, f, indent=2, ensure_ascii=False)
    os.rename(tmp, str(dest))
    print(f"  ✓ Saved {dest}")


def main():
    parser = argparse.ArgumentParser(description="Port mnemo conversations to Exocortex")
    parser.add_argument("titles", nargs="*", help="Conversation titles to port (case-insensitive match)")
    parser.add_argument("--id", action="append", default=[], help="Port by conversation ID")
    parser.add_argument("--all-pinned", action="store_true", help="Port all pinned conversations")
    parser.add_argument("--dry-run", action="store_true", help="Don't write files, just show what would happen")
    parser.add_argument("--validate", action="store_true", help="Validate message structure after conversion")
    args = parser.parse_args()

    # Load index
    index = load_mnemo_index()
    index_map = {entry["id"]: entry for entry in index}

    # Resolve which conversations to port
    to_port = []

    if args.all_pinned:
        for entry in index:
            if entry.get("pinned"):
                to_port.append(entry)

    for title in args.titles:
        title_lower = title.lower()
        found = False
        for entry in index:
            if entry.get("title", "").lower() == title_lower:
                to_port.append(entry)
                found = True
                break
        if not found:
            # Try partial match
            matches = [e for e in index if title_lower in e.get("title", "").lower()]
            if len(matches) == 1:
                to_port.append(matches[0])
                found = True
            elif len(matches) > 1:
                print(f"⚠ Ambiguous title '{title}', matches: {[m['title'] for m in matches]}")
                continue
            else:
                print(f"✗ Title not found: '{title}'")

    for conv_id in args.id:
        if conv_id in index_map:
            to_port.append(index_map[conv_id])
        else:
            # Try loading directly even if not in index
            path = MNEMO_DIR / f"{conv_id}.json"
            if path.exists():
                to_port.append({"id": conv_id, "title": f"(id: {conv_id})"})
            else:
                print(f"✗ ID not found: {conv_id}")

    # Deduplicate
    seen = set()
    unique = []
    for entry in to_port:
        if entry["id"] not in seen:
            seen.add(entry["id"])
            unique.append(entry)
    to_port = unique

    if not to_port:
        print("Nothing to port. Use --all-pinned, provide titles, or use --id.")
        parser.print_help()
        return 1

    print(f"Porting {len(to_port)} conversation(s):\n")

    errors = 0
    for entry in to_port:
        conv_id = entry["id"]
        title = entry.get("title", conv_id)
        print(f"── {title} ({conv_id})")

        try:
            mnemo_conv = load_mnemo_conversation(conv_id)
        except FileNotFoundError:
            print(f"  ✗ File not found: {MNEMO_DIR / f'{conv_id}.json'}")
            errors += 1
            continue
        except json.JSONDecodeError as e:
            print(f"  ✗ JSON parse error: {e}")
            errors += 1
            continue

        msg_count = len(mnemo_conv.get("messages", []))
        print(f"  Source: {msg_count} mnemo messages")

        exo_conv = convert_conversation(mnemo_conv, index_map.get(conv_id))
        exo_msg_count = len(exo_conv["messages"])
        print(f"  Converted: {exo_msg_count} exocortex messages")

        if args.validate or True:  # Always validate
            issues = validate_messages(exo_conv["messages"])
            if issues:
                print(f"  ⚠ Validation issues:")
                for issue in issues[:10]:
                    print(f"    {issue}")
                if len(issues) > 10:
                    print(f"    ... and {len(issues) - 10} more")

        # Check if already exists
        dest = EXOCORTEX_DIR / f"{conv_id}.json"
        if dest.exists():
            print(f"  ⚠ Already exists at {dest} — overwriting")

        save_exocortex_conversation(exo_conv, dry_run=args.dry_run)
        print()

    if errors:
        print(f"\n{errors} error(s) occurred.")
        return 1

    print(f"Done! Ported {len(to_port)} conversation(s).")
    return 0


if __name__ == "__main__":
    sys.exit(main() or 0)
