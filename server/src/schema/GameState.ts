import { Schema, MapSchema, type } from "@colyseus/schema";

/**
 * A body in the world.
 *
 * Only fields declared with @type() cross the wire. That is the whole security
 * model later on: when the Spy exists (milestone 3), their role must never
 * appear on a Schema the Detective's client can decode. See SOW section 7.1.
 */
export class Player extends Schema {
  @type("string") name: string = "";
  @type("number") x: number = 0;
  @type("number") y: number = 0;
  @type("number") z: number = 0;
  /** Facing, radians. */
  @type("number") yaw: number = 0;
  /** 0-360, just so the two capsules are told apart during milestone 1. */
  @type("number") hue: number = 0;
}

export class HouseState extends Schema {
  @type({ map: Player }) players = new MapSchema<Player>();
}
