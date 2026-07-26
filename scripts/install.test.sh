#!/usr/bin/env bash
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
INSTALLER="$ROOT/scripts/install.sh"

tests_run=0
tests_failed=0

make_platform_bin() {
  local bin_dir="$1"
  local system_name="$2"
  local machine_name="$3"
  local bash_path

  bash_path="$(command -v bash)"
  mkdir -p "$bin_dir"
  ln -s "$bash_path" "$bin_dir/bash"
  {
    printf '%s\n' '#!/bin/sh'
    printf '%s\n' "case \"\$1\" in"
    printf '  -s) printf '"'"'%%s\\n'"'"' %q ;;\n' "$system_name"
    printf '  -m) printf '"'"'%%s\\n'"'"' %q ;;\n' "$machine_name"
    printf '%s\n' '  *) exit 2 ;;'
    printf '%s\n' 'esac'
  } >"$bin_dir/uname"
  chmod 755 "$bin_dir/uname"
}

write_stub() {
  local path="$1"

  {
    printf '%s\n' '#!/bin/sh'
    command cat
  } >"$path"
  chmod 755 "$path"
}

link_command() {
  local bin_dir="$1"
  local command_name="$2"
  local command_path

  command_path="$(command -v "$command_name")"
  ln -s "$command_path" "$bin_dir/$command_name"
}

write_fixture_curl_stub() {
  local bin_dir="$1"

  link_command "$bin_dir" cp
  write_stub "$bin_dir/curl" <<'STUB'
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
if [ -n "${TEST_CURL_LOG:-}" ]; then
  printf "%s\n" "$url" >>"$TEST_CURL_LOG"
fi
case "$url" in
  */SHA256SUMS.txt)
    [ "${TEST_CHECKSUM_DOWNLOAD_FAIL:-0}" = 0 ] || exit 22
    cp "$TEST_CHECKSUM_FIXTURE" "$output"
    ;;
  *)
    [ "${TEST_ARTIFACT_DOWNLOAD_FAIL:-0}" = 0 ] || exit 22
    cp "$TEST_ARTIFACT_FIXTURE" "$output"
    ;;
esac
STUB
}

sha256_of() {
  local file="$1"
  local output

  if command -v sha256sum >/dev/null 2>&1; then
    output="$(sha256sum "$file")"
  else
    output="$(shasum -a 256 "$file")"
  fi
  printf '%s\n' "${output%% *}"
}

pass_test() {
  tests_run=$((tests_run + 1))
  printf 'ok %d - %s\n' "$tests_run" "$1"
}

fail_test() {
  tests_run=$((tests_run + 1))
  tests_failed=$((tests_failed + 1))
  printf 'not ok %d - %s\n' "$tests_run" "$1"
  printf '  %s\n' "$2"
}

test_requires_explicit_version() {
  local output

  if output="$("$INSTALLER" 2>&1)"; then
    fail_test "requires an explicit release version" "installer unexpectedly succeeded"
  elif [[ "$output" != *"Usage:"* ]]; then
    fail_test "requires an explicit release version" "missing usage guidance: $output"
  else
    pass_test "requires an explicit release version"
  fi
}

test_rejects_non_release_version() {
  local output

  if output="$("$INSTALLER" --version latest 2>&1)"; then
    fail_test "rejects a non-release version" "installer unexpectedly succeeded"
  elif [[ "$output" != *"--version must be an explicit release tag"* ]]; then
    fail_test "rejects a non-release version" "unexpected error: $output"
  else
    pass_test "rejects a non-release version"
  fi
}

test_rejects_unsupported_os() {
  local case_dir output
  case_dir="$(mktemp -d "${TMPDIR:-/tmp}/tailchrome-install-test.XXXXXX")"
  make_platform_bin "$case_dir/bin" "Windows_NT" "x86_64"

  if output="$(PATH="$case_dir/bin" "$INSTALLER" --version v1.2.3 2>&1)"; then
    fail_test "rejects an unsupported operating system" "installer unexpectedly succeeded"
  elif [[ "$output" != *"unsupported operating system: Windows_NT"* ]]; then
    fail_test "rejects an unsupported operating system" "unexpected error: $output"
  else
    pass_test "rejects an unsupported operating system"
  fi

  rm -rf "$case_dir"
}

