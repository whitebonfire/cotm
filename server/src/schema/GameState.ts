import { Schema, MapSchema, type } from "@colyseus/schema";

/**
 * A body at the party. NPC or human — deliberately the same class.
 *
 * THIS IS A SECURITY BOUNDARY, not just a data model.
 *
 * If humans lived in `state.players` and NPCs in `state.npcs`, the Detective's
 * client could tell them apart by reading which map a body came from, and no
 * amount of visual disguise would matter. Same if the map keys were session
 * IDs for humans and "npc-4" for the rest. So: one map, opaque IDs for every
 * body, and the session -> body mapping stays in server memory where the wire
 * never sees it.
 *
 * The rule to hold on to as this grows: nothing that distinguishes a human
 * body from an AI body may ever become a @type() field. See SOW section 7.1.
 */
export class Person extends Schema {
  @type("string") name: string = "";

  @type("number") x: number = 0;
  @type("number") y: number = 0;
  @type("number") z: number = 0;
  /** Facing, radians. */
  @type("number") yaw: number = 0;

  /** Action enum from world/house.ts — what this body is doing. */
  @type("uint8") action: number = 0;

  // ---- appearance. Fixed for the round; a Spy inherits the body they take.
  @type("uint8") skin: number = 0;
  @type("uint8") hair: number = 0;
  @type("uint8") hairHue: number = 0;
  @type("uint8") outfitHue: number = 0;
  @type("uint8") outfitVal: number = 0;
  /** 0 = twenties … 3 = elderly. Drives height and posture. */
  @type("uint8") age: number = 0;
  @type("uint8") hat: number = 0;
  /** Accessory — some of these are what the Spy will be sent to steal. */
  @type("uint8") acc: number = 0;
  /** 0-255 mapped to a height multiplier. */
  @type("uint8") height: number = 128;
}

export class HouseState extends Schema {
  @type({ map: Person }) people = new MapSchema<Person>();
}
