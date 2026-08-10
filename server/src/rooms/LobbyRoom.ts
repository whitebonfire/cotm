import { Room, Client, matchMaker, type AuthContext } from "@colyseus/core";
import { LobbyState, LobbyPlayer } from "../schema/LobbyState.js";
import { authState, type SessionUser } from "../authState.js";

const TOY = { none: 0, detective: 1, spy: 2 } as const;

/**
 * The waiting room (SOW §6.2). Friends gather here before a round: one creates
 * a lobby and shares the code, the other joins by code. Both can toy with the
 * Detective/Spy buttons, and the host starts the round — which spins up a fresh
 * house room and sends everyone its id to join.
 *
 * Requires a signed-in user (the lobby only exists when auth is enabled), so
 * onAuth rejects anyone without a valid session.
 */
export class LobbyRoom extends Room<LobbyState> {
  maxClients = 8;

  private users = new Map<string, SessionUser>(); // sessionId -> account

  async onAuth(_client: Client, _options: unknown, context: AuthContext) {
    const user = await authState.getUser(context?.headers ?? {});
    if (!user) throw new Error("You must be signed in to use a lobby.");
    return user;
  }

  onCreate() {
    this.setState(new LobbyState());
    this.state.code = this.roomId;

    this.onMessage("set_toy", (client, msg: { toy?: string }) => {
      const p = this.state.players.get(client.sessionId);
      if (!p) return;
      const key = (msg?.toy ?? "none") as keyof typeof TOY;
      p.toy = TOY[key] ?? 0;
    });

    this.onMessage("start", async (client) => {
      const p = this.state.players.get(client.sessionId);
      if (!p?.host) {
        client.send("lobby_error", { reason: "Only the host can start." });
        return;
      }
      if (this.state.players.size < 2) {
        client.send("lobby_error", { reason: "You need a second player to start." });
        return;
      }
      if (this.state.started) return;
      await this.startGame();
    });
  }

  onJoin(client: Client, _options: unknown, auth?: SessionUser) {
    const user = auth!;
    this.users.set(client.sessionId, user);

    const p = new LobbyPlayer();
    p.name = user.name;
    p.friendCode = user.friendCode ?? "";
    // First one in owns the lobby and is the only one who can start.
    p.host = this.state.players.size === 0;
    this.state.players.set(client.sessionId, p);
    console.log(`[lobby ${this.roomId}] ${user.name} joined (${this.state.players.size})`);
  }

  onLeave(client: Client) {
    const wasHost = this.state.players.get(client.sessionId)?.host ?? false;
    this.state.players.delete(client.sessionId);
    this.users.delete(client.sessionId);

    // If the host left, promote whoever's next so the lobby can still start.
    if (wasHost) {
      const next = this.state.players.values().next().value as LobbyPlayer | undefined;
      if (next) next.host = true;
    }
    console.log(`[lobby ${this.roomId}] a player left (${this.state.players.size} remain)`);
  }

  /** Create a fresh house room and send everyone its id to join. Each player is
   *  told whether they're the host, so the lobby host becomes the role-picker in
   *  the house no matter whose socket connects first. */
  private async startGame() {
    const room = await matchMaker.createRoom("house", { fromLobby: true });
    this.state.started = true;
    for (const client of this.clients) {
      const host = this.state.players.get(client.sessionId)?.host ?? false;
      client.send("start_game", { roomId: room.roomId, host });
    }
    console.log(`[lobby ${this.roomId}] starting -> house ${room.roomId}`);
    // The lobby SURVIVES the round: players stay connected to it while they play
    // and come back here when the round ends, instead of being kicked out to the
    // menu. `started` only guards against double-starting during the hand-off, so
    // clear it once everyone has had time to join the house.
    this.clock.setTimeout(() => {
      this.state.started = false;
    }, 3000);
  }
}