test_rejects_unsupported_architecture() {
  local case_dir output
  case_dir="$(mktemp -d "${TMPDIR:-/tmp}/tailchrome-install-test.XXXXXX")"
  make_platform_bin "$case_dir/bin" "Linux" "riscv64"

  if output="$(PATH="$case_dir/bin" "$INSTALLER" --version v1.2.3 2>&1)"; then
    fail_test "rejects an unsupported architecture" "installer unexpectedly succeeded"
  elif [[ "$output" != *"unsupported architecture: riscv64"* ]]; then
    fail_test "rejects an unsupported architecture" "unexpected error: $output"
  else
    pass_test "rejects an unsupported architecture"
  fi

  rm -rf "$case_dir"
}

test_requires_curl() {
  local case_dir output
  case_dir="$(mktemp -d "${TMPDIR:-/tmp}/tailchrome-install-test.XXXXXX")"
  make_platform_bin "$case_dir/bin" "Linux" "x86_64"

  if output="$(PATH="$case_dir/bin" "$INSTALLER" --version v1.2.3 2>&1)"; then
    fail_test "requires curl for installation" "installer unexpectedly succeeded"
  elif [[ "$output" != *"curl is required"* ]]; then
    fail_test "requires curl for installation" "unexpected error: $output"
  else
    pass_test "requires curl for installation"
  fi

  rm -rf "$case_dir"
}

test_requires_checksum_tool() {
  local case_dir output
  case_dir="$(mktemp -d "${TMPDIR:-/tmp}/tailchrome-install-test.XXXXXX")"
  make_platform_bin "$case_dir/bin" "Linux" "x86_64"
  write_stub "$case_dir/bin/curl" <<'STUB'
exit 0
STUB

  if output="$(PATH="$case_dir/bin" "$INSTALLER" --version v1.2.3 2>&1)"; then
    fail_test "requires a SHA-256 checksum tool" "installer unexpectedly succeeded"
  elif [[ "$output" != *"sha256sum or shasum is required"* ]]; then
    fail_test "requires a SHA-256 checksum tool" "unexpected error: $output"
  else
    pass_test "requires a SHA-256 checksum tool"
  fi

  rm -rf "$case_dir"
}

test_uses_tag_pinned_url() {
  local system_name="$1"
  local machine_name="$2"
  local expected_asset="$3"
  local label="$4"
  local case_dir output expected_url
  case_dir="$(mktemp -d "${TMPDIR:-/tmp}/tailchrome-install-test.XXXXXX")"
  make_platform_bin "$case_dir/bin" "$system_name" "$machine_name"
  link_command "$case_dir/bin" mktemp
  link_command "$case_dir/bin" rm
  link_command "$case_dir/bin" shasum
  write_stub "$case_dir/bin/curl" <<'STUB'
printf "%s\n" "$@" >>"$TEST_CURL_LOG"
exit 22
STUB
  expected_url="https://github.com/dantraynor/tailchrome/releases/download/v1.2.3/$expected_asset"

  if output="$(
    TEST_CURL_LOG="$case_dir/curl.log" \
      TMPDIR="$case_dir" \
      PATH="$case_dir/bin" \
      "$INSTALLER" --version v1.2.3 2>&1
  )"; then
    fail_test "$label" "installer unexpectedly succeeded"
  elif [[ "$output" != *"artifact download failed"* ]]; then
    fail_test "$label" "unexpected error: $output"
  elif [[ ! -f "$case_dir/curl.log" ]] ||
    [[ "$(command cat "$case_dir/curl.log")" != *"$expected_url"* ]]; then
    fail_test "$label" "request did not contain $expected_url"
  else
    pass_test "$label"
  fi

  rm -rf "$case_dir"
}

test_reports_checksum_download_failure() {
  local case_dir output
  case_dir="$(mktemp -d "${TMPDIR:-/tmp}/tailchrome-install-test.XXXXXX")"
  make_platform_bin "$case_dir/bin" "Darwin" "arm64"
  link_command "$case_dir/bin" mktemp
  link_command "$case_dir/bin" rm
  link_command "$case_dir/bin" shasum
  write_stub "$case_dir/bin/curl" <<'STUB'
output=""
url=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    --output) output="$2"; shift 2 ;;
    http*) url="$1"; shift ;;
    *) shift ;;
  esac
