'use strict';

/**
 * NEW 8.0 (ARCHITECTURE_v8.md §3): the action-dispatch core. Wraps every
 * state-changing GameTable action method so each one routes through one
 * common choke point, producing a small, structured record of what
 * happened -- actor, action type, and the rest of the call's arguments --
 * alongside its existing {ok, error} return value.
 *
 * This exists to anticipate future action/stat logging (game > cycle >
 * hand tracking, eventually real-time and surfaced to players) WITHOUT
 * building any of it -- no persistence, no storage format, no UI. If
 * action methods stayed individually free-form until logging eventually
 * gets built, adding it later would mean touching every single action
 * method a second time. Since they already produce this uniform record
 * as a side effect of v8.0, "log this" becomes "start consuming
 * `gameTable.onAction`," not a second redesign pass.
 *
 * Deliberately NOT scoped here: any array/buffer that accumulates these
 * records over time. Retaining a growing log is itself a storage-format
 * decision (explicitly out of scope for v8.0) -- this module only
 * forwards each record, once, to an optional `onAction` hook the caller
 * can set on a GameTable instance. If nothing is listening, the record
 * is simply attached to the action's own return value (`result.action`)
 * and otherwise discarded -- useful for tests/debugging even with no
 * consumer wired up.
 *
 * ACTION_METHODS lists every action method wrapped, with the zero-based
 * argument index of its actor (`requesterId`). `deal(cardsPerPlayer,
 * requesterId, faceUpOverride)` is the one method whose actor isn't
 * argument 0, a small, real illustration of the RAD-origin signature
 * inconsistency this whole refactor is responding to; every other
 * action method already puts the actor first.
 *
 * Deliberately excluded: `addPlayer`/`removePlayer`. Every method listed
 * below follows the same "requester attempts an action, validated
 * against current state, returns `{ ok, error }`" shape -- that
 * uniformity is what makes one generic wrapper safe to apply blindly.
 * `addPlayer`/`removePlayer` are a different shape entirely (identity
 * operations returning the player object or nothing, called directly by
 * `server.js` on connect/disconnect, never validated against a
 * requester) -- forcing them into the `{ ok, error }` contract just to
 * fit this wrapper would be a real behavioral/call-site change to a
 * foundational method every other test already depends on, not a safe
 * mechanical wrap. Left out on purpose, not missed.
 */

const ACTION_METHODS = {
  deal: 1,
  reshuffle: 0,
  discard: 0,
  standPat: 0,
  dealToPlayer: 0,
  dealToAllPlayers: 0,
  dealCommunity: 0,
  burn: 0,
  rabbitHunt: 0,
  passTheBuck: 0,
  startGame: 0,
  newHand: 0,
  setGameChoice: 0,
  setGameOption: 0,
  advanceTurn: 0,
  openBetting: 0,
  setOpeningBettor: 0,
  placeBet: 0,
  call: 0,
  check: 0,
  fold: 0,
  setAnteBlind: 0,
  postAnteBlind: 0,
  claimPot: 0,
  resolveClaim: 0,
  revealHand: 0,
  setTableName: 0,
  setSuggestedBuyIn: 0,
  buyChips: 0,
  sitOut: 0,
  sitIn: 0,
  // NEW 8.1
  declare: 0,
  payDealInterrupt: 0,
  buyDealInterrupt: 0,
  declineDealInterrupt: 0,
  // NEW 8.2
  killHandStartConfirm: 0,
  killHandCancelConfirm: 0,
  // NEW 9.0
  allIn: 0,
};

/**
 * Applies the dispatch wrapper to every method named in ACTION_METHODS
 * on the given prototype, in place. Called once, on GameTable.prototype,
 * at module load time (see gameTable.js) -- confirmed safe because no
 * action method calls another action method internally (verified by
 * grep across the whole class; every cross-method call goes through an
 * `_`-prefixed internal helper instead), so double-wrapping via an
 * internal call path can't happen.
 *
 * Throws at load time (not silently skips) if a listed method is
 * missing -- deliberately loud, so a future rename or removal shows up
 * immediately as a startup crash instead of a silently-unwrapped action,
 * the exact class of "nothing caught this gap" bug this refactor exists
 * to prevent a fourth instance of.
 *
 * `manifest` defaults to the real `ACTION_METHODS` above -- the only
 * caller in production (gameTable.js) always uses the default. The
 * parameter exists so test/actionDispatch.test.js can verify the
 * wrapping mechanism itself against a small fake prototype, in
 * isolation from GameTable's own 30+ real action methods, without
 * changing this function's actual production behavior at all.
 */
function installActionDispatch(proto, manifest = ACTION_METHODS) {
  for (const [methodName, actorIndex] of Object.entries(manifest)) {
    const original = proto[methodName];
    if (typeof original !== 'function') {
      throw new Error(`installActionDispatch: GameTable.prototype.${methodName} does not exist`);
    }
    proto[methodName] = function actionDispatchWrapper(...args) {
      const result = original.apply(this, args);
      if (result && typeof result === 'object' && typeof result.ok === 'boolean') {
        const record = {
          type: methodName,
          actorId: args[actorIndex] ?? null,
          args: args.filter((_, i) => i !== actorIndex),
          ok: result.ok,
          error: result.error || null,
          at: Date.now(),
        };
        result.action = record;
        if (typeof this.onAction === 'function') this.onAction(record);
      }
      return result;
    };
    // Preserve the original method's declared arity. A plain `(...args)`
    // wrapper's own `.length` is always 0, which silently breaks any
    // code (including two existing tests, `passTheBuck.length` and
    // `dealToAllPlayers.length`) that reads a method's arity as a proxy
    // for "this API genuinely takes exactly N arguments" -- both of
    // those tests exist specifically to document that those two methods
    // dropped a parameter in past releases (5.0, 5.1) and never regained
    // it. `Function.prototype.length` is non-writable but IS
    // configurable, so `Object.defineProperty` can restore it here.
    Object.defineProperty(proto[methodName], 'length', { value: original.length, configurable: true });
  }
}

module.exports = { installActionDispatch, ACTION_METHODS };
