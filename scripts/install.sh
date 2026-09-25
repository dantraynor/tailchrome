#!/usr/bin/env bash
# Install Tailchrome's per-user native-messaging helper on macOS and Linux.
# Only a checksum-verified (and, when available, attested) file is ever run.
set -euo pipefail

readonly REPOSITORY="dantraynor/tailchrome"
readonly RELEASES_URL="https://github.com/$REPOSITORY/releases"
readonly API_LATEST_URL="https://api.github.com/repos/$REPOSITORY/releases/latest"

usage() {
  printf 'Usage: %s [--version vX.Y.Z] [--bin-dir PATH] [--user-data-dir PATH] [--uninstall]\n' "${0##*/}" >&2
}

die() {
  printf '%s: %s\n' "${0##*/}" "$1" >&2
  exit 1
}

version=""
uninstall=false
bin_dir=""
user_data_dir=""

while (($# > 0)); do
  case "$1" in
    --version)
      (($# >= 2)) || { usage; die "--version requires a value"; }
      version="$2"
      shift 2
      ;;
    --bin-dir)
      (($# >= 2)) || { usage; die "--bin-dir requires a value"; }
      bin_dir="$2"
      shift 2
      ;;
    --uninstall)
      uninstall=true
      shift
      ;;
    --user-data-dir)
      (($# >= 2)) || { usage; die "--user-data-dir requires a value"; }
      [[ "$2" == /* ]] || die "--user-data-dir must be absolute"
      [[ "$2" != *$'\n'* && "$2" != *$'\r'* ]] || die "--user-data-dir contains a newline"
      [[ ! -e "$2" || -d "$2" ]] || die "--user-data-dir is not a directory"
      user_data_dir="$2"
      shift 2
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

if [[ -n "$version" ]] && [[ ! "$version" =~ ^v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$ ]]; then
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

umask 077

user_home="${HOME:-}"
[[ -n "$user_home" ]] || die "HOME is not set"

shell_quote() {
  local value
  value="$(printf '%s' "$1" | sed "s/'/'\"'\"'/g")"
  printf "'%s'" "$value"
}

# BASH_SOURCE identifies a saved script without mistaking the interpreter
# ($0) or a transient /dev/fd stream for a reusable installer path.
installer_source_path="${BASH_SOURCE[0]-}"
case "$installer_source_path" in
  "" | /dev/fd/* | /proc/* | /dev/stdin) installer_source_path="" ;;
  *)
    if [[ -f "$installer_source_path" ]]; then
      installer_source_path="$(cd -- "$(dirname -- "$installer_source_path")" 2>/dev/null && pwd -P)/$(basename -- "$installer_source_path")" ||
        installer_source_path=""
    else
      installer_source_path=""
    fi
    ;;
esac

if [[ -n "$bin_dir" ]]; then
  [[ "$bin_dir" != *$'\n'* && "$bin_dir" != *$'\r'* ]] || die "--bin-dir contains a newline"
  if [[ "$bin_dir" != /* ]]; then
    bin_dir="$(cd -- "$bin_dir" 2>/dev/null && pwd -P)" ||
      die "could not resolve --bin-dir: $bin_dir"
  fi
else
  bin_dir="$user_home/.local/bin"
fi
final_path="$bin_dir/tailchrome"
registration_args=(--binary-path "$final_path")
if [[ -n "$user_data_dir" ]]; then
  registration_args+=(--user-data-dir "$user_data_dir")
fi

if [[ ! -d "$bin_dir" ]]; then
  [[ "$uninstall" == false ]] || die "installed helper not found at $final_path"
  mkdir -p -- "$bin_dir" || die "could not create install directory: $bin_dir"
fi
[[ -d "$bin_dir" && ! -L "$bin_dir" ]] || die "install directory is not a real directory: $bin_dir"

lock_dir="$bin_dir/.tailchrome-install.lock"
if ! mkdir -- "$lock_dir" 2>/dev/null; then
  die "another Tailchrome installation is already in progress"
fi

temp_dir=""
stage_path=""
backup_path=""
cleanup_status=0
had_previous=false
activated=false

# ShellCheck cannot see that rollback is reached indirectly from the EXIT trap.
# shellcheck disable=SC2317,SC2329
restore_previous() {
  if [[ "$activated" != true ]]; then
    return 0
  fi
  if [[ "$had_previous" == true && -n "$backup_path" && -e "$backup_path" ]]; then
    # Replace the destination directly so rollback has no missing-path window.
    mv -- "$backup_path" "$final_path" || return 1
    backup_path=""
  elif [[ "$had_previous" == false ]]; then
    rm -f -- "$final_path" || return 1
  else
    return 1
  fi
  activated=false
  return 0
}

# ShellCheck cannot see the indirect invocations through these traps.
# shellcheck disable=SC2317,SC2329
cleanup() {
  cleanup_status=$?
  trap - EXIT HUP INT TERM
  if ((cleanup_status != 0)); then
    if [[ "$activated" == true ]]; then
      if ! restore_previous; then
        printf '%s\n' "Warning: could not restore the previous helper; recovery copy was retained at $backup_path" >&2
      fi
    elif [[ -n "$backup_path" && -e "$backup_path" && -e "$final_path" ]]; then
      rm -f -- "$backup_path" ||
        printf '%s\n' "Warning: could not remove an unused recovery copy: $backup_path" >&2
    fi
  fi
  if [[ -n "$stage_path" && -e "$stage_path" ]]; then
    rm -f -- "$stage_path" || :
  fi
  if ((cleanup_status == 0)) && [[ -n "$backup_path" && -e "$backup_path" ]]; then
    rm -f -- "$backup_path" || :
  fi
  if [[ -n "$temp_dir" && -d "$temp_dir" ]]; then
    rm -rf -- "$temp_dir" || :
  fi
  rmdir -- "$lock_dir" 2>/dev/null || :
  exit "$cleanup_status"
}
trap cleanup EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

if [[ "$uninstall" == true ]]; then
  if [[ ! -f "$final_path" || ! -x "$final_path" || -L "$final_path" ]]; then
    die "installed helper not found at $final_path"
  fi
  if ! "$final_path" uninstall "${registration_args[@]}"; then
    die "uninstall registration failed; leaving $final_path in place"
  fi
  # Never remove state directories. Remove only the stable executable after the
  # unregister command has exited.
  rm -f -- "$final_path" || die "could not remove installed helper: $final_path"
  printf 'Uninstalled helper from: %s\n' "$final_path"
  exit 0
fi

command -v curl >/dev/null 2>&1 || die "curl is required"
if command -v sha256sum >/dev/null 2>&1; then
  checksum_tool="sha256sum"
elif command -v shasum >/dev/null 2>&1; then
  checksum_tool="shasum"
else
  checksum_tool=""
fi
[[ -n "$checksum_tool" ]] || die "sha256sum or shasum is required"

if [[ -z "$version" ]]; then
  temp_dir="$(mktemp -d "${TMPDIR:-/tmp}/tailchrome-install.XXXXXX")" ||
    die "could not create a temporary directory"
  latest_response="$temp_dir/latest.json"
  curl --disable --fail --silent --show-error --location \
    --proto '=https' --proto-redir '=https' --tlsv1.2 \
    --output "$latest_response" "$API_LATEST_URL" || die "latest release lookup failed"
  tag_matches="$(sed -nE 's/.*"tag_name"[[:space:]]*:[[:space:]]*"(v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*))".*/\1/p' "$latest_response")"
  if [[ -z "$tag_matches" || "$tag_matches" == *$'\n'* ]]; then
    die "latest release returned no unique safe release tag"
  fi
  version="$tag_matches"
fi

[[ "$version" =~ ^v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$ ]] ||
  die "release tag is not safe: $version"

asset="tailscale-browser-ext-$platform-$architecture"
release_base_url="$RELEASES_URL/download/$version"
if [[ "$release_base_url" != https://* || "$release_base_url" == *$'\n'* || "$release_base_url" == *$'\r'* ]]; then
  die "release URL must use HTTPS"
fi

if [[ -z "$temp_dir" ]]; then
  temp_dir="$(mktemp -d "${TMPDIR:-/tmp}/tailchrome-install.XXXXXX")" ||
    die "could not create a temporary directory"
fi
checksum_path="$temp_dir/SHA256SUMS.txt"
artifact_path="$temp_dir/$asset"

curl --disable --fail --silent --show-error --location \
  --proto '=https' --proto-redir '=https' --tlsv1.2 \
  --output "$checksum_path" "$release_base_url/SHA256SUMS.txt" ||
  die "checksum download failed"

matching_checksum=""
checksum_matches=0
checksum_line_pattern='^([0-9a-fA-F]{64})[[:space:]]+[*]?([A-Za-z0-9][A-Za-z0-9._-]*)$'
while IFS= read -r checksum_line || [[ -n "$checksum_line" ]]; do
  [[ -n "$checksum_line" ]] || continue
  if [[ ! "$checksum_line" =~ $checksum_line_pattern ]]; then
    die "unsafe or malformed checksum entry"
  fi
  checksum_name="${BASH_REMATCH[2]}"
  [[ "$checksum_name" != *..* && "$checksum_name" != /* ]] ||
    die "unsafe or malformed checksum entry"
  if [[ "$checksum_name" == "$asset" ]]; then
    matching_checksum="$(printf '%s' "${BASH_REMATCH[1]}" | tr '[:upper:]' '[:lower:]')"
    checksum_matches=$((checksum_matches + 1))
  fi
done <"$checksum_path"

((checksum_matches == 1)) || die "expected exactly one checksum entry for $asset"

curl --disable --fail --silent --show-error --location \
  --proto '=https' --proto-redir '=https' --tlsv1.2 \
  --output "$artifact_path" "$release_base_url/$asset" ||
  die "artifact download failed for $platform/$architecture"

if [[ "$checksum_tool" == sha256sum ]]; then
  checksum_output="$(sha256sum "$artifact_path")" || die "checksum verification failed"
else
  checksum_output="$(shasum -a 256 "$artifact_path")" || die "checksum verification failed"
fi
actual_checksum="${checksum_output%% *}"
actual_checksum="$(printf '%s' "$actual_checksum" | tr '[:upper:]' '[:lower:]')"
[[ "$actual_checksum" == "$matching_checksum" ]] || die "checksum verification failed"

if command -v gh >/dev/null 2>&1 &&
  gh attestation verify --help >/dev/null 2>&1 &&
  gh auth status --hostname github.com >/dev/null 2>&1; then
  gh attestation verify "$artifact_path" --hostname github.com --repo "$REPOSITORY" >/dev/null ||
    die "attestation verification failed"
else
  printf '%s\n' \
    "Warning: GitHub CLI attestation verification is unavailable; the checksum and artifact share the GitHub Release trust boundary." >&2
fi

chmod 755 -- "$artifact_path" || die "could not make the verified artifact executable"
stage_path="$(mktemp "$bin_dir/.tailchrome-stage.XXXXXX")" ||
  die "could not create same-directory staging file"
cp -- "$artifact_path" "$stage_path" || die "could not stage verified helper"
chmod 755 -- "$stage_path" || die "could not make staged helper executable"

if [[ -e "$final_path" || -L "$final_path" ]]; then
  [[ -f "$final_path" && ! -L "$final_path" ]] || die "installed path is not a regular file: $final_path"
  had_previous=true
  backup_path="$(mktemp "$bin_dir/.tailchrome-backup.XXXXXX")" || die "could not create backup path"
  rm -f -- "$backup_path" || die "could not prepare backup path"
  if ! ln "$final_path" "$backup_path" 2>/dev/null; then
    cp -p "$final_path" "$backup_path" || die "could not preserve previous helper"
  fi
fi
if ! mv -- "$stage_path" "$final_path"; then
  die "could not activate verified helper"
fi
stage_path=""
activated=true

# The final path exists before registration. A failure exits through cleanup,
# which restores the prior executable or removes this new file.
if ! "$final_path" install "${registration_args[@]}"; then
  die "install registration failed; previous helper was preserved"
fi
activated=false

printf 'Installed helper: %s\n' "$final_path"
quoted_version="$(shell_quote "$version")"
quoted_bin_dir="$(shell_quote "$bin_dir")"
if [[ -n "$installer_source_path" ]]; then
  removal_command="bash $(shell_quote "$installer_source_path") --version $quoted_version --bin-dir $quoted_bin_dir --uninstall"
else
  installer_url="$RELEASES_URL/download/$version/tailchrome-install.sh"
  [[ "$installer_url" == https://* ]] || die "installer removal URL must use HTTPS"
  removal_command="curl --disable --fail --silent --show-error --location --proto '=https' --proto-redir '=https' --tlsv1.2 --output - $(shell_quote "$installer_url") | bash -s -- --version $quoted_version --bin-dir $quoted_bin_dir --uninstall"
fi
if [[ -n "$user_data_dir" ]]; then
  removal_command+=" --user-data-dir $(shell_quote "$user_data_dir")"
fi
printf 'To remove this installation (pinned to %s), run:\n  %s\n' "$version" "$removal_command"
exit 0
