#!/usr/bin/env bash
# Fixture tests for scripts/install.sh. They do not use network or native payloads.
# shellcheck disable=SC2016,SC2094
set -uo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
INSTALLER="$ROOT/scripts/install.sh"
tests_run=0
tests_failed=0
case_dir=""
tmp_root=/tmp
[ -n "${TMPDIR-}" ] && tmp_root="$TMPDIR"

pass_test() {
  tests_run=$((tests_run + 1))
  printf 'ok %d - %s\n' "$tests_run" "$1"
}
fail_test() {
  tests_run=$((tests_run + 1))
  tests_failed=$((tests_failed + 1))
  printf 'not ok %d - %s\n  %s\n' "$tests_run" "$1" "$2"
}
cleanup_case() {
  [ -z "$case_dir" ] || rm -rf "$case_dir"
  case_dir=""
}
new_case() {
  cleanup_case
  case_dir="$(mktemp -d "$tmp_root/tailchrome-bootstrap-test.XXXXXX")"
  mkdir "$case_dir/bin" "$case_dir/home"
  for command_name in mktemp mkdir rmdir rm chmod sha256sum sed tr cp ln mv; do
    ln -s "$(command -v "$command_name")" "$case_dir/bin/$command_name"
  done
  mkdir "$case_dir/bin-no-sha"
  for command_name in bash env uname mktemp mkdir rmdir rm chmod sed tr cp ln mv; do
    ln -s "$(command -v "$command_name")" "$case_dir/bin-no-sha/$command_name"
  done
  cat >"$case_dir/bin-no-sha/shasum" <<'STUB'
#!/bin/sh
exec /usr/bin/sha256sum "$3"
STUB
  chmod 755 "$case_dir/bin-no-sha/shasum"
  cat >"$case_dir/bin/uname" <<'STUB'
#!/bin/sh
case "$1" in
  -s) printf '%s\n' "$TEST_SYSTEM" ;;
  -m) printf '%s\n' "$TEST_MACHINE" ;;
  *) exit 2 ;;
esac
STUB
  chmod 755 "$case_dir/bin/uname"
  cat >"$case_dir/bin/curl" <<'STUB'
#!/bin/sh
set -eu
output=""
url=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    --output) output="$2"; shift 2 ;;
    http*) url="$1"; shift ;;
    *) shift ;;
  esac
done
printf '%s\n' "$url" >>"$TEST_CURL_LOG"
case "$url" in
  */tailchrome-install.sh)
    /bin/cat "$TEST_INSTALLER_SOURCE"
    ;;
  */releases/latest)
    [ "$TEST_LATEST_FAIL" = 0 ] || exit 22
    printf '%s\n' "$TEST_LATEST_RESPONSE" >"$output"
    ;;
  */SHA256SUMS.txt)
    [ "$TEST_CHECKSUM_FAIL" = 0 ] || exit 22
    cp "$TEST_MANIFEST" "$output"
    ;;
  *)
    [ "$TEST_ARTIFACT_FAIL" = 0 ] || exit 22
    cp "$TEST_ARTIFACT" "$output"
    ;;
