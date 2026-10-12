#!/usr/bin/env bash
# A stand-in for git, used by deploy/server/tests/release*.test.sh on the laptop side
# (release.sh's pushed check) and the server side (the checkout of /opt/comp/src). Every call
# is appended to $FAKE_GIT_LOG as "git <args>". Knobs (environment):
#   FAKE_GIT_COMMITS   full SHAs that exist (rev-parse resolves a unique prefix of one)
#   FAKE_GIT_PUSHED    full SHAs some branch of the fork (revola-ai/comp) contains
#   FAKE_GIT_SELF_HOST full SHAs the fork's revola/self-host branch contains (`merge-base
#                      --is-ancestor`); the others of FAKE_GIT_PUSHED are on a feature branch only
#   FAKE_GIT_UPSTREAM  full SHAs only on another remote (upstream trycompai/comp, `origin` in
#                      Kyle's checkout): `branch -r` lists them, the fork's refs do not
#   FAKE_GIT_DIRTY     what `status --porcelain` prints (local changes on the server)
#   FAKE_GIT_HEAD      the file that holds the SHA checked out in the main checkout (/opt/comp/src)
#   FAKE_GIT_STALE     full SHAs only on a fork branch deleted on GitHub: `fetch --prune` drops it
#   FAKE_GIT_TREE      the files every commit has (a copy of the repository's deploy/server)
#   FAKE_GIT_OVERLAYS  <dir>/<full sha>/<path>: a file as that commit has it, instead
# Every fetch must name the fork's URL (never a remote name); any other source fails.
# A checkout (and `worktree add`, which writes the whole tree of FAKE_GIT_TREE) writes the files
# the commits' overlays differ in, as that commit has them, and a file new to the tree,
# packages/db/prisma/migrations/<new>/migration.sql, under the caller's umask, as git would. A
# linked worktree keeps its SHA in its .git file, so `rev-parse HEAD` there answers it.
printf 'git %s\n' "$*" >>"$FAKE_GIT_LOG"

write_tree() { # write_tree <dir> <sha>: the files any overlay changes, as <sha> has them
  local file rel overlays="${FAKE_GIT_OVERLAYS:-}"
  mkdir -p "$1/packages/db/prisma/migrations/20261001000000_add_widget"
  printf 'CREATE TABLE widget ();\n' >"$1/packages/db/prisma/migrations/20261001000000_add_widget/migration.sql"
  [[ -n "$overlays" && -d "$overlays" ]] || return 0
  while IFS= read -r file; do
    rel="${file#"$overlays"/}" && rel="${rel#*/}"
    if [[ -f "$overlays/$2/$rel" ]]; then
      cp -f "$overlays/$2/$rel" "$1/$rel"
    elif [[ -f "$FAKE_GIT_TREE/$rel" ]]; then
      cp -f "$FAKE_GIT_TREE/$rel" "$1/$rel"
    fi
  done < <(find "$overlays" -type f)
}
args=("$@") dir=.
while [[ "${args[0]:-}" == -C || "${args[0]:-}" == -c ]]; do
  [[ "${args[0]}" == -C ]] && dir="${args[1]}"
  args=("${args[@]:2}")
