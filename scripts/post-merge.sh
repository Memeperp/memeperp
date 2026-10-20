#!/usr/bin/env bash
set -euo pipefail

# Reconcile the merged lockfile before the running workflow restarts.
npm ci --no-audit --no-fund