done
case "$url" in
  */SHA256SUMS.txt) exit 22 ;;
  *) printf "%s\n" "#!/bin/sh" "exit 0" >"$output" ;;
esac
STUB

  if output="$(
    TMPDIR="$case_dir" \
      PATH="$case_dir/bin" \
      "$INSTALLER" --version v1.2.3 2>&1
  )"; then
    fail_test "reports a checksum download failure" "installer unexpectedly succeeded"
  elif [[ "$output" != *"checksum download failed"* ]]; then
    fail_test "reports a checksum download failure" "unexpected error: $output"
  else
    pass_test "reports a checksum download failure"
  fi

  rm -rf "$case_dir"
}

test_rejects_missing_checksum_entry() {
  local case_dir output
  case_dir="$(mktemp -d "${TMPDIR:-/tmp}/tailchrome-install-test.XXXXXX")"
  make_platform_bin "$case_dir/bin" "Linux" "aarch64"
  link_command "$case_dir/bin" mktemp
  link_command "$case_dir/bin" rm
  link_command "$case_dir/bin" shasum
  write_fixture_curl_stub "$case_dir/bin"
  write_stub "$case_dir/artifact" <<'STUB'
exit 0
STUB
  printf '%064d  unrelated-file\n' 0 >"$case_dir/SHA256SUMS.txt"

  if output="$(
    TEST_ARTIFACT_FIXTURE="$case_dir/artifact" \
      TEST_CHECKSUM_FIXTURE="$case_dir/SHA256SUMS.txt" \
      TMPDIR="$case_dir" \
      PATH="$case_dir/bin" \
      "$INSTALLER" --version v1.2.3 2>&1
  )"; then
    fail_test "rejects a missing checksum entry" "installer unexpectedly succeeded"
  elif [[ "$output" != *"exactly one checksum entry"* ]]; then
    fail_test "rejects a missing checksum entry" "unexpected error: $output"
  else
    pass_test "rejects a missing checksum entry"
  fi

  rm -rf "$case_dir"
}

test_rejects_duplicate_checksum_entry() {
  local case_dir output asset
  case_dir="$(mktemp -d "${TMPDIR:-/tmp}/tailchrome-install-test.XXXXXX")"
  asset="tailscale-browser-ext-linux-arm64"
  make_platform_bin "$case_dir/bin" "Linux" "arm64"
  link_command "$case_dir/bin" mktemp
  link_command "$case_dir/bin" rm
  link_command "$case_dir/bin" shasum
  write_fixture_curl_stub "$case_dir/bin"
  write_stub "$case_dir/artifact" <<'STUB'
exit 0
STUB
  {
    printf '%064d  %s\n' 0 "$asset"
    printf '%064d  %s\n' 1 "$asset"
  } >"$case_dir/SHA256SUMS.txt"

  if output="$(
    TEST_ARTIFACT_FIXTURE="$case_dir/artifact" \
      TEST_CHECKSUM_FIXTURE="$case_dir/SHA256SUMS.txt" \
      TMPDIR="$case_dir" \
      PATH="$case_dir/bin" \
      "$INSTALLER" --version v1.2.3 2>&1
  )"; then
    fail_test "rejects a duplicate checksum entry" "installer unexpectedly succeeded"
  elif [[ "$output" != *"exactly one checksum entry"* ]]; then
    fail_test "rejects a duplicate checksum entry" "unexpected error: $output"
  else
    pass_test "rejects a duplicate checksum entry"
  fi

  rm -rf "$case_dir"
}

test_rejects_unsafe_checksum_entry() {
  local case_dir output
  case_dir="$(mktemp -d "${TMPDIR:-/tmp}/tailchrome-install-test.XXXXXX")"
  make_platform_bin "$case_dir/bin" "Darwin" "x86_64"
  link_command "$case_dir/bin" mktemp
  link_command "$case_dir/bin" rm
  link_command "$case_dir/bin" shasum
  write_fixture_curl_stub "$case_dir/bin"
  write_stub "$case_dir/artifact" <<'STUB'
exit 0
STUB
  printf '%064d  ../tailscale-browser-ext-darwin-amd64\n' 0 \
    >"$case_dir/SHA256SUMS.txt"

  if output="$(
    TEST_ARTIFACT_FIXTURE="$case_dir/artifact" \
      TEST_CHECKSUM_FIXTURE="$case_dir/SHA256SUMS.txt" \
      TMPDIR="$case_dir" \
      PATH="$case_dir/bin" \
      "$INSTALLER" --version v1.2.3 2>&1
  )"; then
    fail_test "rejects an unsafe checksum entry" "installer unexpectedly succeeded"
  elif [[ "$output" != *"unsafe or malformed checksum entry"* ]]; then
    fail_test "rejects an unsafe checksum entry" "unexpected error: $output"
  else
    pass_test "rejects an unsafe checksum entry"
  fi

  rm -rf "$case_dir"
}