esac
STUB
  chmod 755 "$case_dir/bin/curl"
  ln -s "$case_dir/bin/curl" "$case_dir/bin-no-sha/curl"
  export TEST_SYSTEM=Linux TEST_MACHINE=x86_64 TEST_LATEST_RESPONSE='{"tag_name":"v9.8.7"}'
  export TEST_LATEST_FAIL=0 TEST_CHECKSUM_FAIL=0 TEST_ARTIFACT_FAIL=0
  export TEST_REGISTER_FAIL=0 TEST_UNREGISTER_FAIL=0 TEST_SIGNAL=0
}
fixture_path() {
  if [ "${TEST_SHASUM_ONLY-0}" = 1 ]; then
    printf '%s\n' "$case_dir/bin-no-sha"
  else
    printf '%s:/usr/bin:/bin\n' "$case_dir/bin"
  fi
}
write_helper() {
  local path="$1"
  local body="${2-}"
  cat >"$path" <<STUB
#!/bin/sh
set -eu
printf '%s\n' "\$*" >>"\$TEST_EXEC_LOG"
if [ "\$1" = install ] && [ ! -f "\$3" ]; then
  printf '%s\n' 'binary path did not exist at registration' >&2
  exit 71
fi
if [ "\$1" = uninstall ] && [ "\$TEST_UNREGISTER_FAIL" = 1 ]; then
  exit 8
fi
$body
STUB
  chmod 755 "$path"
}
make_manifest() {
  local digest
  digest="$(sha256sum "$case_dir/artifact" | cut -d' ' -f1)"
  printf '%s  tailscale-browser-ext-linux-amd64\n' "$digest" >"$case_dir/manifest"
}
run_install() {
  HOME="$case_dir/home" TEST_CURL_LOG="$case_dir/curl.log" \
    TEST_MANIFEST="$case_dir/manifest" TEST_ARTIFACT="$case_dir/artifact" \
    TEST_EXEC_LOG="$case_dir/exec.log" TEST_INSTALLER_SOURCE="$INSTALLER" \
    TMPDIR="$case_dir" PATH="$(fixture_path)" \
    "$INSTALLER" "$@"
}
run_streamed_install() {
  HOME="$case_dir/home" TEST_CURL_LOG="$case_dir/curl.log" \
    TEST_MANIFEST="$case_dir/manifest" TEST_ARTIFACT="$case_dir/artifact" \
    TEST_EXEC_LOG="$case_dir/exec.log" TEST_INSTALLER_SOURCE="$INSTALLER" \
    TMPDIR="$case_dir" PATH="$(fixture_path)" \
    bash -s -- "$@" <"$INSTALLER"
}
run_saved_install() {
  local saved_path="$1"
  shift
  HOME="$case_dir/home" TEST_CURL_LOG="$case_dir/curl.log" \
    TEST_MANIFEST="$case_dir/manifest" TEST_ARTIFACT="$case_dir/artifact" \
    TEST_EXEC_LOG="$case_dir/exec.log" TEST_INSTALLER_SOURCE="$INSTALLER" \
    TMPDIR="$case_dir" PATH="$(fixture_path)" \
    bash "$saved_path" "$@"
}
extract_removal_command() {
  printf '%s\n' "$1" | sed -n 's/^  //p' | tail -n 1
}
run_removal_command() {
  local command="$1"
  HOME="$case_dir/home" TEST_CURL_LOG="$case_dir/curl.log" \
    TEST_MANIFEST="$case_dir/manifest" TEST_ARTIFACT="$case_dir/artifact" \
    TEST_EXEC_LOG="$case_dir/exec.log" TEST_INSTALLER_SOURCE="$INSTALLER" \
    TEST_UNREGISTER_FAIL="$TEST_UNREGISTER_FAIL" TMPDIR="$case_dir" PATH="$(fixture_path)" \
    bash -c "$command"
}
expect_failure() {
  local label="$1"
  shift
  local output
  if output="$(run_install "$@" 2>&1)"; then
    fail_test "$label" 'installer unexpectedly succeeded'
  else
    pass_test "$label"
  fi
}

