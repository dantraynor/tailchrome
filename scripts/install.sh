#!/usr/bin/env bash
# Install or remove Tailchrome's per-user native-messaging helper on macOS and
# Linux. System packages remain the preferred installation method where they
# are available.
set -euo pipefail

usage() {
  printf 'Usage: %s --version vX.Y.Z [--uninstall]\n' "${0##*/}" >&2
}

die() {
  printf '%s: %s\n' "${0##*/}" "$1" >&2
  exit 1
}

version=""
uninstall=false

while (($# > 0)); do
  case "$1" in
    --version)
      (($# >= 2)) || {
        usage
        die "--version requires a value"
      }
      version="$2"
      shift 2
      ;;
    --uninstall)
      uninstall=true
      shift
      ;;
    -h | --help)
      usage
      exit 0
      ;;
    *)
      usage
      die "unknown argument: $1"
      ;;
  esac
done

if [[ ! "$version" =~ ^v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$ ]]; then
  usage
  die "--version must be an explicit release tag such as v1.2.3"
fi

system_name="$(uname -s)"
case "$system_name" in
  Darwin) platform="darwin" ;;
  Linux) platform="linux" ;;
  *) die "unsupported operating system: $system_name" ;;
esac

machine_name="$(uname -m)"
case "$machine_name" in
  x86_64 | amd64) architecture="amd64" ;;
  arm64 | aarch64) architecture="arm64" ;;
  *) die "unsupported architecture: $machine_name" ;;
esac

if [[ "$uninstall" == false ]]; then
  command -v curl >/dev/null 2>&1 || die "curl is required"
  if command -v sha256sum >/dev/null 2>&1; then
    checksum_tool="sha256sum"
  elif command -v shasum >/dev/null 2>&1; then
    checksum_tool="shasum"
  else
    die "sha256sum or shasum is required"
  fi
fi

asset="tailscale-browser-ext-$platform-$architecture"
release_base_url="https://github.com/dantraynor/tailchrome/releases/download/$version"
user_home="${HOME:-}"
[[ -n "$user_home" ]] || die "HOME is not set"

case "$platform" in
  linux)
    installed_path="$user_home/.local/share/tailscale/browser-ext/tailscale-browser-ext"
    ;;
  darwin)
    installed_path="$user_home/Library/Application Support/Tailscale/BrowserExt/tailscale-browser-ext"
    ;;
esac

if [[ "$uninstall" == true ]]; then
  [[ -x "$installed_path" ]] ||
    die "installed helper not found at $installed_path"
  if ! "$installed_path" -uninstall; then
    die "uninstall failed"
  fi
  printf 'Uninstalled helper from: %s\n' "$installed_path"
  exit 0
fi

if [[ "$uninstall" == false ]]; then
  umask 077
  temp_dir="$(mktemp -d "${TMPDIR:-/tmp}/tailchrome-install.XXXXXX")" ||
    die "could not create a temporary directory"

  # ShellCheck cannot see the indirect invocations through these traps.
  # shellcheck disable=SC2317,SC2329
  cleanup() {
    local cleanup_status=$?
    trap - EXIT HUP INT TERM
    if [[ -n "${temp_dir:-}" ]]; then
      rm -rf -- "$temp_dir" || :
    fi
    exit "$cleanup_status"
  }
  trap cleanup EXIT
  trap 'exit 129' HUP
  trap 'exit 130' INT
  trap 'exit 143' TERM

  artifact_path="$temp_dir/$asset"
  checksum_path="$temp_dir/SHA256SUMS.txt"
  if ! curl --disable --fail --silent --show-error --location \
    --proto '=https' --proto-redir '=https' --tlsv1.2 \
    --output "$checksum_path" \
    "$release_base_url/SHA256SUMS.txt"; then
    die "checksum download failed"
  fi

  matching_checksum=""
  checksum_matches=0
  checksum_line_pattern='^([0-9a-f]{64})[[:space:]]+[*]?([A-Za-z0-9][A-Za-z0-9._-]*)$'
  while IFS= read -r checksum_line || [[ -n "$checksum_line" ]]; do
    [[ -n "$checksum_line" ]] || continue
    if [[ ! "$checksum_line" =~ $checksum_line_pattern ]]; then
      die "unsafe or malformed checksum entry"
    fi
    if [[ "${BASH_REMATCH[2]}" == "$asset" ]]; then
      matching_checksum="${BASH_REMATCH[1]}"
      checksum_matches=$((checksum_matches + 1))
    fi
  done <"$checksum_path"

  if ((checksum_matches != 1)); then
    die "expected exactly one checksum entry for $asset"
  fi

  if ! curl --disable --fail --silent --show-error --location \
    --proto '=https' --proto-redir '=https' --tlsv1.2 \
    --output "$artifact_path" \
    "$release_base_url/$asset"; then
    die "artifact download failed for $platform/$architecture"
  fi

  if [[ "$checksum_tool" == "sha256sum" ]]; then
    checksum_output="$(sha256sum "$artifact_path")" ||
      die "checksum verification failed"
  else
    checksum_output="$(shasum -a 256 "$artifact_path")" ||
      die "checksum verification failed"
  fi
  actual_checksum="${checksum_output%% *}"
  if [[ "$actual_checksum" != "$matching_checksum" ]]; then
    die "checksum verification failed"
  fi

  if command -v gh >/dev/null 2>&1 &&
    gh attestation verify --help >/dev/null 2>&1 &&
    gh auth status --hostname github.com >/dev/null 2>&1; then
    if ! gh attestation verify "$artifact_path" \
      --hostname github.com \
      --repo dantraynor/tailchrome >/dev/null; then
      die "attestation verification failed"
    fi
  else
    printf '%s\n' \
      "Warning: GitHub CLI attestation verification is unavailable; the checksum and artifact share the GitHub Release trust boundary." >&2
  fi

  chmod 755 "$artifact_path" || die "could not make the verified artifact executable"
  if ! "$artifact_path" -install-now; then
    die "-install-now failed"
  fi
  [[ -x "$installed_path" ]] ||
    die "installed helper was not created at $installed_path"

  printf 'Installed helper: %s\n' "$installed_path"
  printf 'Uninstall with:\n  "%s" -uninstall\n' "$installed_path"
  exit 0
fi

die "unreachable installer state"