test_rejects_checksum_mismatch() {
  local case_dir output asset
  case_dir="$(mktemp -d "${TMPDIR:-/tmp}/tailchrome-install-test.XXXXXX")"
  asset="tailscale-browser-ext-darwin-arm64"
  make_platform_bin "$case_dir/bin" "Darwin" "arm64"
  link_command "$case_dir/bin" mktemp
  link_command "$case_dir/bin" rm
  link_command "$case_dir/bin" shasum
  write_fixture_curl_stub "$case_dir/bin"
  write_stub "$case_dir/artifact" <<'STUB'
exit 0
STUB
  printf '%064d  %s\n' 0 "$asset" >"$case_dir/SHA256SUMS.txt"

  if output="$(
    TEST_ARTIFACT_FIXTURE="$case_dir/artifact" \
      TEST_CHECKSUM_FIXTURE="$case_dir/SHA256SUMS.txt" \
      TMPDIR="$case_dir" \
      PATH="$case_dir/bin" \
      "$INSTALLER" --version v1.2.3 2>&1
  )"; then
    fail_test "rejects a checksum mismatch" "installer unexpectedly succeeded"
  elif [[ "$output" != *"checksum verification failed"* ]]; then
    fail_test "rejects a checksum mismatch" "unexpected error: $output"
  else
    pass_test "rejects a checksum mismatch"
  fi

  rm -rf "$case_dir"
}

test_stops_when_attestation_verification_fails() {
  local case_dir output asset digest
  case_dir="$(mktemp -d "${TMPDIR:-/tmp}/tailchrome-install-test.XXXXXX")"
  asset="tailscale-browser-ext-linux-amd64"
  make_platform_bin "$case_dir/bin" "Linux" "amd64"
  link_command "$case_dir/bin" mktemp
  link_command "$case_dir/bin" rm
  link_command "$case_dir/bin" shasum
  write_fixture_curl_stub "$case_dir/bin"
  write_stub "$case_dir/bin/gh" <<'STUB'
printf "%s\n" "$@" >"$TEST_GH_LOG"
exit 1
STUB
  write_stub "$case_dir/artifact" <<'STUB'
exit 0
STUB
  digest="$(sha256_of "$case_dir/artifact")"
  printf '%s  %s\n' "$digest" "$asset" >"$case_dir/SHA256SUMS.txt"

  if output="$(
    TEST_ARTIFACT_FIXTURE="$case_dir/artifact" \
      TEST_CHECKSUM_FIXTURE="$case_dir/SHA256SUMS.txt" \
      TEST_GH_LOG="$case_dir/gh.log" \
      TMPDIR="$case_dir" \
      PATH="$case_dir/bin" \
      "$INSTALLER" --version v1.2.3 2>&1
  )"; then
    fail_test "stops when attestation verification fails" "installer unexpectedly succeeded"
  elif [[ "$output" != *"attestation verification failed"* ]]; then
    fail_test "stops when attestation verification fails" "unexpected error: $output"
  elif [[ "$(command cat "$case_dir/gh.log")" != *"dantraynor/tailchrome"* ]]; then
    fail_test "stops when attestation verification fails" "repository was not pinned"
  else
    pass_test "stops when attestation verification fails"
  fi

  rm -rf "$case_dir"
}

