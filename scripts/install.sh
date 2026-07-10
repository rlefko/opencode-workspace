#!/usr/bin/env bash
#
# Install this harness into a live opencode config directory (~/.opencode by
# default). Only the managed set below is ever touched; node_modules,
# package-lock.json, bin/, .gitignore, and any other user files are left alone.
#
# Usage:
#   scripts/install.sh              # copy repo -> target, backing up overwrites
#   scripts/install.sh --dry-run    # show what would change, change nothing
#   scripts/install.sh --link       # symlink managed items to the repo (live dev)
#   scripts/install.sh --target DIR # install somewhere other than ~/.opencode

set -euo pipefail

MANAGED_DIRS=(plugins agents commands skills tools workflows)
MANAGED_FILES=(opencode.jsonc harness.jsonc package.json)

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TARGET="${HOME}/.opencode"
DRY_RUN=0
LINK_MODE=0

while [[ $# -gt 0 ]]; do
	case "$1" in
		--dry-run) DRY_RUN=1 ;;
		--link) LINK_MODE=1 ;;
		--target)
			shift
			TARGET="${1:?--target requires a directory}"
			;;
		*)
			echo "Unknown option: $1" >&2
			exit 1
			;;
	esac
	shift
done

if [[ ! -f "${REPO}/opencode.jsonc" ]]; then
	echo "Refusing to run: ${REPO}/opencode.jsonc not found (is this the harness repo?)" >&2
	exit 1
fi

mkdir -p "${TARGET}"
BACKUP="${TARGET}/.backups/$(date +%Y%m%d-%H%M%S)"
BACKED_UP=0

backup_item() {
	local item="$1"
	local target_path="${TARGET}/${item}"
	[[ -e "${target_path}" || -L "${target_path}" ]] || return 0
	# A symlink already pointing at the repo needs no backup.
	if [[ -L "${target_path}" && "$(readlink "${target_path}")" == "${REPO}/${item}" ]]; then
		return 0
	fi
	mkdir -p "${BACKUP}/$(dirname "${item}")"
	cp -a "${target_path}" "${BACKUP}/${item}"
	BACKED_UP=1
}

if [[ ${DRY_RUN} -eq 1 ]]; then
	echo "== DRY RUN: no changes will be made =="
	for dir in "${MANAGED_DIRS[@]}"; do
		[[ -d "${REPO}/${dir}" ]] || continue
		echo "--- ${dir}/ ---"
		rsync -ain --delete --exclude "*.test.ts" "${REPO}/${dir}/" "${TARGET}/${dir}/" 2>/dev/null || true
	done
	for file in "${MANAGED_FILES[@]}"; do
		[[ -f "${REPO}/${file}" ]] || continue
		echo "--- ${file} ---"
		diff -u "${TARGET}/${file}" "${REPO}/${file}" 2>/dev/null || true
	done
	exit 0
fi

echo "Installing ${REPO} -> ${TARGET} ($( [[ ${LINK_MODE} -eq 1 ]] && echo "symlink mode" || echo "copy mode" ))"

for dir in "${MANAGED_DIRS[@]}"; do
	[[ -d "${REPO}/${dir}" ]] || continue
	backup_item "${dir}"
	if [[ ${LINK_MODE} -eq 1 ]]; then
		rm -rf "${TARGET:?}/${dir}"
		ln -sfn "${REPO}/${dir}" "${TARGET}/${dir}"
		echo "linked   ${dir}/"
	else
		# Managed dirs are fully repo-owned; --delete is safe because the prior
		# state was just backed up. Test files stay in the repo.
		rsync -a --delete --exclude "*.test.ts" "${REPO}/${dir}/" "${TARGET}/${dir}/"
		echo "synced   ${dir}/"
	fi
done

PACKAGE_JSON_CHANGED=0
for file in "${MANAGED_FILES[@]}"; do
	[[ -f "${REPO}/${file}" ]] || continue
	if [[ "${file}" == "package.json" ]] && ! cmp -s "${REPO}/${file}" "${TARGET}/${file}" 2>/dev/null; then
		PACKAGE_JSON_CHANGED=1
	fi
	backup_item "${file}"
	if [[ ${LINK_MODE} -eq 1 ]]; then
		rm -f "${TARGET}/${file}"
		ln -sfn "${REPO}/${file}" "${TARGET}/${file}"
		echo "linked   ${file}"
	else
		install -m 644 "${REPO}/${file}" "${TARGET}/${file}"
		echo "synced   ${file}"
	fi
done

if [[ ${BACKED_UP} -eq 1 ]]; then
	echo ""
	echo "Previous versions backed up to: ${BACKUP}"
fi

if [[ ${PACKAGE_JSON_CHANGED} -eq 1 ]]; then
	if command -v bun >/dev/null 2>&1; then
		echo "package.json changed; running bun install in ${TARGET}"
		(cd "${TARGET}" && bun install)
	else
		echo "package.json changed; run: cd ${TARGET} && bun install"
	fi
fi

echo ""
echo "Done. Restart opencode to pick up the new plugins and config."
