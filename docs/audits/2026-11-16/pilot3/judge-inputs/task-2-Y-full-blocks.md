Q09 | answered | The host first checks that the worktree directory is present (requirePresentWorktree). mergeWorktree then checks, in order:
1. revision names (assertRevisions → InvalidRevisionError);
2. that the base is checked out (base_not_checked_out);
3. that the own copy (unless removed) and the base have their .git pinned (GitStateError worktree-corrupt);
4. that the base is clean (base_dirty);
5. that the own copy is clean (uncommitted).
Only then does it run `git merge --no-ff -m <msg> --end-of-options <branch>` in the base. mergeCheck (merge-tree) is not called on this path. On a failed merge it lists the conflicted files (`git diff --diff-filter=U --name-only -z`), runs `merge --abort` and returns reason `conflict` with the files. | sources: packages/host/src/worktrees/worktrees-service.ts:121-135, worktrees-service.ts:210-214, packages/core/src/work/worktree.ts:1301-1339, worktree.ts:424-432, worktree.ts:691-699, worktree.ts:840-845, worktree.ts:863-873, worktree.ts:1059-1079 | verifier: PASS (C36–C39)

Q10 | answered | In the main checkout:
- .worktreeinclude must be a regular, non-empty file of at most 256 KiB;
- candidates come from `git ls-files -z --others --ignored --directory --exclude-from=<file>`, intersected with the paths ignored by `--exclude-standard`;
- safeEntry drops empty or absolute paths, `..` or empty segments, and a leading `.git`;
- `git check-ignore --stdin` must confirm each path;
- paths are deduped, sorted and lose a trailing "/"; entries nested under a chosen directory are dropped; missing paths and symlinks (lstat) are dropped;
- at most 1000 entries are kept.
In the new worktree, check-ignore runs in the target root and only paths ignored there too are kept. Any git failure gives an empty list. | sources: packages/core/src/work/worktree-include.ts:14-16, worktree-include.ts:47-60, worktree-include.ts:66-82, worktree-include.ts:88-130, worktree-include.ts:139-158 | verifier: PASS (C40–C45)

Q12 | answered | Extra writable roots are added when all of these hold: the runner is codex; the session is not a workspace (autonomous) clone; the role is not readOnly; role.sandboxMode === 'workspace-write'; session.worktree is set; the launch template contains {approvals}. They are passed as `-c sandbox_workspace_write.writable_roots=<JSON array>`. prepareWorktreeGitWrites must pass first, checking in order:
1. the branch name is parley/<work>/<session> or legacy harnas/<work>/<session>;
2. assertRevisions;
3. the git-common-dir is resolved;
4. checkoutGitDir(common, cwd) is not null and ≠ common;
5. HEAD is a symbolic ref to refs/heads/<branch>;
6. the parent directories of refs/heads and logs/refs/heads are created inside common and are directories;
7. the branch ref, ref.lock, branch log and log.lock are regular files where they exist;
8. objects is a directory.
Any failure is GitStateError worktree-corrupt. Exactly six locations are granted: the worktree's own gitDir, <common>/objects, <common>/refs/heads/<branch> and its .lock, and <common>/logs/refs/heads/<branch> and its .lock. | sources: packages/core/src/work/launch.ts:497-506, packages/core/src/work/worktree.ts:631-671 | verifier: PASS (C53–C55)