test_installs_after_attestation_verification() {
  local case_dir output asset digest installed_path
  case_dir="$(mktemp -d "${TMPDIR:-/tmp}/tailchrome-install-test.XXXXXX")"
  asset="tailscale-browser-ext-linux-amd64"
  installed_path="$case_dir/home/.local/share/tailscale/browser-ext/tailscale-browser-ext"
  make_platform_bin "$case_dir/bin" "Linux" "x86_64"
  link_command "$case_dir/bin" chmod
  link_command "$case_dir/bin" mktemp
  link_command "$case_dir/bin" mkdir
  link_command "$case_dir/bin" rm
  link_command "$case_dir/bin" shasum
  write_fixture_curl_stub "$case_dir/bin"
  write_stub "$case_dir/bin/gh" <<'STUB'
printf "%s\n" "$@" >"$TEST_GH_LOG"
exit 0
STUB
  write_stub "$case_dir/artifact" <<'STUB'
mkdir -p "${TEST_INSTALLED_PATH%/*}"
cp "$0" "$TEST_INSTALLED_PATH"
chmod 755 "$TEST_INSTALLED_PATH"
printf "%s\n" "$@" >"$TEST_EXEC_LOG"
STUB
  digest="$(sha256_of "$case_dir/artifact")"
  printf '%s  %s\n' "$digest" "$asset" >"$case_dir/SHA256SUMS.txt"

  if ! output="$(
    HOME="$case_dir/home" \
      TEST_ARTIFACT_FIXTURE="$case_dir/artifact" \
      TEST_CHECKSUM_FIXTURE="$case_dir/SHA256SUMS.txt" \
      TEST_EXEC_LOG="$case_dir/exec.log" \
      TEST_GH_LOG="$case_dir/gh.log" \
      TEST_INSTALLED_PATH="$installed_path" \
      TMPDIR="$case_dir" \
      PATH="$case_dir/bin" \
      "$INSTALLER" --version v1.2.3 2>&1
  )"; then
    fail_test "installs after attestation verification" "unexpected error: $output"
  elif [[ "$(command cat "$case_dir/exec.log")" != "-install-now" ]]; then
    fail_test "installs after attestation verification" "helper did not receive -install-now"
  elif [[ "$output" != *"Installed helper: $installed_path"* ]] ||
    [[ "$output" != *"\"$installed_path\" -uninstall"* ]]; then
    fail_test "installs after attestation verification" "installed path or uninstall command was incorrect: $output"
  else
    pass_test "installs after attestation verification"
  fi

  rm -rf "$case_dir"
}

test_warns_and_installs_without_gh() {
  local case_dir output asset digest installed_path
  case_dir="$(mktemp -d "${TMPDIR:-/tmp}/tailchrome-install-test.XXXXXX")"
  asset="tailscale-browser-ext-darwin-arm64"
  installed_path="$case_dir/home/Library/Application Support/Tailscale/BrowserExt/tailscale-browser-ext"
  make_platform_bin "$case_dir/bin" "Darwin" "aarch64"
  link_command "$case_dir/bin" chmod
  link_command "$case_dir/bin" mktemp
  link_command "$case_dir/bin" mkdir
  link_command "$case_dir/bin" rm
  link_command "$case_dir/bin" shasum
  write_fixture_curl_stub "$case_dir/bin"
  write_stub "$case_dir/artifact" <<'STUB'
mkdir -p "${TEST_INSTALLED_PATH%/*}"
cp "$0" "$TEST_INSTALLED_PATH"
chmod 755 "$TEST_INSTALLED_PATH"
printf "%s\n" "$@" >"$TEST_EXEC_LOG"
STUB
  digest="$(sha256_of "$case_dir/artifact")"
  printf '%s  %s\n' "$digest" "$asset" >"$case_dir/SHA256SUMS.txt"

  if ! output="$(
    HOME="$case_dir/home" \
      TEST_ARTIFACT_FIXTURE="$case_dir/artifact" \
      TEST_CHECKSUM_FIXTURE="$case_dir/SHA256SUMS.txt" \
      TEST_EXEC_LOG="$case_dir/exec.log" \
      TEST_INSTALLED_PATH="$installed_path" \
      TMPDIR="$case_dir" \
      PATH="$case_dir/bin" \
      "$INSTALLER" --version v1.2.3 2>&1
  )"; then
    fail_test "warns and installs when gh is unavailable" "unexpected error: $output"
  elif [[ "$output" != *"checksum and artifact share the GitHub Release trust boundary"* ]]; then
    fail_test "warns and installs when gh is unavailable" "missing trust-boundary warning: $output"
  elif [[ "$(command cat "$case_dir/exec.log")" != "-install-now" ]]; then
    fail_test "warns and installs when gh is unavailable" "helper did not receive -install-now"
  else
    pass_test "warns and installs when gh is unavailable"
  fi

  rm -rf "$case_dir"
}

