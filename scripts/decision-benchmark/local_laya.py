"""Local JSONL benchmark worker. Public weights, pinned revision, no credentials needed."""
import argparse
import contextlib
import json
import os
import sys
import time

os.environ["USE_TF"] = "0"
os.environ["HF_HUB_DISABLE_PROGRESS_BARS"] = "1"
parser = argparse.ArgumentParser()
parser.add_argument("--checkpoint", choices=["english", "multilingual", "typed-decisions"], required=True)
parser.add_argument("--device", default="cpu")
args = parser.parse_args()
started = time.perf_counter()
# Keep library diagnostics out of the machine-readable stdout protocol.
with contextlib.redirect_stdout(sys.stderr):
    import laya
    import torch
    from huggingface_hub import HfApi, snapshot_download
    from laya.common import serialize_state
    torch.set_num_threads(4)
    subfolder = "" if args.checkpoint == "english" else args.checkpoint + "/"
    revision = HfApi().model_info("convaiinnovations/laya").sha
    local = snapshot_download("convaiinnovations/laya", revision=revision, allow_patterns=[
        subfolder + name for name in ["rl_agent_config.json", "model.safetensors", "tokenizer/*", "encoder/*"]
    ])
    agent = laya.load(local, subfolder=subfolder.rstrip("/") or None, device=args.device)
print(json.dumps({"ready": True, "revision": revision, "runtime": laya.__version__,
                  "device": str(agent.device), "loadMs": (time.perf_counter() - started) * 1000}), flush=True)
for line in sys.stdin:
    try:
        request = json.loads(line)
        # Measure full encoding + inference; explicitly detect context clipping per question.
        ids = list(request["questions"])
        internal = {key: agent._to_internal(request["questions"][key]) for key in ids}
        state_tokens = agent.tok(serialize_state(request["state"]).replace(agent.tok.mask_token, " "),
                                 add_special_tokens=False)["input_ids"]
        probe = agent._encode_state(request["state"], ids, internal, max_len=8192,
                                     head_max_len=256)
        max_len = 8192 if args.checkpoint == "multilingual" else agent.cfg.get("max_len", 512)
        truncated = any(len(row["ids"]) > max_len for row in probe) or len(state_tokens) > 8192
        before = time.perf_counter()
        with contextlib.redirect_stdout(sys.stderr):
            result = agent.predict(request["state"], request["questions"], max_len=max_len,
                                   head_max_len=256)
        print(json.dumps({"payload": result, "latencyMs": (time.perf_counter() - before) * 1000,
                          "truncated": truncated}), flush=True)
    except Exception as error:
        # Never dump request data or unrestricted exception strings.
        print(json.dumps({"error": type(error).__name__}), flush=True)
