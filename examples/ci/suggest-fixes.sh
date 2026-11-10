#!/usr/bin/env bash
# Suggests a fix for every service.json that flisk rejects, next to the file as service.json.suggested.
# Needs FLISK_INFERENCE_KEY (an API key from inference.flisk.si), curl and jq.
set -euo pipefail
API="${FLISK_INFERENCE_URL:-https://inference.flisk.si/v1}"
report=$(flisk config verify --json 2>/dev/null || true)
echo "$report" | jq -r '.data.errors[]?' | sed -E 's/(service\.json)\..*/\1/' | sort -u | while read -r file; do
  errors=$(echo "$report" | jq -r --arg f "$file" '.data.errors[] | select(startswith($f))')
  prompt=$(printf 'This Flisk service.json is rejected:\n%s\n\nThe validator says:\n%s\n\nFix it with the smallest change that makes it valid, keeping every other field. Reply with the corrected JSON object only.' "$(cat "$file")" "$errors")
  curl -sf "$API/chat/completions" -H "authorization: Bearer ${FLISK_INFERENCE_KEY:-}" -H 'content-type: application/json' \
    -d "$(jq -n --arg p "$prompt" '{model: "flisk-wolf", messages: [{role: "user", content: $p}]}')" \
    | jq -r '.choices[0].message.content' | sed -E '/^```/d' > "$file.suggested"
  echo "Suggested fix for $file:"
  diff -u "$file" "$file.suggested" || true
done
