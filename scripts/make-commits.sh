#!/usr/bin/env bash
# Batch-commit the working tree per docs/CHANGES-2026-09.md (提交计划表).
#
# Files were changed across many rounds and several files carry several
# rounds' edits at once, so the plan is regrouped into file-disjoint commits:
#   1. kernel upgrade + verified patch tooling        (rows 1/6/6b/12-tool)
#   2. wrapper main.js hardening                      (rows 6/12/13 + deeplink bridge)
#   3. adapters & utils code review                   (rows 7..14b)
#   4. window / display / touch-mode / deeplink       (rows 2/3/4/4b/5/5b/5c/11/13/14/15)
#   5. docs + CI release pipeline
#
# web_engine/BuildProfile.ets is auto-generated locally (signing credentials)
# and is NEVER committed - the script aborts if it is staged.
#
# Usage: bash scripts/make-commits.sh   (run from the repository root)
set -euo pipefail

commit() {
  local msg="$1"; shift
  git add -- "$@"
  if git diff --cached --name-only | grep -q '^web_engine/BuildProfile\.ets$'; then
    echo "ABORT: web_engine/BuildProfile.ets must not be committed (local signing data)." >&2
    git reset -q
    exit 1
  fi
  if git diff --cached --quiet; then
    echo "skip (nothing staged): $msg"
    return
  fi
  git commit -m "$msg" -m "See docs/CHANGES-2026-09.md for the full change plan and rationale."
}

# 1. Kernel upgrade + patch tooling (LFS-tracked asar included)
# Note: scripts/package-lock.json is intentionally gitignored in this repo.
commit "feat(kernel): upgrade Obsidian 1.12.7 -> 1.13.7 with verified patch tooling" \
  web_engine/src/main/resources/resfile/resources/app/obsidian.asar \
  web_engine/src/main/resources/resfile/resources/app/package.json \
  README.md README_EN.md \
  scripts/update-obsidian.mjs scripts/cert-obsidian.pem scripts/extract-cert.cjs \
  scripts/balance-check.cjs scripts/package.json \
  .gitignore

# 2. Wrapper main.js (runs outside the signed asar)
commit "fix(wrapper): harden app/main.js (side-load removal, trash fallback, crash guard, deeplink bridge)" \
  web_engine/src/main/resources/resfile/resources/app/main.js

# 3. Adapters & utils review fixes
commit "fix(review): adapters robustness, security and resource handling" \
  web_engine/src/main/ets/adapter \
  web_engine/src/main/ets/common \
  web_engine/src/main/ets/utils/StringUtil.ts \
  electron/src/main/ets/pages/QuickLoginButtonComponent.ets \
  electron/obfuscation-rules.txt electron/oh-package-lock.json5 \
  web_engine/obfuscation-rules.txt web_engine/oh-package-lock.json5 \
  web_engine/oh-package.json5

# 4. Window / display / touch-mode / deeplink
commit "feat(window): system-managed bars, surface-ready browser start, touch-mode sync, obsidian:// deeplink" \
  web_engine/src/main/ets/ability/WebAbility.ets \
  web_engine/src/main/ets/components/WebWindow.ets \
  web_engine/src/main/ets/components/WebWindowNode.ets \
  web_engine/src/main/ets/components/WebSubWindow.ets \
  web_engine/src/main/ets/components/WebEmbeddedWindow.ets \
  web_engine/src/main/ets/utils/SurfaceReady.ets \
  web_engine/src/main/ets/utils/LaunchHelper.ets \
  web_engine/src/main/ets/utils/EngineFlags.ets \
  web_engine/src/main/resources/resfile/resources/app/ohsidian-flags.json \
  web_engine/src/main/ets/adapter/AppWindowAdapter.ets \
  web_engine/src/main/ets/adapter/SubWindowAdapter.ets \
  electron/src/main/ets/pages/Index.ets \
  electron/src/main/ets/pages/WindowNode.ets \
  electron/src/main/module.json5 \
  build-profile.example.json5

# 5. Docs + CI (includes scripts/make-commits.sh itself)
commit "docs(ci): change plan, release pipeline, env guide, batch-commit helper" \
  docs .github scripts/make-commits.sh

echo
echo "Done. Review with 'git log --oneline', then push manually:"
echo "  git push origin <branch>"
echo "  git tag v1.1.0 && git push origin v1.1.0   # triggers the release build"
