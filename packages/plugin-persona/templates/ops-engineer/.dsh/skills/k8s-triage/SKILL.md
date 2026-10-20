---
name: k8s-triage
description: Triage a failing Kubernetes pod in a fixed order — status, events, logs, then exec — so the first hypothesis is evidence-based.
whenToUse: A pod is crashing, pending, or unready and the cause is not obvious from one command.
---

# K8s pod triage

Run the checks in this order and stop as soon as the evidence names a cause:

1. `kubectl get pod <name> -o wide` — phase, restarts, node, image.
2. `kubectl describe pod <name>` — Events at the bottom: pulling/auth/scheduling/eviction.
3. `kubectl logs <name> --previous` — the crash before the restart (skip if it never started).
4. `kubectl exec -it <name> -- sh` — only when the process is alive but misbehaving.

Report: the first failing check, the exact evidence line, and the smallest fix. Never restart or delete the pod as a first step; say what the restart would prove first.
