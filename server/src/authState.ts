/**
 * A tiny indirection so the Colyseus rooms can ask "who is this session?"
 * WITHOUT statically importing the database layer. That matters: db/index.ts
 * throws when DATABASE_URL is unset, and the game's headless tests launch the
 * server with no database. index.ts wires a resolver in only when auth is on;
 * otherwise everything here reports "disabled / anonymous" and the game runs
 * exactly as it did before accounts existed.
 */
export interface SessionUser {
  id: string;
  name: string;
  friendCode: string | null;
}

type Resolver = (headers: Record<string, string | string[] | undefined>) => Promise<SessionUser | null>;

let resolver: Resolver | null = null;

export const authState = {
  /** True once index.ts has wired Better Auth in (i.e. DATABASE_URL was set). */
  get enabled(): boolean {
    return resolver !== null;
  },
  setResolver(fn: Resolver) {
    resolver = fn;
  },
  /** Resolve the signed-in user from request headers, or null if not signed in
   *  (or auth is disabled). Never throws. */
  async getUser(
    headers: Record<string, string | string[] | undefined>
  ): Promise<SessionUser | null> {
    if (!resolver) return null;
    try {
      return await resolver(headers);
    } catch {
      return null;
    }
  },
};
