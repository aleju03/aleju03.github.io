/*
 * The ownership rules of one world, assembled: protection.js (friends, the
 * switch, mutes, kicks, the vote) and claims.js (chunk claims) wired to each
 * other over the same `players`. It is a factory on purpose. A world that has
 * rooms builds one of these per room, inside the room builder, handed that
 * room's own `players` map, so a room's protection switch, its claims, its
 * votes and its mutes are its own and nothing leaks between rooms. What is
 * NOT per room is passed in: the friends store is the database's (an
 * account's list follows it into every room), and `isPrivate` says whether
 * this world is a private one (a higher prop cap).
 */
import { createProtection } from './protection.js';
import { createClaims } from './claims.js';

export function createWorldSocial({ players, send, name, eject, store = null, isPrivate = () => false, now = Date.now }) {
  const protection = createProtection({ players, send, name, eject, store, isPrivate, now });
  const claims = createClaims({ players, send, protection, name, now });
  protection.attach(claims);
  return { protection, claims };
}
