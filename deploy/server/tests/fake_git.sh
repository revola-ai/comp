#!/usr/bin/env bash
# A stand-in for git, used by deploy/server/tests/release*.test.sh on the laptop side
# (release.sh's pushed check) and the server side (the checkout of /opt/comp/src). Every call
# is appended to $FAKE_GIT_LOG as "git <args>". Knobs (environment):
#   FAKE_GIT_COMMITS   full SHAs that exist (rev-parse resolves a unique prefix of one)
#   FAKE_GIT_PUSHED    full SHAs some origin branch contains
#   FAKE_GIT_DIRTY     what `status --porcelain` prints (local changes on the server)
#   FAKE_GIT_HEAD      the file that holds the checked-out SHA
#   FAKE_GIT_STALE     full SHAs only on a branch deleted on GitHub: `fetch --prune` drops it
# A checkout writes a file new to the tree, packages/db/prisma/migrations/<new>/migration.sql,
# under the caller's umask, as git would.
printf 'git %s\n' "$*" >>"$FAKE_GIT_LOG"
args=("$@") dir=.
while [[ "${args[0]:-}" == -C || "${args[0]:-}" == -c ]]; do
  [[ "${args[0]}" == -C ]] && dir="${args[1]}"
  args=("${args[@]:2}")
done
case "${args[0]:-}" in
  fetch) [[ " ${args[*]} " == *" --prune "* ]] && : >"$FAKE_GIT_HEAD.pruned"; exit 0 ;;
  status) [[ -z "${FAKE_GIT_DIRTY:-}" ]] || printf '%s\n' "$FAKE_GIT_DIRTY"; exit 0 ;;
  checkout)
    printf '%s\n' "${args[-1]}" >"$FAKE_GIT_HEAD"
    mkdir -p "$dir/packages/db/prisma/migrations/20261001000000_add_widget"
    printf 'CREATE TABLE widget ();\n' >"$dir/packages/db/prisma/migrations/20261001000000_add_widget/migration.sql"
    exit 0
    ;;
  branch)
    for sha in ${FAKE_GIT_STALE:-}; do
      [[ "$sha" == "${args[-1]}" && ! -e "$FAKE_GIT_HEAD.pruned" ]] && printf '  origin/old-branch\n' && exit 0
      [[ "$sha" == "${args[-1]}" ]] && exit 0
    done
    for sha in ${FAKE_GIT_PUSHED:-}; do
      [[ "$sha" == "${args[-1]}" ]] && printf '  origin/HEAD -> origin/main\n  origin/main\n'
    done
    exit 0
    ;;
  rev-parse)
    if [[ "${args[-1]}" == HEAD ]]; then cat "$FAKE_GIT_HEAD"; exit; fi
    want="${args[-1]%^\{commit\}}" found=""
    for sha in ${FAKE_GIT_COMMITS:-}; do [[ "$sha" == "$want"* ]] && found+="$sha "; done
    [[ -n "$found" && "$found" != *" "*" "* ]] || exit 1
    printf '%s\n' "${found% }"
    exit 0
    ;;
esac
echo "fake git: $* is not known" >&2
exit 1