done
case "${args[0]:-}" in
  fetch)
    source="" prune=""
    for arg in "${args[@]:1}"; do
      case "$arg" in
        --prune) prune=1 ;;
        --*) ;;
        *) [[ -n "$source" ]] || source="$arg" ;;
      esac
    done
    if [[ "$source" != https://github.com/revola-ai/comp ]]; then
      echo "fake git: fetch from '$source': only https://github.com/revola-ai/comp is known" >&2
      exit 128
    fi
    [[ -z "$prune" ]] || : >"$FAKE_GIT_HEAD.pruned"
    exit 0
    ;;
  status) [[ -z "${FAKE_GIT_DIRTY:-}" ]] || printf '%s\n' "$FAKE_GIT_DIRTY"; exit 0 ;;
  checkout)
    printf '%s\n' "${args[-1]}" >"$FAKE_GIT_HEAD"
    write_tree "$dir" "${args[-1]}"
    exit 0
    ;;
  worktree) # worktree add --quiet --detach <dir> <sha> | remove --force <dir> | prune
    case "${args[1]:-}" in
      add)
        [[ "${args[*]:2:2}" == "--quiet --detach" && ${#args[@]} -eq 6 ]] || { echo "fake git: unexpected ${args[*]}" >&2; exit 129; }
        target="${args[4]}" sha="${args[5]}"
        [[ ! -e "$target" ]] || { echo "fatal: '$target' already exists" >&2; exit 128; }
        mkdir -p "$target" && cp -R "$FAKE_GIT_TREE/." "$target/" && write_tree "$target" "$sha" || exit 128
        printf 'gitdir: %s/.git/worktrees/%s\nHEAD: %s\n' "$dir" "${target##*/}" "$sha" >"$target/.git"
        ;;
      remove) [[ "${args[2]:-}" == --force && ${#args[@]} -eq 4 ]] && rm -rf "${args[3]}" ;;
      prune) ;;
      *) echo "fake git: unexpected ${args[*]}" >&2; exit 129 ;;
    esac
    exit
    ;;
  branch)
    for sha in ${FAKE_GIT_STALE:-}; do
      [[ "$sha" == "${args[-1]}" && ! -e "$FAKE_GIT_HEAD.pruned" ]] && printf '  origin/old-branch\n' && exit 0
      [[ "$sha" == "${args[-1]}" ]] && exit 0
    done
    for sha in ${FAKE_GIT_PUSHED:-} ${FAKE_GIT_UPSTREAM:-}; do
      [[ "$sha" == "${args[-1]}" ]] && printf '  origin/HEAD -> origin/main\n  origin/main\n'
    done
    exit 0
    ;;
  for-each-ref) # for-each-ref --contains <sha> --format=%(refname) <prefix>
    [[ "${args[1]}" == --contains && "${args[3]}" == '--format=%(refname)' && ${#args[@]} -eq 5 ]] || {
      echo "fake git: unexpected for-each-ref ${args[*]}" >&2
      exit 129
    }
    sha="${args[2]}" prefix="${args[4]}"
    for stale in ${FAKE_GIT_STALE:-}; do # only on the deleted branch, whatever else is set
      [[ "$stale" == "$sha" ]] || continue
      [[ -e "$FAKE_GIT_HEAD.pruned" || "$prefix" != refs/comp-release/ ]] || printf 'refs/comp-release/old-branch\n'
      exit 0
    done
    for pushed in ${FAKE_GIT_PUSHED:-}; do
      [[ "$pushed" == "$sha" && "$prefix" == refs/comp-release/ ]] || continue
      if [[ " ${FAKE_GIT_SELF_HOST:-} " == *" $sha "* ]]; then
        printf 'refs/comp-release/revola/self-host\n'
      else
        printf 'refs/comp-release/feature/widget\n'
      fi
    done
    for upstream in ${FAKE_GIT_UPSTREAM:-}; do
      [[ "$upstream" == "$sha" && "$prefix" == refs/remotes/ ]] && printf 'refs/remotes/origin/main\n'
    done
    exit 0
    ;;
  merge-base) # merge-base --is-ancestor <sha> <the fork's revola/self-host, laptop or server ref>
    case "${args[3]:-}" in
      refs/comp-release/revola/self-host | refs/remotes/origin/revola/self-host) ;;
      *) echo "fake git: unexpected merge-base ${args[*]}" >&2; exit 128 ;;
    esac
    [[ "${args[1]}" == --is-ancestor && ${#args[@]} -eq 4 ]] || { echo "fake git: unexpected merge-base ${args[*]}" >&2; exit 129; }
    [[ " ${FAKE_GIT_SELF_HOST:-} " == *" ${args[2]} "* ]]
    exit
    ;;
  rev-parse)
    if [[ "${args[-1]}" == HEAD && -f "$dir/.git" ]]; then sed -n 's/^HEAD: //p' "$dir/.git"; exit; fi
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