test_reports_install_now_failure() {
  local case_dir output asset digest
  case_dir="$(mktemp -d "${TMPDIR:-/tmp}/tailchrome-install-test.XXXXXX")"
  asset="tailscale-browser-ext-linux-arm64"
  make_platform_bin "$case_dir/bin" "Linux" "arm64"
  link_command "$case_dir/bin" chmod
  link_command "$case_dir/bin" mktemp
  link_command "$case_dir/bin" rm
  link_command "$case_dir/bin" shasum
  write_fixture_curl_stub "$case_dir/bin"
  write_stub "$case_dir/artifact" <<'STUB'
exit 9
STUB
  digest="$(sha256_of "$case_dir/artifact")"
  printf '%s  %s\n' "$digest" "$asset" >"$case_dir/SHA256SUMS.txt"

  if output="$(
    HOME="$case_dir/home" \
      TEST_ARTIFACT_FIXTURE="$case_dir/artifact" \
      TEST_CHECKSUM_FIXTURE="$case_dir/SHA256SUMS.txt" \
      TMPDIR="$case_dir" \
      PATH="$case_dir/bin" \
      "$INSTALLER" --version v1.2.3 2>&1
  )"; then
    fail_test "reports -install-now failure" "installer unexpectedly succeeded"
  elif [[ "$output" != *"-install-now failed"* ]]; then
    fail_test "reports -install-now failure" "unexpected error: $output"
  else
    pass_test "reports -install-now failure"
  fi

  rm -rf "$case_dir"
}

test_rejects_success_without_installed_helper() {
  local case_dir output asset digest
  case_dir="$(mktemp -d "${TMPDIR:-/tmp}/tailchrome-install-test.XXXXXX")"
  asset="tailscale-browser-ext-linux-amd64"
  make_platform_bin "$case_dir/bin" "Linux" "amd64"
  link_command "$case_dir/bin" chmod
  link_command "$case_dir/bin" mktemp
  link_command "$case_dir/bin" rm
  link_command "$case_dir/bin" shasum
  write_fixture_curl_stub "$case_dir/bin"
  write_stub "$case_dir/artifact" <<'STUB'
exit 0
STUB
  digest="$(sha256_of "$case_dir/artifact")"
  printf '%s  %s\n' "$digest" "$asset" >"$case_dir/SHA256SUMS.txt"

  if output="$(
    HOME="$case_dir/home" \
      TEST_ARTIFACT_FIXTURE="$case_dir/artifact" \
      TEST_CHECKSUM_FIXTURE="$case_dir/SHA256SUMS.txt" \
      TMPDIR="$case_dir" \
      PATH="$case_dir/bin" \
      "$INSTALLER" --version v1.2.3 2>&1
  )"; then
    fail_test "requires the installed helper after -install-now" "installer unexpectedly succeeded"
  elif [[ "$output" != *"installed helper was not created at"* ]]; then
    fail_test "requires the installed helper after -install-now" "unexpected error: $output"
  else
    pass_test "requires the installed helper after -install-now"
  fi

  rm -rf "$case_dir"
}

test_cleans_temporary_files_after_failure() {
  local case_dir output leftovers
  case_dir="$(mktemp -d "${TMPDIR:-/tmp}/tailchrome-install-test.XXXXXX")"
  make_platform_bin "$case_dir/bin" "Linux" "x86_64"
  link_command "$case_dir/bin" mktemp
  link_command "$case_dir/bin" rm
  link_command "$case_dir/bin" shasum
  write_stub "$case_dir/bin/curl" <<'STUB'
exit 22
STUB

  output="$(
    TMPDIR="$case_dir" \
      PATH="$case_dir/bin" \
      "$INSTALLER" --version v1.2.3 2>&1
  )" || true
  leftovers="$(find "$case_dir" -maxdepth 1 -type d -name 'tailchrome-install.*' -print)"
  if [[ -n "$leftovers" ]]; then
    fail_test "cleans temporary files after failure" "temporary directory remains: $leftovers"
  else
    pass_test "cleans temporary files after failure"
  fi

  rm -rf "$case_dir"
}

