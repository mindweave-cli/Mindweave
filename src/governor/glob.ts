/**
 * glob.ts — the one gitignore-ish path matcher the governor shares.
 *
 * Both the forbidden deny-list and glob-scoped rules ask the same question: does
 * this project-relative path match a pattern? `**` spans path segments, `*`/`?`
 * stay within one, and a bare folder/file prefix (no wildcards) matches the path
 * itself and everything under it (so `src/api` covers `src/api/x.ts`).
 */

/** The non-wildcard prefix of a pattern (used for dir matching + command scan). */
export function literalPrefix(pattern: string): string {
  const wildcard = pattern.search(/[*?]/);
  const prefix = wildcard === -1 ? pattern : pattern.slice(0, wildcard);
  return prefix.replace(/\/+$/, "");
}

/**
 * Translate a glob to an anchored RegExp (`**` spans segments, `*`/`?` don't).
 *
 * CASE-INSENSITIVE, and that is a correctness fix rather than a convenience. Windows
 * and macOS filesystems are case-insensitive, so `.env` and `.ENV` are one file — but
 * this matcher backs the forbidden deny-list, and a case-sensitive compare let the
 * second spelling straight past a rule written with the first. Nothing adversarial was
 * needed: a model that writes `.ENV` because it saw that spelling somewhere silently
 * escaped the deny-list and wrote the very file it was forbidden.
 *
 * Always, rather than switched on the platform. A deny-list should err towards denying,
 * and a guard that protects you on one machine and not another is worse than one that
 * is merely slightly broad: it makes the same rule mean two things. The cost on a
 * case-sensitive filesystem is that `src/Foo` and `src/foo`, genuinely different files
 * there, are covered by one pattern. For a deny-list that is the safe direction, and
 * for glob-scoped rules, which are advisory, it is harmless.
 */
export function globToRegExp(glob: string): RegExp {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*") {
      if (glob[i + 1] === "*") {
        re += ".*";
        i++;
        if (glob[i + 1] === "/") i++; // collapse `**/` so it can match zero segments
      } else {
        re += "[^/]*";
      }
    } else if (c === "?") {
      re += "[^/]";
    } else if ("\\^$.|+()[]{}".includes(c)) {
      re += "\\" + c;
    } else {
      re += c;
    }
  }
  return new RegExp("^" + re + "$", "i");
}

/** Does one project-relative POSIX path match one glob pattern? */
export function globMatch(relPosixPath: string, glob: string): boolean {
  if (globToRegExp(glob).test(relPosixPath)) return true;
  const prefix = literalPrefix(glob);
  // Folded to one case for the same reason the regex is: a bare-prefix pattern is the
  // commonest kind of forbidden entry (`src/legacy`, `secrets`), so a case-sensitive
  // compare here would leave the widest half of the deny-list bypassable.
  const path = relPosixPath.toLowerCase();
  const lower = prefix.toLowerCase();
  return prefix !== "" && (path === lower || path.startsWith(lower + "/"));
}

/** Does any of `relPaths` match any of `globs`? */
export function anyPathMatches(relPaths: string[], globs: string[]): boolean {
  return globs.some((g) => relPaths.some((p) => globMatch(p, g)));
}
