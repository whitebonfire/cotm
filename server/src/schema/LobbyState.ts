import { Schema, MapSchema, type } from "@colyseus/schema";

/**
 * A player waiting in the lobby (SOW §6.2). Unlike the house, there is no
 * disguise to protect here — friends waiting together know each other's names,
 * so this is plain, readable state keyed by session id.
 */
export class LobbyPlayer extends Schema {
  @type("string") name: string = "";
  @type("string") friendCode: string = "";
  /** The toy chosen in the lobby: 0 none, 1 detective, 2 spy. Purely cosmetic —
   *  nothing to do with the role dealt in the round (SOW §6.2). */
  @type("uint8") toy: number = 0;
  @type("boolean") host: boolean = false;
}

export class LobbyState extends Schema {
  /** The join code friends type to get in — the Colyseus room id. */
  @type("string") code: string = "";
  /** Flips true once the host starts; clients then jump to the house room. */
  @type("boolean") started: boolean = false;
  @type({ map: LobbyPlayer }) players = new MapSchema<LobbyPlayer>();
}