test_uninstalls_from_linux_installed_path() {
  local case_dir output installed_path
  case_dir="$(mktemp -d "${TMPDIR:-/tmp}/tailchrome-install-test.XXXXXX")"
  installed_path="$case_dir/home/.local/share/tailscale/browser-ext/tailscale-browser-ext"
  make_platform_bin "$case_dir/bin" "Linux" "x86_64"
  mkdir -p "${installed_path%/*}"
  write_stub "$installed_path" <<'STUB'
printf "%s\n" "$@" >"$TEST_EXEC_LOG"
exit 0
STUB

  if ! output="$(
    HOME="$case_dir/home" \
      TEST_EXEC_LOG="$case_dir/exec.log" \
      PATH="$case_dir/bin" \
      "$INSTALLER" --version v1.2.3 --uninstall 2>&1
  )"; then
    fail_test "uninstalls from the Linux installed path" "unexpected error: $output"
  elif [[ "$(command cat "$case_dir/exec.log")" != "-uninstall" ]]; then
    fail_test "uninstalls from the Linux installed path" "installed helper did not receive -uninstall"
  else
    pass_test "uninstalls from the Linux installed path"
  fi

  rm -rf "$case_dir"
}

test_uninstalls_from_macos_installed_path() {
  local case_dir output installed_path
  case_dir="$(mktemp -d "${TMPDIR:-/tmp}/tailchrome-install-test.XXXXXX")"
  installed_path="$case_dir/home/Library/Application Support/Tailscale/BrowserExt/tailscale-browser-ext"
  make_platform_bin "$case_dir/bin" "Darwin" "arm64"
  mkdir -p "${installed_path%/*}"
  write_stub "$installed_path" <<'STUB'
printf "%s\n" "$@" >"$TEST_EXEC_LOG"
exit 0
STUB

  if ! output="$(
    HOME="$case_dir/home" \
      TEST_EXEC_LOG="$case_dir/exec.log" \
      PATH="$case_dir/bin" \
      "$INSTALLER" --version v1.2.3 --uninstall 2>&1
  )"; then
    fail_test "uninstalls from the macOS installed path" "unexpected error: $output"
  elif [[ "$(command cat "$case_dir/exec.log")" != "-uninstall" ]]; then
    fail_test "uninstalls from the macOS installed path" "installed helper did not receive -uninstall"
  else
    pass_test "uninstalls from the macOS installed path"
  fi

  rm -rf "$case_dir"
}

test_requires_explicit_version
test_rejects_non_release_version
test_rejects_unsupported_os
test_rejects_unsupported_architecture
test_requires_curl
test_requires_checksum_tool
test_uses_tag_pinned_url \
  "Linux" "x86_64" "tailscale-browser-ext-linux-amd64" \
  "maps Linux x86_64 to the tag-pinned amd64 asset"
test_uses_tag_pinned_url \
  "Linux" "aarch64" "tailscale-browser-ext-linux-arm64" \
  "maps Linux aarch64 to the tag-pinned arm64 asset"
test_uses_tag_pinned_url \
  "Darwin" "x86_64" "tailscale-browser-ext-darwin-amd64" \
  "maps macOS x86_64 to the tag-pinned amd64 asset"
test_uses_tag_pinned_url \
  "Darwin" "arm64" "tailscale-browser-ext-darwin-arm64" \
  "maps macOS arm64 to the tag-pinned arm64 asset"
test_reports_checksum_download_failure
test_rejects_missing_checksum_entry
test_rejects_duplicate_checksum_entry
test_rejects_unsafe_checksum_entry
test_rejects_checksum_mismatch
test_stops_when_attestation_verification_fails
test_installs_after_attestation_verification
test_warns_and_installs_without_gh
test_reports_install_now_failure
test_rejects_success_without_installed_helper
test_cleans_temporary_files_after_failure
test_uninstalls_from_linux_installed_path
test_uninstalls_from_macos_installed_path

if ((tests_failed > 0)); then
  printf '%d of %d tests failed\n' "$tests_failed" "$tests_run" >&2
  exit 1
fi

printf '%d tests passed\n' "$tests_run"
