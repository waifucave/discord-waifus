"""Optional host-local native-choice worker. No provider credentials or shell commands."""
import argparse
import contextlib
import json
import os
import sys

os.environ["USE_TF"] = "0"
parser = argparse.ArgumentParser()
parser.add_argument("--checkpoint", choices=["english", "multilingual", "typed-decisions"], required=True)
args = parser.parse_args()
with contextlib.redirect_stdout(sys.stderr):
    import laya
    import torch
    from huggingface_hub import snapshot_download
    from laya.common import serialize_state
    torch.set_num_threads(2)
    subfolder = "" if args.checkpoint == "english" else args.checkpoint + "/"
    local = snapshot_download("convaiinnovations/laya", revision="7b928d828b7b0e022f929d9bd2e44165aa270148", allow_patterns=[
        subfolder + name for name in ["rl_agent_config.json", "model.safetensors", "tokenizer/*", "encoder/*"]
    ])
    agent = laya.load(local, subfolder=subfolder.rstrip("/") or None, device="cpu")
print(json.dumps({"ready": True}), flush=True)
for line in sys.stdin:
    try:
        if len(line) > 1_000_000:
            raise ValueError("request_too_large")
        request = json.loads(line)
        ids = list(request["questions"])
        internal = {key: agent._to_internal(request["questions"][key]) for key in ids}
        state_tokens = agent.tok(serialize_state(request["state"]).replace(agent.tok.mask_token, " "),
                                 add_special_tokens=False)["input_ids"]
        probe = agent._encode_state(request["state"], ids, internal, max_len=8192, head_max_len=256)
        max_len = 8192 if args.checkpoint == "multilingual" else agent.cfg.get("max_len", 512)
        truncated = any(len(row["ids"]) > max_len for row in probe) or len(state_tokens) > 8192
        if truncated:
            print(json.dumps({"truncated": True}), flush=True)
            continue
        with contextlib.redirect_stdout(sys.stderr):
            result = agent.predict(request["state"], request["questions"], max_len=max_len, head_max_len=256)
        print(json.dumps({"payload": result, "truncated": False}), flush=True)
    except Exception:
        print(json.dumps({"error": "inference_failed"}), flush=True)