test_latest_same_tag() {
  new_case
  write_helper "$case_dir/artifact"
  make_manifest
  local output urls final
  final="$case_dir/home/.local/bin/tailchrome"
  if output="$(run_install 2>&1)"; then
    urls="$(cat "$case_dir/curl.log")"
    if [[ "$urls" == *releases/latest* && "$urls" == *"/download/v9.8.7/SHA256SUMS.txt"* &&
      "$urls" == *"/download/v9.8.7/tailscale-browser-ext-linux-amd64"* &&
      -x "$final" && "$(cat "$case_dir/exec.log")" == "install --binary-path $final" ]]; then
      pass_test 'resolves latest once and uses the same tag for checksum and binary'
    else
      fail_test 'resolves latest once and uses the same tag for checksum and binary' "$output / $urls"
    fi
  else
    fail_test 'resolves latest once and uses the same tag for checksum and binary' "$output"
  fi
}
test_safe_inputs() {
  new_case
  expect_failure 'rejects unsafe explicit version' --version 'v1.2.3/../../evil'
  new_case
  TEST_LATEST_RESPONSE='{"tag_name":"v1.2.3/evil"}' expect_failure 'rejects unsafe latest tag'
  new_case
  write_helper "$case_dir/artifact"
  printf '%064d  ../tailscale-browser-ext-linux-amd64\n' 0 >"$case_dir/manifest"
  expect_failure 'rejects traversal checksum filename' --version v1.2.3
  new_case
  write_helper "$case_dir/artifact"
  printf '%064d  tailscale-browser-ext-linux-amd64\n%064d  tailscale-browser-ext-linux-amd64\n' 0 1 >"$case_dir/manifest"
  expect_failure 'rejects duplicate checksum entry' --version v1.2.3
}
test_never_executes_bad_artifact() {
  new_case
  write_helper "$case_dir/artifact" 'printf "%s\n" ran >"$TEST_RAN"'
  printf '%064d  tailscale-browser-ext-linux-amd64\n' 0 >"$case_dir/manifest"
  export TEST_RAN="$case_dir/ran"
  local output
  if output="$(run_install --version v1.2.3 2>&1)"; then
    fail_test 'does not execute checksum-mismatched artifact' 'installer unexpectedly succeeded'
  elif [ ! -e "$TEST_RAN" ] && [[ "$output" == *'checksum verification failed'* ]]; then
    pass_test 'does not execute checksum-mismatched artifact'
  else
    fail_test 'does not execute checksum-mismatched artifact' "$output"
  fi
}
test_rollbacks() {
  new_case
  write_helper "$case_dir/artifact" 'if [ "$TEST_REGISTER_FAIL" = 1 ]; then exit 9; fi'
  make_manifest
  local final="$case_dir/home/.local/bin/tailchrome" output
  mkdir -p "$(dirname "$final")"
  printf '%s\n' old-binary >"$final"; chmod 755 "$final"
  if output="$(TEST_REGISTER_FAIL=1 run_install --version v1.2.3 2>&1)"; then
    fail_test 'rolls back failed registration' 'installer unexpectedly succeeded'
  elif [ "$(cat "$final")" = old-binary ] && [[ "$output" == *registration\ failed* ]]; then
    pass_test 'rolls back failed registration'
  else
    fail_test 'rolls back failed registration' "$output"
  fi
  new_case
  write_helper "$case_dir/artifact" 'if [ "$TEST_REGISTER_FAIL" = 1 ]; then exit 9; fi'
  make_manifest
  if output="$(TEST_REGISTER_FAIL=1 run_install --version v1.2.3 2>&1)"; then
    fail_test 'removes failed first-install binary' 'installer unexpectedly succeeded'
  elif [ ! -e "$case_dir/home/.local/bin/tailchrome" ]; then
    pass_test 'removes failed first-install binary'
  else
    fail_test 'removes failed first-install binary' "$output"
  fi
}
test_signal_and_activation_failures() {
  new_case
  write_helper "$case_dir/artifact" 'if [ "$TEST_SIGNAL" = TERM ] && [ "$1" = install ]; then kill -TERM "$PPID"; fi'
  make_manifest
  local final="$case_dir/home/.local/bin/tailchrome" output status
  mkdir -p "$(dirname "$final")"
  printf '%s\n' old-binary >"$final"; chmod 755 "$final"
  set +e
  output="$(TEST_SIGNAL=TERM run_install --version v1.2.3 2>&1)"
  status=$?
  if [ "$status" -eq 143 ] && [ "$(cat "$final")" = old-binary ] &&
    [ ! -e "$case_dir/home/.local/bin/.tailchrome-install.lock" ]; then
    pass_test 'restores the prior executable after an injected signal during registration'
  else
    fail_test 'restores the prior executable after an injected signal during registration' "$output (status $status)"
  fi

  new_case
  write_helper "$case_dir/artifact"; make_manifest
  final="$case_dir/home/.local/bin/tailchrome"
  mkdir -p "$(dirname "$final")"
  printf '%s\n' old-binary >"$final"; chmod 755 "$final"
  rm -f "$case_dir/bin/mv"
  cat >"$case_dir/bin/mv" <<'STUB'
#!/bin/sh
exit 77
STUB
  chmod 755 "$case_dir/bin/mv"
  if output="$(run_install --version v1.2.3 2>&1)"; then
    fail_test 'preserves the old path when activation rename fails' 'installer unexpectedly succeeded'
  elif [ "$(cat "$final")" = old-binary ] && [[ "$output" == *'could not activate verified helper'* ]]; then
    pass_test 'preserves the old path when activation rename fails'
  else
    fail_test 'preserves the old path when activation rename fails' "$output"
  fi

  new_case
  write_helper "$case_dir/artifact" 'if [ "$TEST_REGISTER_FAIL" = 1 ]; then exit 9; fi'; make_manifest
  final="$case_dir/home/.local/bin/tailchrome"
  mkdir -p "$(dirname "$final")"
  printf '%s\n' old-binary >"$final"; chmod 755 "$final"
  rm -f "$case_dir/bin/mv"
  cat >"$case_dir/bin/mv" <<'STUB'
#!/bin/sh
count_file="$TEST_MV_COUNT"
count=0
[ -f "$count_file" ] && count=$(cat "$count_file")
count=$((count + 1))
printf '%s\n' "$count" >"$count_file"
[ "$count" -lt 2 ] || exit 99
exec /bin/mv "$@"
STUB
  chmod 755 "$case_dir/bin/mv"
  if output="$(TEST_MV_COUNT="$case_dir/mv.count" TEST_REGISTER_FAIL=1 run_install --version v1.2.3 2>&1)"; then
    fail_test 'retains recovery data when rollback rename fails' 'installer unexpectedly succeeded'
  elif [[ "$output" == *'recovery copy was retained'* ]] &&
    find "$case_dir/home/.local/bin" -maxdepth 1 -name '.tailchrome-backup.*' -print -quit | grep -q .; then
    pass_test 'retains recovery data when rollback rename fails'
  else
    fail_test 'retains recovery data when rollback rename fails' "$output"
  fi
}
test_uninstall() {
  new_case
  local final="$case_dir/home/.local/bin/tailchrome" output
  mkdir -p "$(dirname "$final")"
  write_helper "$final" 'if [ "$TEST_UNREGISTER_FAIL" = 1 ]; then exit 8; fi'
  if output="$(TEST_UNREGISTER_FAIL=1 run_install --uninstall 2>&1)"; then
    fail_test 'keeps binary when unregister fails' 'uninstaller unexpectedly succeeded'
  elif [ -x "$final" ]; then
    pass_test 'keeps binary when unregister fails'
  else
    fail_test 'keeps binary when unregister fails' "$output"
  fi
  if output="$(run_install --uninstall 2>&1)" && [ ! -e "$final" ]; then
    pass_test 'removes stable binary only after unregister exits'
  else
    fail_test 'removes stable binary only after unregister exits' "$output"
  fi
}
test_uninstall_guidance_streamed() {
  new_case
  write_helper "$case_dir/artifact"
  make_manifest
  local custom_bin="$case_dir/custom bin/owner's helper" output command final
  mkdir -p "$custom_bin"
  if ! output="$(run_streamed_install --version v1.2.3 --bin-dir "$custom_bin" 2>&1)"; then
    fail_test 'streamed Bash guidance executes pinned removal with quoted custom directory' "$output"
    return
  fi
  command="$(extract_removal_command "$output")"
  if [[ "$command" != curl\ *"github.com/dantraynor/tailchrome/releases/download/v1.2.3/tailchrome-install.sh"* ]]; then
    fail_test 'streamed Bash guidance executes pinned removal with quoted custom directory' "$output / $command"
    return
  fi
  final="$custom_bin/tailchrome"
  if output="$(TEST_UNREGISTER_FAIL=1 run_removal_command "$command" 2>&1)"; then
    fail_test 'streamed Bash guidance preserves binary when unregister fails' 'removal unexpectedly succeeded'
  elif [ -x "$final" ] && grep -q 'uninstall --binary-path' "$case_dir/exec.log"; then
    pass_test 'streamed Bash guidance preserves binary when unregister fails'
  else
    fail_test 'streamed Bash guidance preserves binary when unregister fails' "$output"
  fi
  if output="$(TEST_UNREGISTER_FAIL=0 run_removal_command "$command" 2>&1)" && [ ! -e "$final" ]; then
    pass_test 'streamed Bash guidance executes pinned removal with quoted custom directory'
  else
    fail_test 'streamed Bash guidance executes pinned removal with quoted custom directory' "$output"
  fi
}
test_uninstall_guidance_saved() {
  new_case
  write_helper "$case_dir/artifact"
  make_manifest
  local saved_path="$case_dir/saved installer 'copy/install.sh"
  local custom_bin="$case_dir/custom bin/owner's helper" output command final
  mkdir -p "$(dirname "$saved_path")" "$custom_bin"
  cp "$INSTALLER" "$saved_path"
  chmod 755 "$saved_path"
  if ! output="$(run_saved_install "$saved_path" --version v1.2.3 --bin-dir "$custom_bin" 2>&1)"; then
    fail_test 'saved Bash guidance uses absolute quoted installer path' "$output"
    return
  fi
  command="$(extract_removal_command "$output")"
  local saved_absolute
  saved_absolute="$(cd "$(dirname "$saved_path")" && pwd -P)/$(basename "$saved_path")"
  if [[ "$saved_absolute" != /* ]] ||
    [[ "$command" != bash\ * ]] ||
    [[ "$command" != *"saved installer"* ]] ||
    [[ "$command" != *"copy/install.sh"* ]] ||
    [[ "$command" != *"--version 'v1.2.3' --bin-dir '"* ]]; then
    fail_test 'saved Bash guidance uses absolute quoted installer path' "$output / $command"
    return
  fi
  final="$custom_bin/tailchrome"
  if output="$(TEST_UNREGISTER_FAIL=1 run_removal_command "$command" 2>&1)"; then
    fail_test 'saved Bash guidance preserves binary when unregister fails' 'removal unexpectedly succeeded'
  elif [ -x "$final" ] && grep -q 'uninstall --binary-path' "$case_dir/exec.log"; then
    pass_test 'saved Bash guidance preserves binary when unregister fails'
  else
    fail_test 'saved Bash guidance preserves binary when unregister fails' "$output"
  fi
  if output="$(TEST_UNREGISTER_FAIL=0 run_removal_command "$command" 2>&1)" && [ ! -e "$final" ]; then
    pass_test 'saved Bash guidance uses absolute quoted installer path'
  else
    fail_test 'saved Bash guidance uses absolute quoted installer path' "$output"
  fi
}
test_migration_and_lock() {
  new_case
  write_helper "$case_dir/artifact"; make_manifest
  local legacy="$case_dir/home/.local/share/tailscale/browser-ext/tailscale-browser-ext"
  mkdir -p "$(dirname "$legacy")" "$case_dir/home/.config/tailchrome"
  printf legacy >"$legacy"; printf state >"$case_dir/home/.config/tailchrome/node"
  if run_install --version v1.2.3 >/dev/null 2>&1 &&
    [ -e "$legacy" ] && [ -e "$case_dir/home/.config/tailchrome/node" ]; then
    pass_test 'preserves legacy runtime files and unrelated state during migration'
  else
    fail_test 'preserves legacy runtime files and unrelated state during migration' 'legacy or state handling was unsafe'
  fi
  new_case
  mkdir -p "$case_dir/home/.local/bin/.tailchrome-install.lock"
  expect_failure 'rejects concurrent installation'
  rmdir "$case_dir/home/.local/bin/.tailchrome-install.lock"
  write_helper "$case_dir/artifact"; make_manifest
  if run_install --version v1.2.3 >/dev/null 2>&1 &&
    [ ! -e "$case_dir/home/.local/bin/.tailchrome-install.lock" ]; then
    pass_test 'cleans the lock after installation'
  else
    fail_test 'cleans the lock after installation' 'lock remained'
  fi
}
test_failures() {
  new_case; write_helper "$case_dir/artifact"; make_manifest
  TEST_CHECKSUM_FAIL=1 expect_failure 'reports checksum download failure' --version v1.2.3
  new_case; write_helper "$case_dir/artifact"; make_manifest
  TEST_ARTIFACT_FAIL=1 expect_failure 'reports artifact download failure' --version v1.2.3
}
test_provenance_and_shasum() {
  new_case
  write_helper "$case_dir/artifact"; make_manifest
  cat >"$case_dir/bin/gh" <<'STUB'
#!/bin/sh
case "$*" in
  'attestation verify --help') [ "$TEST_GH_MODE" != unavailable ] ;;
  'auth status --hostname github.com') [ "$TEST_GH_MODE" = authenticated ] ;;
  attestation\ verify\ *) [ "$TEST_GH_MODE" != failure ] ;;
  *) exit 2 ;;
esac
STUB
  chmod 755 "$case_dir/bin/gh"
  export TEST_GH_MODE=authenticated
  if run_install --version v1.2.3 >/dev/null 2>&1; then
    pass_test 'verifies GitHub attestation when available'
  else
    fail_test 'verifies GitHub attestation when available' 'authenticated attestation path failed'
  fi
  new_case
  write_helper "$case_dir/artifact"; make_manifest
  cat >"$case_dir/bin/gh" <<'STUB'
#!/bin/sh
case "$*" in
  'attestation verify --help') exit 0 ;;
  'auth status --hostname github.com') exit 1 ;;
  *) exit 2 ;;
esac
STUB
  chmod 755 "$case_dir/bin/gh"
  local output
  if output="$(run_install --version v1.2.3 2>&1)" && [[ "$output" == *'trust boundary'* ]]; then
    pass_test 'warns and continues when GitHub CLI is unauthenticated'
  else
    fail_test 'warns and continues when GitHub CLI is unauthenticated' "$output"
  fi
  new_case
  write_helper "$case_dir/artifact"; make_manifest
  cat >"$case_dir/bin/gh" <<'STUB'
#!/bin/sh
case "$*" in
  'attestation verify --help') exit 0 ;;
  'auth status --hostname github.com') exit 0 ;;
  attestation\ verify\ *) exit 1 ;;
  *) exit 2 ;;
esac
STUB
  chmod 755 "$case_dir/bin/gh"
  if output="$(run_install --version v1.2.3 2>&1)"; then
    fail_test 'stops on failed GitHub attestation' 'installer unexpectedly succeeded'
  elif [[ "$output" == *'attestation verification failed'* ]]; then
    pass_test 'stops on failed GitHub attestation'
  else
    fail_test 'stops on failed GitHub attestation' "$output"
  fi
  new_case
  write_helper "$case_dir/artifact"; make_manifest
  export TEST_SHASUM_ONLY=1
  local output
  if output="$(run_install --version v1.2.3 2>&1)"; then
    pass_test 'uses shasum when sha256sum is unavailable'
  else
    fail_test 'uses shasum when sha256sum is unavailable' "$output"
  fi
  unset TEST_SHASUM_ONLY
}
test_custom_user_data_dir() {
  new_case
  local data_dir="$case_dir/bot chrome/owner's Fork-4" output command
  write_helper "$case_dir/artifact" '
if [ "$#" != 5 ] || [ "$4" != --user-data-dir ] || [ "$5" != "$TEST_USER_DATA_DIR" ]; then exit 72; fi'
  make_manifest
  export TEST_USER_DATA_DIR="$data_dir"
  if output="$(run_streamed_install --version v1.2.3 --user-data-dir "$data_dir" 2>&1)"; then
    command="$(extract_removal_command "$output")"
    if run_removal_command "$command" > /dev/null 2>&1 &&
      [[ "$(tail -n 1 "$case_dir/exec.log")" == "uninstall --binary-path $case_dir/home/.local/bin/tailchrome --user-data-dir $data_dir" ]]; then
      pass_test 'custom Chromium roots survive install and replayed removal as one quoted argument'
    else
      fail_test 'custom Chromium roots survive install and replayed removal as one quoted argument' "$output / $command"
    fi
  else
    fail_test 'custom Chromium roots survive install and replayed removal as one quoted argument' "$output"
  fi
  unset TEST_USER_DATA_DIR
  new_case
  expect_failure 'rejects a relative Chromium root before downloading' --user-data-dir relative
  expect_failure 'rejects an empty Chromium root' --user-data-dir ''
  expect_failure 'rejects a missing Chromium root argument' --user-data-dir
  expect_failure 'rejects newlines in a Chromium root' --user-data-dir $'/tmp/chrome\nprofile'
  printf 'file' > "$case_dir/not-a-directory"
  expect_failure 'rejects a file as Chromium root' --user-data-dir "$case_dir/not-a-directory"
  if [[ -e "$case_dir/curl.log" ]]; then
    fail_test 'invalid Chromium root inputs never trigger a download' 'download log exists'
  else
    pass_test 'invalid Chromium root inputs never trigger a download'
  fi
}
test_custom_user_data_dir
test_failures
test_provenance_and_shasum
test_latest_same_tag
test_safe_inputs
test_never_executes_bad_artifact
test_rollbacks
test_signal_and_activation_failures
test_uninstall
test_uninstall_guidance_streamed
test_uninstall_guidance_saved
test_migration_and_lock
cleanup_case
if ((tests_failed > 0)); then
  printf '%d of %d tests failed\n' "$tests_failed" "$tests_run" >&2
  exit 1
fi
printf '%d tests passed\n' "$tests_run"
