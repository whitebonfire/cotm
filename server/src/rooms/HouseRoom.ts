import { Room, Client } from "@colyseus/core";
import { HouseState, Player } from "../schema/GameState.js";
import { HOUSE, SPAWNS, resolveCollisions, roomAt } from "../world/house.js";

interface InputMessage {
  /** Forward axis, -1..1 */
  f: number;
  /** Strafe axis, -1..1 */
  r: number;
  /** Camera yaw in radians, which is what movement is relative to. */
  yaw: number;
}

interface StoredInput extends InputMessage {
  /** When it arrived, so we can let it go stale. */
  at: number;
}

/** Metres per second. */
export const SPEED = 4.2;

const TICK_MS = 1000 / 20;

/**
 * Inputs expire. Clients send at 20Hz, so anything older than this means the
 * client went quiet — a lag spike, a backgrounded tab, a closing laptop.
 * Without expiry the server would keep applying the last input forever and
 * walk them into a wall while they weren't even connected.
 */
const INPUT_STALE_MS = 250;

const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/**
 * Server-authoritative movement.
 *
 * Clients send *intent* (which keys are down, where the camera points) and
 * never a position. The server owns every coordinate in the game. This is
 * milestone 1's real payload: doing it now means we never retrofit authority
 * later, when there is a Spy identity worth cheating for.
 */
export class HouseRoom extends Room<HouseState> {
  maxClients = 8;

  private inputs = new Map<string, StoredInput>();

  onCreate() {
    this.setState(new HouseState());
    this.setPatchRate(50);

    this.onMessage("input", (client: Client, msg: InputMessage) => {
      // Never trust the wire: clamp the axes and drop anything non-finite.
      this.inputs.set(client.sessionId, {
        f: clamp(num(msg?.f), -1, 1),
        r: clamp(num(msg?.r), -1, 1),
        yaw: num(msg?.yaw),
        at: Date.now(),
      });
    });

    this.setSimulationInterval((deltaMs) => this.tick(deltaMs / 1000), TICK_MS);
  }

  onJoin(client: Client, options?: { name?: string }) {
    const player = new Player();

    const raw = typeof options?.name === "string" ? options.name.trim().slice(0, 16) : "";
    player.name = raw || `guest-${client.sessionId.slice(0, 4)}`;

    // Everyone arrives through the front door.
    const spawn = SPAWNS[this.state.players.size % SPAWNS.length];
    player.x = spawn.x;
    player.z = spawn.z;
    player.yaw = Math.PI; // facing into the house
    player.hue = (this.state.players.size * 67) % 360;

    this.state.players.set(client.sessionId, player);
    console.log(`[house] ${player.name} joined (${this.state.players.size} in room ${this.roomId})`);
  }

  onLeave(client: Client) {
    this.state.players.delete(client.sessionId);
    this.inputs.delete(client.sessionId);
    console.log(`[house] ${client.sessionId} left (${this.state.players.size} remain)`);
  }

  onDispose() {
    console.log(`[house] room ${this.roomId} disposed`);
  }

  private tick(dt: number) {
    const now = Date.now();

    this.state.players.forEach((player, sessionId) => {
      const input = this.inputs.get(sessionId);
      if (!input) return;

      // Client went quiet — stop, don't coast.
      if (now - input.at > INPUT_STALE_MS) {
        this.inputs.delete(sessionId);
        return;
      }

      // Movement is relative to where the camera is looking. Three.js cameras
      // look down -Z, so forward is (-sin yaw, -cos yaw).
      const forwardX = -Math.sin(input.yaw);
      const forwardZ = -Math.cos(input.yaw);
      const rightX = Math.cos(input.yaw);
      const rightZ = -Math.sin(input.yaw);

      let dx = forwardX * input.f + rightX * input.r;
      let dz = forwardZ * input.f + rightZ * input.r;

      const len = Math.hypot(dx, dz);
      if (len < 0.001) return;

      // Normalise so diagonals aren't faster than the axes.
      dx = (dx / len) * SPEED * dt;
      dz = (dz / len) * SPEED * dt;

      // Walls are enforced here, not on the client. The client runs the same
      // resolveCollisions() to predict, but this call is the one that counts.
      const solved = resolveCollisions(player.x + dx, player.z + dz);

      // Last-resort clamp. resolveCollisions should never let anyone out of
      // the shell, but if it ever did, a body loose outside the house would be
      // unreachable and unguessable.
      player.x = clamp(solved.x, HOUSE.x1, HOUSE.x2);
      player.z = clamp(solved.z, HOUSE.z1, HOUSE.z2);
      player.yaw = Math.atan2(dx, dz);
    });
  }
}
