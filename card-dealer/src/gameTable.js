'use strict';

const { buildDeck, shuffle } = require('./deck');
const GAME_CHOICES = require('../public/game-choices.json');
const { createPlayer, buyChips: bankBuyChips, snapshot: snapshotPlayers, restore: restorePlayers } = require('./player');
const { getProfileTable, isPhaseGated } = require('./profiles');
const { installActionDispatch } = require('./actionDispatch');

const MAX_PLAYERS = 8;
const MIN_PLAYERS_TO_DEAL = 2;
const MAX_TABLE_NAME_LENGTH = 40;

// Beta-window escape hatch, added for 11.4 (the-cut-spec_v11-4.md
// Part D.3). Mike specifically wanted an easy, single-point revert
// available while validating this against his own test scenarios,
// given this touches the betting rail this close to Beta.
//
// true  (as shipped): canBetOrRaise reflects the real, already-proven
//        check -- Bet/All-In are proactively disabled for a player
//        who cannot legally make either succeed.
// false (the escape hatch): canBetOrRaise is unconditionally true --
//        buttons stay enabled exactly as they did before this
//        release, falling back entirely to the existing behavior (a
//        Bet gets rejected on click per D.2's message; an All-In gets
//        accepted then silently refunded per the existing
//        announcement). No client-side change is needed to revert --
//        the client only ever reads what the server reports.
//
// TO REVERT: flip this to false and redeploy the server. Nothing else
// needs to change.
//
// WHAT "DONE" LOOKS LIKE: once Mike's test scenarios confirm nothing
// else broke, remove this flag entirely and make the gating
// unconditional -- this is temporary scaffolding for the Beta
// validation window, not a permanent setting or a second code path
// meant to be maintained indefinitely.
const GATE_BETTING_BUTTONS_WHEN_UNCALLABLE = true;

// NEW 4.2 (§3): fallback values for the top-level preset flags when a
// preset doesn't specify them (currently every Stud/Hold'em preset --
// "not yet determined" per the spec, pending real testing of those profiles).
// NEW 7.0: finalStreet added -- Stud-only, 'D' (5-Card) or 'E' (7-Card);
// defaults to 'E' (the more common real-table variant) for any Stud preset
// that omits it, though every Stud preset shipped as of 7.0 sets it explicitly.
const DEFAULT_PRESET_FLAGS = {
  reAnteable: false,
  advanceTurnRequired: true,
  burnAvailable: true,
  requiresOpeners: false,
  finalStreet: 'E',
};

class GameTable {
  constructor(code) {
    this.code = code;
    this.includeJokers = false; // still always false -- no UI to set it, unchanged from 3.3
    this.name = null; // creator-editable; falls back to `code` when unset
    this.suggestedBuyIn = null; // NEW 4.5 (§10.1) -- optional, set at creation; null if unset
    this.creatorId = null; // fixed marker of who opened the table; set on first addPlayer(), never changes
    this.players = []; // see addPlayer() for shape
    this.deck = shuffle(buildDeck(this.includeJokers));
    this.discardPile = []; // separate from the deck; folded back in on reshuffle
    this.turnOrder = []; // player ids, join order
    this.currentTurnPlayerId = null;
    this.createdAt = Date.now();

    // Betting state. Pot persists across hands -- it only clears on an
    // approved claim, never on reshuffle/deal.
    this.pot = 0;
    this.bettingOpen = false;
    this.currentBetToCall = 0;
    this.pendingClaim = null; // { proposerId, allocations: [{playerId, amount}], approverId } | null

    // NEW 4.0: Game Profiles & Game Choices.
    this.communityCards = []; // shared table cards, always face-up (§5.4)
    this.gameChoiceId = null; // selected preset id, e.g. "draw-5card"; null if none selected yet
    this.profile = null; // "draw" | "stud" | "holdem" | null, derived from gameChoiceId
    this.gameOptions = null; // resolved option values for the active hand: preset defaults + Dealer overrides

    // NEW 4.2 (§3): top-level preset flags -- fixed per preset, not
    // Dealer-editable via Options (unlike everything in gameOptions).
    // Default to the "unspecified" fallback until a Game Choice is
    // selected, matching how these features behaved pre-4.2 (always on).
    this.reAnteable = DEFAULT_PRESET_FLAGS.reAnteable;
    this.advanceTurnRequired = DEFAULT_PRESET_FLAGS.advanceTurnRequired;
    this.burnAvailable = DEFAULT_PRESET_FLAGS.burnAvailable;
    this.requiresOpeners = DEFAULT_PRESET_FLAGS.requiresOpeners; // NEW 4.5 -- distinct from reAnteable; drives Redeal Trigger A (§5.7)
    this.finalStreet = DEFAULT_PRESET_FLAGS.finalStreet; // NEW 7.0 -- Stud only (§5.10); 'D' (5-Card) or 'E' (7-Card)
    this.burnedThisHand = 0; // NEW 4.2 -- shared burn pile visual count (§5.5), resets on Deal/Reshuffle

    // NEW 4.3 (§5.6): Rabbit Hunt. Narrower window than `idle` -- only
    // true from an approved claim until the next Reshuffle/Deal, since
    // it depends on the exact leftover deck from the hand that just ended.
    this.rabbitHuntAvailable = false;
    this.rabbitHuntCards = []; // revealed this window, face-up to everyone

    // NEW 4.1: hand-lifecycle bookkeeping.
    this.idle = true; // true = no hand in progress right now (§4.1). For Draw, this is now a DERIVED reflection
    // of handPhase (kept in sync by _setHandPhase, below); for every other profile it's still the old,
    // independently-triggered flag, exactly as it worked through 4.5.
    this.bettingRoundsThisHand = 0; // still exists, still incremented -- RETIRED as a gating mechanism for
    // Draw as of 5.0 (handPhase replaces that role); harmless inert bookkeeping for other profiles.
    this.discardWindowOpen = true; // same story as bettingRoundsThisHand -- retired as a Draw gate, still
    // exists/updates, still meaningful for other profiles.

    // NEW 5.0, extended 6.0/7.0 (§3/§5.8/§5.9/§5.10): the phase-gated
    // hand-flow state machine, now covering all three primary profiles
    // (Draw, Hold'em, Stud). Stays at 'PreGame' forever for any gameTable with
    // no profile selected, or a profile that never adopted the pattern --
    // nothing reads it in that case.
    this.handPhase = 'PreGame';

    // NEW 7.0 (§3/§5.10/§6.8): Stud only -- the Dealer's manual selection
    // of who opens the CURRENT betting round. Reset to null at the start
    // of every Stud betting round (re-selected every street); `openBetting`
    // is rejected for a Stud gameTable until this is set. null/inert for every
    // other profile.
    this.openingBettorId = null;

    // Internal-only, NEW 7.0 (§6.8): tracks which player (if any) is
    // currently under Stud's Bring-In forced-first-action restriction --
    // set to the opening bettor's id the moment StreetABetting opens (if a
    // bringIn amount applies), cleared the instant that specific player
    // takes their first action (call or raise). While set, Fold is
    // unavailable to that one player for that one action only -- the first
    // case in the app where a specific seat loses access to Fold for a
    // specific forced action. Never exposed via toRedactedState directly;
    // surfaced to clients as the redacted `bringInObligationId` field below.
    this._bringInObligationId = null;

    // NEW 8.1 (§3/§5.10 extension), dealIsInterruptable presets only:
    // set the instant a face-up 3 or 4 lands with a non-Free price,
    // cleared the instant that player's Pay/Fold or Buy/Decline decision
    // resolves. While set, the per-player deal loop (see deal()/
    // _continueDeal()) does not advance to the next recipient. null
    // whenever dealing isn't currently paused -- the overwhelming
    // majority of the time, including for every non-Baseball preset.
    this._pendingDealInterrupt = null;

    // Internal-only, NEW 8.1: the remaining flat queue of recipient
    // player ids (one entry per card still owed) for an in-progress,
    // possibly-paused deal() call -- see _continueDeal(). null whenever
    // no deal is currently paused. Never exposed via toRedactedState;
    // `_pendingDealInterrupt` alone is what the client needs to render
    // the pause.
    this._dealQueue = null;

    // Internal-only, NEW 8.1: the handPhase-transition context a paused
    // deal() needs to remember in order to finish correctly once
    // resumed (which profile, which street, whether a faceUp override
    // was requested) -- captured once at the start of deal(), consulted
    // only by _finishDeal() once the queue fully drains. null whenever
    // no deal is currently in progress/paused.
    this._dealResumeContext = null;

    // Internal-only, NEW 8.1: plain-text announcements queued by
    // auto-resolved (Free-price) deal interrupts, drained and broadcast
    // by server.js once per action -- see _queueAnnouncement/
    // drainAnnouncements. Never exposed via toRedactedState.
    this._pendingAnnouncements = [];

    // NEW 8.1 (§3, §6.9), hasKillCard presets only (currently Black
    // Mariah): preset-level flags resolved by setGameChoice(), same
    // level as reAnteable/advanceTurnRequired/etc. `killCard` (e.g.
    // "Qs") is display-only -- the server does no card-identity
    // matching against it; only the Dealer's own eyes and judgment
    // trigger Kill Hand (§12's card-identity-gating exception).
    this.hasKillCard = false;
    this.killCard = null;

    // NEW 8.2 (§6.9), hasKillCard presets only: true from the instant
    // the Dealer opens the Kill Hand confirmation dialog until they
    // either confirm (newHand fires normally, clearing this as a side
    // effect) or cancel (killHandCancelConfirm clears it directly). Not
    // durable hand state -- purely a transient UI-coordination flag so
    // every OTHER player can see the table-wide "Dealer is about to
    // kill this hand" notice while it's happening (spec §5.10
    // extension/§6.9's new table-wide-notice requirement). Exposed via
    // toRedactedState; resets to false on every fresh RequestAntes entry
    // as a safety net, though the confirm/cancel pair should always
    // clear it directly first.
    this.killHandConfirmPending = false;

    // Internal-only: tracks who has acted since the last bet/raise (or
    // since the round opened, if nobody's bet yet), to detect automatic
    // round closure. Never exposed via toRedactedState.
    this._actedSinceRaise = new Set();

    // NEW 9.0 (§6.10, §6.11), Hold'em only: side pots -- null for every
    // hand that never has an uneven all-in (the overwhelming majority),
    // populated once a genuine side-pot tier exists. See _recomputePots().
    this.pots = null;

    // NEW 9.6 (§6.10): the set of player IDs who've already been PROVEN
    // to lose the hand -- specifically, anyone who was eligible for an
    // already-claimed, higher-id pot but received exactly $0 from it.
    // Once a player is in this set, they're excluded from every
    // REMAINING (lower-id, not-yet-claimed) pot's eligibility too, on
    // top of whatever _recomputePots() itself already computed from
    // contribution/fold status -- a genuinely separate, claims-workflow
    // layer, deliberately NOT baked into _recomputePots() itself (which
    // stays pure contribution-based money math, unaffected by claim
    // history). Reset empty at every RequestAntes entry.
    this.provenLosers = new Set();

    // NEW 9.0 (§6.10): per-round raise-count, for Fixed-Limit's "bet plus
    // three raises" cap. Resets to 0 at the start of every betting round
    // (openBetting), increments by 1 on each Raise (not the opening Bet).
    this.raiseCountThisRound = 0;

    // NEW 9.0 (§6.10): the minimum legal RAISE INCREMENT right now --
    // Minimum Raise = max(opening bet of the round, size of the most
    // recent raise), tracked incrementally rather than recomputed from
    // history each time. Seeded at round-open (Big Blind for
    // PreFlopBetting, 0 until the first Bet lands for every other
    // street), then set to each raise's own increment as it happens --
    // safe because a legal raise increment is always >= the previous
    // minimum, so simply overwriting is equivalent to taking the max.
    this._minRaiseIncrement = 0;

    // NEW 10.3 (the-cut-spec_v10-3.md Part A §2): the most recent
    // pre-current-hand bank snapshot (chips/totalBuyIn per player id),
    // for Function 2 (Restore Player Stacks). Re-taken fresh every time
    // a genuinely new hand begins (_enterRequestAntes()) so "pre-current-
    // game" always means the most recently started hand, never a stale
    // one. null until the first hand of the session ever starts.
    this._preGameSnapshot = null;

    // NEW 10.3 (Part A §3): the staged batch of pending pot-distribution
    // allocations for Function 3 -- an array of
    // { id, playerId, direction: 'take' | 'give', amount } while the
    // Table Owner is actively building one, null otherwise. Nothing in
    // `chips`/`this.pot` is touched while staging; only commitPotDistribution()
    // actually moves money. Gated to idle-only for BOTH staging and
    // commit, per Mike's own direct confirmation: these are emergency
    // unlock functions, reserved for the Table Owner, always invoked at
    // an already (fatally) idle table -- there is no real scenario where
    // staging needs to start mid-hand.
    this._pendingAllocationBatch = null;
    this._nextAllocationId = 1;

    // NEW 11.0 (the-cut-spec_v11-0.md Parts B/D): table-level reconnect
    // grace-period length, in seconds. Room-level state, same category as
    // `pot`/`dealerId` -- never reset on Select, table-owner-configurable
    // via setReconnectTimeout(), surfaced through the Table Owner Settings
    // dialog (client-side), not a Dealer Option. Default matches the
    // spec's own starting point; not locked in.
    this.reconnectGraceSeconds = 30;

    // NEW 11.0 (Part E): when a mid-hand emergency Dealer handoff occurs
    // (the ORIGINAL Dealer disconnects past their grace period while a
    // hand/cycle is in progress), this holds the ORIGINAL Dealer's id --
    // the positional anchor (blinds, first-to-act) stays theirs for the
    // rest of the current cycle even though `isDealer` has already moved
    // to the interim Dealer. null whenever no split is in effect (the
    // overwhelmingly common case -- Dealer role and positional anchor are
    // the same seat). Cleared the moment the cycle actually closes -- see
    // _setHandPhase().
    this.dealerPositionAnchorId = null;

    // NEW 11.0 (Part H.2): inactivity/idle-but-connected table lifecycle.
    // Server-level constant, not Table-Owner-configurable (unlike the
    // reconnect grace period) -- chosen partly for hosting-cost reasons
    // (idle server time), same "we won't know until we experience it"
    // posture as every other timer in this spec, but not a matter of
    // per-table taste the way the reconnect grace period is.
    this.lastActivityAt = Date.now();
    // FIXED 11.5 (Part D): genuine, permanent test-mode override -- see
    // server.js's own LIFECYCLE_SWEEP_INTERVAL_MS comment for why this
    // is wired in for real this time rather than another temporary
    // edit-and-revert. Harmless in production; the env var is never set
    // there.
    this.inactivityTimeoutSeconds = Number(process.env.TEST_INACTIVITY_SECONDS) || 30 * 60;
  }

  /**
   * NEW 11.0 (Part H.2): called on any real game activity (a new hand/
   * cycle started, an action taken, a join, a reconnect) -- resets the
   * inactivity clock to zero. The client derives its own T-5/T-1 banner
   * and popup windows purely from the `tableCloseAt` timestamp this
   * produces (see toRedactedState) rather than the server pushing
   * separate one-off "warning" messages -- the Standing Convention
   * applies here too: one server-computed fact, read directly.
   */
  touchActivity() {
    this.lastActivityAt = Date.now();
  }

  getDealer() {
    return this.players.find((p) => p.isDealer) || null;
  }

  getPlayer(id) {
    return this.players.find((p) => p.id === id) || null;
  }

  isFull() {
    return this.players.length >= MAX_PLAYERS;
  }

  /**
   * Add a new player. The very first player to join a gameTable is
   * automatically the Dealer and the gameTable's creator. Turn order follows
   * join order. No automatic buy-in -- players start at $0.
   */
  addPlayer(id, name) {
    const isFirst = this.players.length === 0;
    const player = createPlayer(id, name, isFirst); // NEW 8.0 (§4) -- delegates to the Player/Bank module
    // NEW 11.0 (Part D): every seated Player gets a reconnect code the
    // moment they join, not only once they first disconnect -- generated
    // per player per session, exactly as the spec describes it. Also NEW
    // 11.0: `connected`/`disconnectedAt`, tracked here (not in
    // src/player.js's bank/identity module) since these are connection-
    // lifecycle fields, not bank fields.
    player.connected = true;
    player.disconnectedAt = null;
    player.reconnectCode = this._generateReconnectCode();
    // NEW 11.0 (Part F): true once a deferred (mid-cycle) Leave Table/
    // Remove Player is pending -- consulted in exactly one place, the
    // cycle-close hook in _setHandPhase(), which performs the actual
    // removal. Deliberately not a new concept anywhere else: a
    // pendingDeparture Player is ALSO sittingOut, so every existing
    // eligibility consumer (dealing, turn order, claims) already treats
    // them correctly without needing to learn a new status.
    player.pendingDeparture = false;
    this.players.push(player);
    this.turnOrder.push(id);
    if (isFirst) {
      this.currentTurnPlayerId = id;
      this.creatorId = id; // fixed for the gameTable's lifetime -- distinct from Dealer, which can transfer
    }
    // NEW 11.0 (Part G): "a brand-new player joins the table (including
    // session start)" -- table-wide, immediate, per the notification
    // table. Harmless when this is the very first player (nobody else is
    // there to see it yet).
    this._queueAnnouncement(`${player.name} has joined the table.`, 'join');
    this.touchActivity(); // NEW 11.0 (Part H.2) -- a join is real activity
    return player;
  }

  /**
   * NEW 11.0 (Part D): a 6-character alphanumeric code, drawn from the
   * larger 36-character keyspace (letters + numbers) the spec calls for --
   * not a numeric-only PIN -- specifically to make guessing impractical.
   * Retries on the astronomically unlikely case of a collision with a
   * code already active at this table (codes are only unique per-table,
   * not globally, which is all §5 of the reconnect design actually needs).
   */
  _generateReconnectCode() {
    // FIXED 11.3 (Part C): both `0` (zero) and `O` (letter O) removed --
    // confirmed as a real, recurring problem during testing, not
    // hypothetical. Removing only one side would still leave a future
    // player with no way to know which one was kept, so both go
    // together. `1`/`I` deliberately kept, per Mike's own judgment that
    // those two remain visually distinguishable enough in practice.
    // 34 characters now, down from 36 -- 34^6 (~1.54 billion) vs. 36^6
    // (~2.18 billion) is a negligible reduction against the real threat
    // model (a rate-limited human guesser).
    const ALPHABET = 'ABCDEFGHIJKLMNPQRSTUVWXYZ123456789';
    let code;
    do {
      code = '';
      for (let i = 0; i < 6; i++) code += ALPHABET[Math.floor(Math.random() * ALPHABET.length)];
    } while (this.players.some((p) => p.reconnectCode === code));
    return code;
  }

  /**
   * NEW 9.2 (§4, §10.1): case-insensitive collision check against every
   * name already seated -- "Chris" collides with "chris"/"CHRIS". Join
   * Room only; Create Room always starts a brand-new, empty room, so
   * there's never an existing name to collide with.
   */
  hasPlayerNamed(name) {
    const normalized = (name || '').trim().toLowerCase();
    return this.players.some((p) => p.name.trim().toLowerCase() === normalized);
  }

  /**
   * CHANGED 11.0 (Part F.5): reconciled, not retired -- the groundwork
   * finding in the spec flagged this function as blunt (naive
   * turn-order-first Dealer promotion, silent claim voiding) and left
   * open whether it becomes the real mechanism Leave Table/Remove
   * Player call. It does, with both defects fixed here. No longer
   * called on disconnect at all (see markDisconnected()'s own section
   * above) -- this is now exclusively the actual, permanent "delete this
   * seat and compact positions" primitive, invoked only at the moment a
   * departure actually takes effect (see _initiateDeparture()).
   */
  removePlayer(id) {
    const player = this.getPlayer(id);
    if (!player) return;

    // FIXED 11.0 (Part F.5 groundwork): proper eligibility-aware
    // reassignment, not "whoever's first in turnOrder" -- the exact
    // defect the spec's own groundwork flagged in the pre-11.0 version.
    if (player.isDealer) {
      this._reassignDealerToNextEligible(player);
    }

    this.players = this.players.filter((p) => p.id !== id);
    this.turnOrder = this.turnOrder.filter((pid) => pid !== id);

    if (this.currentTurnPlayerId === id) {
      this.currentTurnPlayerId = this.turnOrder[0] || null;
    }

    // FIXED 11.0 (Part F.5 groundwork): a departing Player who held ONLY
    // the approver role -- not the proposer, not an allocation recipient,
    // i.e. no actual money stake in this claim -- no longer costs every
    // OTHER player the whole claim. Reassign approval instead, the same
    // "don't punish everyone else for one person leaving" principle
    // already used for the Dealer handoff. A departing Player who WAS a
    // real stakeholder (proposer or allocation recipient) still voids
    // the claim outright -- the safe fallback, and, per Mike's own
    // explicit call, not something this needs to get perfectly right in
    // every combination: Table Owner Functions 1-3 exist as the backstop
    // for exactly this kind of edge case.
    if (this.pendingClaim) {
      const isProposer = this.pendingClaim.proposerId === id;
      const hasAllocation = this.pendingClaim.allocations.some((a) => a.playerId === id);
      const isApprover = this.pendingClaim.approverId === id;
      if (isProposer || hasAllocation) {
        this.pendingClaim = null;
      } else if (isApprover) {
        const nextApprover = this._nextEligibleApprover(this.pendingClaim.proposerId);
        if (nextApprover) {
          this.pendingClaim.approverId = nextApprover;
        } else {
          this.pendingClaim = null;
        }
      }
    }
  }

  /**
   * NEW 11.0 (Part F.5): the same "who approves a claim" selection
   * claimPot() itself already uses (dealer, unless the Dealer is the
   * proposer, in which case the next hand-participant seat to their
   * left, falling back to the next folded seat) -- factored out so
   * removePlayer()'s reassignment can reuse it verbatim rather than
   * re-implementing the same rule a second time.
   */
  _nextEligibleApprover(proposerId) {
    const dealer = this.getDealer();
    if (!dealer) return null;
    if (dealer.id !== proposerId) return dealer.id;
    const dealerIdx = this.turnOrder.indexOf(dealer.id);
    for (let step = 1; step <= this.turnOrder.length; step++) {
      const candidate = this.getPlayer(this.turnOrder[(dealerIdx + step) % this.turnOrder.length]);
      if (candidate && this._isHandParticipant(candidate) && candidate.id !== dealer.id) return candidate.id;
    }
    for (let step = 1; step <= this.turnOrder.length; step++) {
      const candidate = this.getPlayer(this.turnOrder[(dealerIdx + step) % this.turnOrder.length]);
      if (candidate && !candidate.sittingOut && candidate.folded && candidate.id !== dealer.id) return candidate.id;
    }
    return null;
  }

  // ------------------------------------------------------------------
  // NEW 11.0 (the-cut-spec_v11-0.md Parts A-E): Disconnection &
  // Reconnection. Deliberately separate from removePlayer() above --
  // that function permanently deletes a seat and compacts positions,
  // which is exactly wrong for a connection blip. A disconnect converges
  // into the existing Sitting Out mechanic instead (Part C): the seat
  // stays exactly where it is, nothing about the roster changes, and the
  // Player returns to normal play the same way any other AFK Player does.
  // ------------------------------------------------------------------

  /**
   * Marks a Player as disconnected (heartbeat failure or a clean socket
   * close -- server.js decides which and calls this either way, per Part
   * A). Does NOT sit them out, fold them, or touch the Dealer role by
   * itself -- this only starts the clock. server.js is responsible for
   * timing the grace period (Part B's configurable `reconnectGraceSeconds`)
   * and calling expireDisconnectGrace() if it elapses with no reconnect.
   */
  markDisconnected(playerId) {
    const player = this.getPlayer(playerId);
    if (!player) return { ok: false, error: 'Player not found.' };
    if (!player.connected) return { ok: false, error: 'Already disconnected.' };
    player.connected = false;
    player.disconnectedAt = Date.now();
    const wasDealer = player.isDealer === true;
    // NEW 11.0 (Part E): immediate table-wide notice the moment a
    // Dealer's disconnect is DETECTED, not deferred to grace expiry --
    // their absence can block the whole table's ability to proceed, so
    // everyone needs to know right away.
    if (wasDealer) {
      this._queueAnnouncement(`${player.name} (the Dealer) has disconnected. The table will wait ${this.reconnectGraceSeconds}s for them to reconnect.`, 'disconnect');
    } else {
      // Part G: "notify on every ordinary disconnect" -- carried forward
      // from the spec as an explicit starting assumption to revisit
      // after beta if it proves too noisy, not a settled decision.
      this._queueAnnouncement(`${player.name} has disconnected.`, 'disconnect');
    }
    return { ok: true, player, wasDealer };
  }

  /**
   * Verifies a reconnect code and, if valid, silently resumes the Player
   * (Part D/§4 of the original reference: no "welcome back" moment, no
   * catch-up logic -- a fresh toRedactedState on the new socket already
   * shows everything correctly). Deliberately requires the Player to
   * currently be in a disconnect state (`connected === false`) -- per
   * Part D, a currently-connected Player's code cannot be used to hijack
   * their seat from a second device; that attempt is simply rejected here,
   * with no distinction in the error message that would let a guesser
   * learn whether the code was merely wrong vs. correct-but-blocked.
   */
  reconnectPlayer(code) {
    // FIXED 11.3 (Part A.8): the rate-limiter correction needs to
    // distinguish "this code matches nobody at all" (genuine guessing --
    // should count against the per-IP limiter) from "this code is
    // genuinely correct, but rejected only for timing reasons" (already
    // reconnected, or blocked by the multi-device rule -- must NOT
    // count). `codeMatchedNoPlayer` on the result is exactly that
    // distinction; server.js's rate limiter reads it directly rather
    // than re-deriving it from the error message text.
    const matchedPlayer = this.players.find((p) => p.reconnectCode === code);
    if (!matchedPlayer) return { ok: false, error: 'Invalid reconnect code.', codeMatchedNoPlayer: true };
    if (matchedPlayer.connected) {
      // Deliberately the SAME error text as "no such code" -- see this
      // method's own pre-11.3 comment about not letting a guesser learn
      // anything from which case they hit. Only the internal
      // codeMatchedNoPlayer flag (never sent to the client) tells them apart.
      return { ok: false, error: 'Invalid reconnect code.', codeMatchedNoPlayer: false };
    }
    const player = matchedPlayer;
    player.connected = true;
    player.disconnectedAt = null;
    // Deliberately NOT clearing sittingOut here -- see expireDisconnectGrace()'s
    // own comment. A Player who reconnects within their grace period never
    // had sittingOut set in the first place (silent resume); a Player who
    // reconnects AFTER the grace period expired is, from this point on,
    // functionally identical to any other voluntary AFK Player and returns
    // the same way -- by clicking Sit In.
    this._queueAnnouncement(`${player.name} has reconnected.`, 'reconnect');
    this.touchActivity(); // NEW 11.0 (Part H.2) -- a reconnect is real activity
    return { ok: true, playerId: player.id };
  }

  /**
   * Called by server.js's grace-period timer when it elapses. A no-op if
   * the Player already reconnected in the meantime (the timer isn't
   * cancelled from inside GameTable -- server.js owns that -- but this
   * check makes the method safe to call unconditionally regardless).
   *
   * Two things happen, matching Part C/E exactly:
   *  1. Check if free, fold if facing a bet -- see _resolveAbsentPlayerTurn()'s
   *     own comment for why this is deliberately NOT the same rule
   *     sitOut()'s own explicit "Fold and Sit Out" uses.
   *  2. If they were the Dealer, the role transfers via a DIRECT call to
   *     _reassignDealerToNextEligible() -- never passTheBuck(), which
   *     cannot serve this purpose (requires the Dealer themselves as
   *     requester; gated to between-hands only). If this happens mid-hand
   *     (not idle), the positional anchor splits off to preserve the
   *     original Dealer's seat for blinds/first-to-act, per Part E.
   */
  expireDisconnectGrace(playerId) {
    const player = this.getPlayer(playerId);
    if (!player || player.connected) return { ok: false, noop: true };

    let newDealerId = null;
    const wasDealer = player.isDealer === true;
    if (wasDealer) {
      // NEW 11.0: mid-cycle only -- if the table is already idle
      // (between hands/cycles), there's no "position to preserve"; the
      // handoff behaves exactly like an ordinary Pass the Buck and the
      // next hand simply starts from the new Dealer's seat.
      if (!this.idle && isPhaseGated(this.profile) && this.dealerPositionAnchorId === null) {
        this.dealerPositionAnchorId = player.id;
      }
      const nextDealer = this._reassignDealerToNextEligible(player);
      if (nextDealer) {
        newDealerId = nextDealer.id;
        this._queueAnnouncement(`${player.name} did not reconnect in time \u2014 the Dealer role has passed to ${nextDealer.name}.`, 'disconnect');
      } else {
        // No eligible replacement exists (e.g. everyone else is also
        // disconnected/sitting out) -- the disconnected Player simply
        // stays Dealer on paper; nobody to hand it to. Mirrors
        // passTheBuck()'s own "no eligible player" rejection rather than
        // inventing new behavior for a degenerate case.
        this._queueAnnouncement(`${player.name} did not reconnect in time, but no other player is available to take over as Dealer.`, 'disconnect');
      }
    } else {
      this._queueAnnouncement(`${player.name} did not reconnect in time and has been moved to Sitting Out.`, 'disconnect');
    }

    this._resolveAbsentPlayerTurn(player);
    player.sittingOut = true;
    player.sitOutPending = false;

    return { ok: true, wasDealer, newDealerId };
  }

  /**
   * The actual fold bookkeeping, shared by every path that forces a fold
   * on a Player's behalf -- extracted so there's exactly one
   * implementation, not several that could quietly drift out of sync
   * the way B.2 did.
   */
  _applyFoldBookkeeping(player) {
    player.folded = true;
    this._actedSinceRaise.add(player.id);
    if (this.bettingOpen) {
      if (this.currentTurnPlayerId === player.id) {
        this.currentTurnPlayerId = this._nextTurnPlayerId();
      }
      this._maybeCloseBettingRound();
    } else {
      this._maybeAdvanceFromDiscardPhase();
      this._maybeAdvanceFromDeclare();
    }
  }

  /**
   * sitOut()'s own "Fold and Sit Out" mode: the Player explicitly chose
   * this, so an unconditional fold (whenever they hold a live decision at
   * all) is the correct, fair behavior -- they're the one giving up their
   * stake, not the app doing it to them.
   */
  _foldForSitOut(player) {
    if (!this._canAct(player)) return;
    this._applyFoldBookkeeping(player);
  }

  /**
   * NEW 11.0 (Part C): "does this Player currently owe anything to stay
   * in the hand" -- the exact same figure the client's own "$YY to You"
   * UI is built from (currentBetToCall - player.currentBet), so a
   * disconnected Player is never folded out of a hand they'd have seen,
   * a moment before losing connection, as free to just check.
   */
  _isFacingABet(player) {
    return this.bettingOpen && this.currentBetToCall - player.currentBet > 0;
  }

  /**
   * NEW 11.0 (Part C): the involuntary-timeout rule -- "check if free,
   * fold if facing a bet" -- confirmed against industry practice
   * (Ignition/Bovada, GGPoker, BetOnline all converge on this). This is
   * deliberately NOT the same as _foldForSitOut() above: that's a
   * Player's own explicit choice to fold and leave; this is something
   * happening TO an absent Player, and folding someone who had nothing
   * to lose by checking would be needlessly unfair to them. If they're
   * free to check, this checks on their behalf (advancing the turn so
   * the table isn't stuck waiting on someone who can no longer respond)
   * without touching `folded` at all -- their hand stays completely live.
   */
  _resolveAbsentPlayerTurn(player) {
    if (!this._canAct(player)) return; // no live decision to resolve at all
    if (this._isFacingABet(player)) {
      this._applyFoldBookkeeping(player);
      return;
    }
    if (this.bettingOpen && this.currentTurnPlayerId === player.id) {
      this._actedSinceRaise.add(player.id);
      this.currentTurnPlayerId = this._nextTurnPlayerId();
      this._maybeCloseBettingRound();
    }
    // Not currently their turn, or no betting round open at all: there is
    // genuinely nothing to resolve right now -- they aren't holding
    // anything up, so nothing happens (they simply stay dealt in,
    // pending, until it's their turn or the hand moves on).
  }

  /**

   * NEW 11.0 (Part B): Table-Owner-only, lives in the new Settings
   * dialog. Table-level state (like `pot`/`dealerId`), never reset on
   * Select. No hard bounds enforced here beyond sanity (positive number)
   * -- the exact useful range is exactly the kind of thing the spec says
   * "we won't know until we experience it" about.
   */
  setReconnectTimeout(requesterId, seconds) {
    if (requesterId !== this.creatorId) {
      return { ok: false, error: 'Only the Host can change the reconnect timeout.' };
    }
    if (typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds <= 0) {
      return { ok: false, error: 'Reconnect timeout must be a positive number of seconds.' };
    }
    this.reconnectGraceSeconds = seconds;
    return { ok: true };
  }

  /**
   * NEW 11.0: the answer to "whose seat is the positional anchor right
   * now" -- the original Dealer's, if a mid-cycle emergency handoff split
   * is currently in effect (Part E), otherwise the current Dealer's own
   * seat, exactly as it's always worked. Every call site that used to
   * read `dealer.id` purely for POSITION (blinds, first-to-act) reads
   * this instead; call sites that need the actual current Dealer (for
   * Dealer-only actions/authorization) keep using getDealer().id directly
   * -- those are deliberately unaffected by this split.
   */
  _positionAnchorId() {
    return this.dealerPositionAnchorId || this.getDealer()?.id || null;
  }

  /**
   * NEW 11.0 (Part I audit finding): a mid-grace-period Player
   * (`connected: false`, not yet `sittingOut`) is still a full, live
   * participant in whatever hand is ALREADY in progress -- Part B's own
   * "the table freezes" principle, and every existing eligibility
   * consumer (_isHandParticipant, _canAct, _isPending, turn order,
   * claims) already handles that correctly without any change, since
   * none of them ever checked `connected` in the first place.
   *
   * What the spec text doesn't explicitly cover is a DIFFERENT moment:
   * starting a BRAND NEW hand while someone is disconnected but hasn't
   * timed out yet. Dealing them into a fresh hand (and assigning them an
   * ante they have no way to post) would be strictly worse than simply
   * waiting a little longer -- so startGame()/newHand() both block on
   * this rather than proceeding. Deliberately scoped to ONLY those two
   * fresh-hand entry points, not a blanket `connected` check added to
   * _dealableActivePlayers()/_computeBlindSeats()/_autoApplyAnte(): an
   * earlier draft of this fix tried exactly that and it would have
   * broken _computeBlindSeats()'s other caller (openBetting()'s
   * PreFlopBetting recomputation, which must reproduce the SAME blind
   * assignment already used to seed real posted money at RequestAntes,
   * even if that Player's connection status changes in between) --
   * exactly the kind of cross-consumer regression this audit exists to
   * catch, not sampled and missed the way the project's own core lesson
   * warns against.
   */
  _anyoneDisconnected() {
    return this.players.some((p) => !p.connected);
  }

  // ------------------------------------------------------------------
  // NEW 11.0 (the-cut-spec_v11-0.md Part F): Voluntary and Forced
  // Departure (Leave Table / Remove Player). Surfaced during 11.0's own
  // review, not part of the original 10.0-era disconnect design --
  // there was previously no way for a Player to permanently leave and
  // free their position, distinct from simply disconnecting.
  // ------------------------------------------------------------------

  /**
   * NEW 11.0 (Part F.1). `mode` only matters when the Player actually
   * holds a pending stake right now (_isPending() -- the exact same gate
   * Buy Chips already uses, per seat-player-dealer-spec.md §2's
   * governing principle: no unresolved stake, leave immediately;
   * otherwise, fold-and-leave-now or wait-until-cycle-close, the exact
   * same choice Sit Out already offers).
   */
  leaveTable(requesterId, mode) {
    const player = this.getPlayer(requesterId);
    if (!player) return { ok: false, error: 'Player not found.' };
    const result = this._initiateDeparture(player, mode);
    if (result.ok) {
      // Part G: "a player leaves the table -- Immediate (or at cycle
      // close, if departure is deferred per F.1/F.4)."
      this._queueAnnouncement(
        result.immediate ? `${player.name} has left the table.` : `${player.name} will leave the table once the current cycle closes.`,
        'departure'
      );
    }
    return result;
  }

  /**
   * NEW 11.0 (Part F.2). Table-Owner-only. "Force the same outcome as if
   * the player had clicked Leave Table themselves" -- same rules, same
   * shared implementation as leaveTable() above, just a different
   * (Table Owner) requester and an explicit target. Closes a real gap:
   * a Player who disconnects and never returns previously had no path
   * to ever being cleared from the table.
   */
  removePlayerFromTable(requesterId, targetPlayerId, mode) {
    if (requesterId !== this.creatorId) {
      return { ok: false, error: 'Only the Host can remove a player.' };
    }
    const player = this.getPlayer(targetPlayerId);
    if (!player) return { ok: false, error: 'Player not found.' };
    const result = this._initiateDeparture(player, mode);
    if (result.ok) {
      this._queueAnnouncement(
        result.immediate
          ? `${player.name} has been removed from the table by the Table Owner.`
          : `${player.name} will be removed from the table by the Table Owner once the current cycle closes.`,
        'departure'
      );
    }
    return result;
  }

  /**
   * Shared by F.1/F.2 -- see each method's own comment. `mode` is only
   * consulted when a pending stake exists; ignored entirely otherwise
   * (the overwhelmingly common case).
   */
  _initiateDeparture(player, mode) {
    if (this._isPending(player)) {
      if (mode !== 'foldAndLeave' && mode !== 'leaveAtCycleClose') {
        return { ok: false, error: 'A pending stake requires choosing to fold and leave now, or leave once the current cycle closes.' };
      }
      if (mode === 'leaveAtCycleClose') {
        this._deferDeparture(player);
        return { ok: true, immediate: false };
      }
      // foldAndLeave: an explicit, deliberate forfeiture -- the same
      // unconditional fold Sit Out's own "Fold and Sit Out" uses
      // (_foldForSitOut), NOT the lenient "check if free" rule reserved
      // for an INVOLUNTARY disconnect timeout (_resolveAbsentPlayerTurn).
      // This is the Player's (or the Table Owner acting on their behalf,
      // for F.2) own explicit choice to give up the stake.
      this._foldForSitOut(player);
    }

    // NEW 11.0 (Part F.4): compaction only ever happens at a cycle
    // boundary, never mid-cycle -- even when the departure itself was
    // triggered mid-cycle. `this.idle` IS "we're already at a cycle
    // boundary right now," so an immediate removal here never violates
    // that rule. The legacy no-Game-Choice "flexible toolbox" mode has
    // no cycle concept at all to defer to in the first place (see
    // _setHandPhase()'s own scoping) -- departure there is always
    // immediate, regardless of `idle`.
    if (this.idle || !isPhaseGated(this.profile)) {
      this.removePlayer(player.id);
      return { ok: true, immediate: true };
    }
    this._deferDeparture(player);
    return { ok: true, immediate: false };
  }

  /**
   * NEW 11.0 (Part F.4): marks a Player for removal at the next cycle
   * close, without touching the seat list yet. Deliberately reuses the
   * fully-audited Sitting Out machinery (dealing exclusion, turn order,
   * claim eligibility) instead of teaching a new status to every
   * consumer of Player eligibility -- `pendingDeparture` itself is
   * consulted in exactly one other place, the cycle-close hook in
   * _setHandPhase().
   */
  _deferDeparture(player) {
    player.sittingOut = true;
    player.sitOutPending = false;
    player.pendingDeparture = true;
    if (player.isDealer) {
      // Same mid-cycle positional-anchor split Part E uses for a
      // disconnected Dealer -- the departing Player's seat is still
      // structurally present until the cycle closes, so it remains the
      // blinds/first-to-act anchor until then. Both the anchor and the
      // seat itself clear together the moment the cycle actually does
      // (_setHandPhase()).
      if (isPhaseGated(this.profile) && this.dealerPositionAnchorId === null) {
        this.dealerPositionAnchorId = player.id;
      }
      this._reassignDealerToNextEligible(player);
    }
  }

  /**
   * NEW 11.0 (Part F.6): Table-Owner-only, ends the entire table/
   * session -- distinct from Function 1 (Terminate Cleanly), which only
   * ends the current HAND and leaves the table itself intact. The
   * actual "disconnect every socket and delete the table" mechanics are
   * server.js's job (this class has no notion of sockets); this method
   * is only the authorization/policy gate.
   */
  endGame(requesterId) {
    if (requesterId !== this.creatorId) {
      return { ok: false, error: 'Only the Host can end the game.' };
    }
    return { ok: true };
  }

  /**
   * NEW 11.0 (Part H.2): the Table Owner's T-1-minute popup action --
   * "offering to restart the 30-minute clock." Just touchActivity()
   * under a permission check; kept as its own method (rather than having
   * the client call some generic activity-ping message) so the
   * authorization lives in exactly one place, consistent with every
   * other Table-Owner-only function.
   */
  restartActivityClock(requesterId) {
    if (requesterId !== this.creatorId) {
      return { ok: false, error: 'Only the Host can restart the inactivity clock.' };
    }
    this.touchActivity();
    return { ok: true };
  }

  // ------------------------------------------------------------------
  // NEW 11.1 (the-cut-spec_v11-1.md): Table Owner Testing Tools. A
  // debug/QA entry point that triggers the exact same production code
  // paths a real event would, on demand -- not a parallel simulated
  // system. Both capabilities are pure authorization/state-computation
  // gates; the actual socket termination for Capability 1 is server.js's
  // job (this class has no notion of sockets).
  // ------------------------------------------------------------------

  /**
   * Capability 1 (Force Disconnect): authorization + target-validity
   * check only -- the actual `targetSocket.terminate()` call lives in
   * server.js, which then routes through the exact same
   * handleConnectionLost() a genuine heartbeat failure or clean close
   * already uses (terminate() fires that socket's own 'close' event
   * naturally; nothing here duplicates that logic). Kept as its own
   * method so the authorization lives in exactly one place, consistent
   * with every other Table-Owner-only function, and so it's testable
   * without a real WebSocket.
   */
  canForceDisconnect(requesterId, targetPlayerId) {
    if (requesterId !== this.creatorId) {
      return { ok: false, error: 'Only the Host can force a disconnect.' };
    }
    const target = this.getPlayer(targetPlayerId);
    if (!target) return { ok: false, error: 'Player not found.' };
    if (!target.connected) return { ok: false, error: 'That player is not currently connected.' };
    return { ok: true };
  }

  /**
   * Capability 2 (Force Timeout to T-5): jumps the REAL inactivity
   * clock straight to the T-5 mark by backdating `lastActivityAt` --
   * not a separate simulated banner state. This is the exact same
   * `tableCloseAt` every other consumer (the client's own banner/popup,
   * the server's lifecycle sweep) already reads, so everything from
   * this point on behaves exactly as production: real activity still
   * resets it, the sweep still enforces the real T-0 close.
   */
  forceInactivityWarning(requesterId) {
    if (requesterId !== this.creatorId) {
      return { ok: false, error: 'Only the Host can do this.' };
    }
    const FIVE_MINUTES_MS = 5 * 60 * 1000;
    this.lastActivityAt = Date.now() + FIVE_MINUTES_MS - this.inactivityTimeoutSeconds * 1000;
    return { ok: true };
  }

  /**
   * NEW 5.0 (§5.8): "all active players" throughout the phase machine
   * means not folded, not sitting out -- the same definition already
   * used everywhere else in the app (heads-up detection, claim
   * eligibility, the DiscardPhase/Declare completion checks).
   * BUG FIX 9.7: 9.6's fix here (adding a `chips > 0` exclusion) was a
   * real regression -- this is a SHARED function, and most of its
   * callers were never meant to exclude an all-in player (chips === 0
   * is a completely normal, expected state for anyone who's gone
   * all-in mid-hand -- it doesn't mean they've stopped being part of
   * the hand). Confirmed broken: the sole-all-in-player-everyone-folds
   * early-claim case (the count this helper fed came out 0, not 1,
   * incorrectly rejecting an automatic, uncontested win). The
   * $0-chips-at-hand-start exclusion this was trying to add belongs in
   * its own, narrowly-named helper instead -- see
   * _dealableActivePlayers() -- used only by the genuine dealing/ante
   * call sites that actually need it. This is, once again, the "two
   * concepts sharing one name" pattern this project keeps hitting --
   * this time in function form rather than a data field.
   */
  _activePlayers() {
    return this.players.filter((p) => !p.folded && !p.sittingOut);
  }

  /**
   * NEW 9.7 (split out of _activePlayers(), see its own comment for
   * why): who's eligible to be dealt into a fresh hand and to owe an
   * ante/blind -- not folded, not sitting out, AND holding a real
   * stake. CORRECTED 9.6 (per direct confirmation, overriding the spec
   * text as originally uploaded): a $0-chip player is emphatically NOT
   * "sitting out" -- `sittingOut` means only that a player clicked Sit
   * Out or disconnected, nothing else ever sets it. Computed fresh
   * every time from `chips`, never a persisted flag -- see the
   * removed `_autoSitOutBrokePlayers()`. Deliberately NOT used by
   * anything that needs to keep counting an already-all-in player as
   * part of the hand (turn-completion checks, pot eligibility,
   * heads-up detection) -- those all stay on the plain
   * _activePlayers() above.
   */
  _dealableActivePlayers() {
    return this.players.filter((p) => !p.folded && !p.sittingOut && p.chips > 0);
  }

  /**
   * NEW 10.1 (the-cut-spec_v10-1.md §8.2): the base layer everything else
   * in this section builds on -- was this Player actually dealt into the
   * CURRENT hand at all? `hand.length > 0` is the direct signal, with one
   * critical exception: the legacy no-Game-Choice "flexible toolbox" mode
   * (`!isPhaseGated(this.profile)`, still extensively exercised by
   * gameTable-core.test.js) never calls deal() at all and has no
   * dealt-in/never-dealt-in distinction to make in the first place --
   * every seated Player there is simply part of the action, exactly as
   * that mode's own existing behavior and tests assume. Scoping the
   * dealt-in requirement to phase-gated profiles only means this whole
   * 10.1 rework changes NOTHING for that legacy mode, by construction,
   * not by accident.
   */
  _wasDealtIn(player) {
    if (!isPhaseGated(this.profile)) return true;
    return player.hand.length > 0;
  }

  /**
   * NEW 10.1 (the-cut-spec_v10-1.md §8.2): "is this Player part of the
   * current hand at all" -- the base eligibility question the spec
   * explicitly asks for, everything narrower layers on top of this.
   * Dealt in, not folded, not sitting out. Deliberately does NOT exclude
   * allIn/bettingCapped -- an all-in Player is very much still part of
   * the hand (eligible for pots, must still submit Discard/Declare
   * input, counts toward heads-up/opponent-ceiling calculations) even
   * though they can no longer personally act. That narrower question is
   * _canAct(), below.
   */
  _isHandParticipant(player) {
    return this._wasDealtIn(player) && !player.folded && !player.sittingOut;
  }

  /**
   * NEW 10.1 (the-cut-spec_v10-1.md §8.2): "can this Player currently
   * take a betting action, or be selected as one who could" -- a hand
   * participant (above) who additionally still has a live decision to
   * make: not all-in, not bettingCapped. This is the ONE shared
   * definition for turn order, betting-round-close completion, and
   * setOpeningBettor eligibility -- previously three independent
   * hand-rolled combinations of the same four fields, confirmed to have
   * drifted out of sync (missing the dealt-in check) in all three places
   * per Mike's own v10.0 live testing.
   */
  _canAct(player) {
    return this._isHandParticipant(player) && !player.allIn && !player.bettingCapped;
  }

  /**
   * NEW 10.0 (seat-player-dealer-spec.md §2, the-cut-spec_v10-0.md §2.1),
   * REFACTORED 10.1 to build on _wasDealtIn() rather than repeating its
   * own inline `hand.length > 0` check -- no behavior change, just no
   * longer an independent reimplementation of the same base fact.
   * Eligible to win at least a portion of any pot that hasn't been
   * claimed yet. Deliberately independent of both `allIn` (a display
   * label that clears on refund, refund-scenario-reference.md Scenarios
   * C/D) and `bettingCapped` (an acting restriction, not an outcome
   * determination) -- and, unlike _isHandParticipant/_canAct above, also
   * requires the hand itself not be idle (§2.1: "eligible to win... a
   * pot that hasn't been claimed yet" has no meaning between hands).
   */
  _isPending(player) {
    return !this.idle && this._wasDealtIn(player) && !player.folded && !this.provenLosers.has(player.id);
  }

  /**
   * NEW 10.4 (the-cut-spec_v10-4.md Standing Convention / B.3): the
   * single shared answer to "can this Player currently Buy Chips,"
   * consumed by both buyChips() itself (server-side enforcement) and
   * toRedactedState (client-side gating) -- exactly the pattern the new
   * Standing Convention requires going forward: the server computes the
   * real, final answer once, the client reads it, never reconstructs it.
   * B.3 (10.3) added the RequestAntes-specific half of this logic
   * directly inside buyChips() itself and never exposed it, leaving the
   * client's own `canBuyChips` reading `pending` alone -- unaware the
   * newer restriction existed at all. Factored out here so both
   * consumers are guaranteed to agree, by construction, not by two
   * people remembering to keep two copies in sync.
   */
  _canBuyChips(player) {
    if (this._isPending(player)) return false;
    if (this.handPhase === 'RequestAntes' && (player.oweAnte > 0 || (player.totalContributedThisHand || 0) > 0)) {
      return false;
    }
    return true;
  }

  /**
   * NEW 10.2 (the-cut-spec_v10-2.md §9.3 items 4/5): a NARROWER, deliberately
   * separate question from _wasDealtIn() -- "was this Player dealt an
   * original hand for the CURRENT hand," independent of whether they
   * currently hold any cards right now. `_wasDealtIn()`'s `hand.length > 0`
   * is the wrong signal for Draw's post-Discard redraw functions
   * specifically: verified directly that discard() has no ceiling
   * relating `maxDiscards` to `cardsPerPlayer`, so a Dealer-configured
   * table can legitimately let a Player discard their ENTIRE hand,
   * reaching `hand.length === 0` while still being a completely genuine
   * hand participant awaiting their redraw -- a bare dealt-in check
   * would incorrectly exclude them.
   *
   * `discardPhaseActed` is the correct signal instead: verified directly
   * that both discard() and standPat() already correctly reject a
   * never-dealt Player before ever setting it (discard() by construction
   * -- an empty hand can never match a submitted card id; standPat() via
   * its own explicit `hand.length === 0` guard) -- so `discardPhaseActed`
   * can only ever become true for a Player who genuinely held cards to
   * act on. `player.hand.length > 0` is kept alongside it only to also
   * cover the moment BEFORE this hand's Discard phase has run at all
   * (dealToPlayer/dealToAllPlayers are gated to DrawPhase, i.e. always
   * called AFTER Discard-phase completion, so in practice
   * discardPhaseActed alone would suffice today -- the OR is there so
   * this function stays correct even if these two are ever reached from
   * an earlier phase in the future, rather than being correct only by
   * coincidence of current call order).
   */
  _wasDealtOriginalHandThisRound(player) {
    return player.discardPhaseActed || player.hand.length > 0;
  }

  /**
   * NEW 10.1 (the-cut-spec_v10-1.md §8.2/§8.3 defects 7-9): the single
   * shared definition of "who can currently claim, or receive an
   * allocation of, the CURRENT claimable pot" -- multi-pot mode scopes
   * to that specific tier's own contribution-threshold eligibility
   * (`_recomputePots()`'s own eligiblePlayerIds, a Side-Pot *computation*
   * result this function never touches or duplicates -- see the-cut-spec_v10-1.md
   * §0), minus provenLosers (the 9.6 cascading-exclusion layer,
   * deliberately kept separate from eligiblePlayerIds itself -- see
   * this.provenLosers's own constructor comment). The ordinary
   * single-pot case (this.pots not populated) has no per-tier threshold
   * to consult, so it falls back to "every current hand participant,
   * minus provenLosers" -- previously this fallback was the bare
   * `_activePlayers()`, missing BOTH the dealt-in check and the
   * provenLosers exclusion entirely (defects 7 & 9). Used by claimPot()
   * itself and exposed via toRedactedState so the client never
   * re-derives this independently (defect 8; §8.2's client requirement).
   */
  _currentClaimEligiblePlayerIds() {
    const multiPot = Array.isArray(this.pots) && this.pots.length > 0;
    if (multiPot) {
      const currentPot = this._currentClaimablePot();
      if (!currentPot) return [];
      return currentPot.eligiblePlayerIds.filter((id) => !this.provenLosers.has(id));
    }
    return this.players.filter((p) => this._isHandParticipant(p) && !this.provenLosers.has(p.id)).map((p) => p.id);
  }

  /**
   * NEW 10.1 (the-cut-spec_v10-1.md §8.2/§8.3 defect 8): is there
   * actually a claimable pot right now, independent of any specific
   * Player's own eligibility for it? Showdown always qualifies; before
   * Showdown, only the early-claim case (exactly one eligible Player
   * left to contest the current pot) does. The non-phase-gated legacy
   * mode has no Showdown concept at all -- always claimable there,
   * matching its pre-10.1 behavior exactly (claimPot() itself never
   * phase-gated in that mode). Exposed via toRedactedState so the
   * client's Claim Pot button stops guessing at this with no server
   * input at all, which is what it did before this version.
   */
  _claimWindowOpen() {
    if (this.pendingClaim) return false;
    const potAmount = Array.isArray(this.pots) && this.pots.length > 0 ? this._currentClaimablePot()?.amount : this.pot;
    if (!potAmount || potAmount <= 0) return false;
    if (!isPhaseGated(this.profile)) return true;
    if (this.handPhase === 'Showdown') return true;
    return this._currentClaimEligiblePlayerIds().length === 1;
  }

  /**
   * NEW 5.0 (§4.1/§5.8), extended 6.0 (§5.9), extended 7.0 (§5.10): the
   * single place `handPhase` ever gets reassigned. For Draw, Hold'em, and
   * (as of 7.0) Stud, `idle` is now a direct, derived reflection of phase
   * (true only during PreGame/CycleComplete) -- kept in sync here so
   * nothing else has to remember to do it. For any gameTable with no profile
   * at all, `handPhase` just updates as inert bookkeeping (nothing reads
   * it) and `idle` is left completely alone. All three primary profiles
   * now use the phase machine (§12) -- this branch only excludes the
   * no-profile-selected case.
   */
  _setHandPhase(phase) {
    this.handPhase = phase;
    if (isPhaseGated(this.profile)) {
      this.idle = phase === 'PreGame' || phase === 'CycleComplete';
      // NEW 11.0 (Part E): "once the cycle closes, the split ends" --
      // this is the one place a cycle is ever recognized as closing, so
      // it's the correct, single place to clear a mid-cycle emergency
      // Dealer-handoff's positional-anchor split. A no-op the overwhelming
      // majority of the time (dealerPositionAnchorId is already null).
      if (phase === 'PreGame' || phase === 'CycleComplete') {
        this.dealerPositionAnchorId = null;
        // NEW 11.0 (Part F.4): the actual moment any Player marked
        // pendingDeparture (a mid-cycle Leave Table/Remove Player,
        // deferred per F.4) really leaves and the seat list compacts --
        // deferred here specifically so mid-cycle positions never shift
        // while a hand is still being played out, the exact same
        // boundary the Part E anchor split above waits for. Collect ids
        // first, then remove, since removePlayer() mutates this.players.
        const departingIds = this.players.filter((p) => p.pendingDeparture).map((p) => p.id);
        for (const id of departingIds) this.removePlayer(id);
      }
    }
  }

  /**
   * NEW 5.0 (§5.8): the single place the "reshuffle + clear + request
   * ante" logic lives, run identically no matter which trigger brought
   * the gameTable here (New Hand, Same Game, Select→Start, or the original
   * PreGame Dealer-selects-game flow) -- deliberately NOT duplicated
   * inside each trigger's own method, to avoid the exact bug class that
   * hit 4.1/4.2's Reshuffle (a reset step existing on one path but not
   * another). `clearFolded` is the one thing that varies by entry point:
   * true from PreGame/CycleComplete (a genuine new Cycle), false via New
   * Hand (the same Cycle continuing, already-folded players stay out).
   */
  _enterRequestAntes(clearFolded) {
    this._performFullReset({ clearFolded });
    // FIXED 11.2 (Fix 1): the 10.3-era comment below was correct at the
    // time it was written -- every call here WAS a genuinely new hand
    // back then. It stopped being true the moment a Cycle could span
    // more than one hand (ReAnteable games, New Hand mid-Cycle): this
    // was being recaptured on EVERY hand, including a re-ante hand
    // within an ongoing Cycle, silently overwriting the true
    // start-of-Cycle snapshot with a mid-Cycle one that already
    // reflects the prior hand's ante deducted into a still-open pot.
    // Restoring to that and then zeroing the pot (restorePlayerStacks())
    // discarded that money outright rather than conserving it. Only
    // recapture on a genuine new Cycle (`clearFolded === true`, i.e.
    // entry from PreGame/CycleComplete) -- the only point where the
    // total money in play is unambiguous. See restorePlayerStacks()'s
    // own updated comment for the restore-side half of this fix.
    if (clearFolded) {
      this._preGameSnapshot = snapshotPlayers(this.players);
    }
    const dealer = this.getDealer();
    // CHANGED 11.0 (Part E): use the positional anchor, not necessarily
    // the current Dealer -- if a mid-cycle emergency handoff split is in
    // effect, a subsequent hand within the SAME cycle (ReAnteable games)
    // must still seed blinds/ante from the ORIGINAL Dealer's seat.
    if (dealer) this._autoApplyAnte(this._positionAnchorId());
    this.killHandConfirmPending = false; // NEW 8.2 -- safety net; the confirm/cancel pair should already have cleared this directly
    this._setHandPhase('RequestAntes');
    // BUG FIX 9.1 (found while building refund-scenario test fixtures --
    // a genuine gap, not specific to 9.1's own feature work): if nobody
    // ends up owing anything at all (e.g. a Dealer sets smallBlind/
    // bigBlind to $0), _maybeAdvanceFromRequestAntes() previously only
    // ever ran from inside postAnteBlind() itself -- which nobody could
    // ever call if nobody owes anything, permanently stranding the hand
    // at RequestAntes with no legal action available to move it forward.
    this._maybeAdvanceFromRequestAntes();
  }

  // REMOVED 9.6: _autoSitOutBrokePlayers() and the Dealer-reassignment
  // logic it grew in 9.4. CORRECTED (per direct confirmation, overriding
  // the 9.2-9.4 spec text on this one specific point): a $0-chip player
  // was never actually "sitting out" -- reusing `sittingOut` for this
  // was the wrong field from the start, for any player, Dealer or not.
  // `sittingOut` means only that a player clicked Sit Out or
  // disconnected; nothing else ever sets it, as of 9.6. $0-chip
  // exclusion from dealing/ante is now computed fresh every time
  // directly from `chips` (see _dealableActivePlayers(), deal(),
  // _computeBlindSeats(), _autoApplyAnte(), openBetting() -- every one
  // of them now excludes chips === 0 directly, never a persisted flag).
  // BUG FIX 9.7: this originally pointed at _activePlayers() itself --
  // that was the actual regression fixed in 9.7 (see _activePlayers()'s
  // own comment). The plain _activePlayers() is unchanged since before
  // 9.6 and does NOT exclude $0-chip players; only the four call sites
  // named above (dealing/ante specifically) and _dealableActivePlayers()
  // itself carry that exclusion.
  // This also means a $0-chip Dealer needs NO special handling at all:
  // they simply aren't dealt in and don't owe anything, exactly like any
  // other $0 player, while remaining fully able to Deal, Open Betting,
  // approve claims, and every other Dealer-role action -- nothing in
  // this codebase ever gated any of those on chip count, so there was
  // never actually a conflict with the Dealer role to design around.

  /**
   * NEW 5.0, extended 6.0, extended 7.0, CHANGED 8.0 (§2): RequestAntes
   * advances once every active player's ante/blind is settled -- to
   * whatever `firstPhaseAfterAntes` the active profile's table declares
   * (`OpeningDeal` for Draw, `PreFlop` for Hold'em, `StreetA` for Stud).
   * A fourth phase-machine profile needs nothing added here -- just its
   * own table entry.
   */
  _maybeAdvanceFromRequestAntes() {
    if (this.handPhase !== 'RequestAntes') return;
    const nextPhase = getProfileTable(this.profile)?.firstPhaseAfterAntes;
    if (!nextPhase) return;
    // BUG FIX 9.7: uses _dealableActivePlayers(), not the plain
    // _activePlayers() -- this check is specifically about whether
    // dealing can proceed, not about who's still part of an existing
    // hand. A $0-chip player never has oweAnte set at all (excluded in
    // _autoApplyAnte), so they'd trivially satisfy `oweAnte === 0`
    // either way -- but using the dealable variant correctly prevents
    // advancing into a hand with `active.length === 0` (e.g. every
    // seated player happens to be broke), which the plain
    // _activePlayers() would wrongly allow.
    const active = this._dealableActivePlayers();
    if (active.length > 0 && active.every((p) => p.oweAnte === 0)) {
      this._setHandPhase(nextPhase);
    }
  }

  /** NEW 5.0: DiscardPhase -> DrawPhase once every active player has Discarded or Stood Pat. */
  _maybeAdvanceFromDiscardPhase() {
    if (this.profile !== 'draw' || this.handPhase !== 'DiscardPhase') return;
    // CHANGED 10.1 (the-cut-spec_v10-1.md §8.2/§8.3 defect 3): routed
    // through _isHandParticipant() (dealt in, not folded, not sitting
    // out) -- deliberately NOT _canAct(), since an all-in player still
    // must submit Discard/Stand Pat input (BUG FIX 9.7's own confirmed
    // rule). Previously used the bare _activePlayers(), which included a
    // never-dealt $0-chip Player -- they can never satisfy
    // discardPhaseActed, hanging this phase forever.
    const active = this.players.filter((p) => this._isHandParticipant(p));
    if (active.length > 0 && active.every((p) => p.discardPhaseActed)) {
      this._setHandPhase('DrawPhase');
    }
  }

  /**
   * NEW 8.1 (§5.11): Declare -> Showdown once every active
   * (non-folded, non-sitting-out) player has submitted a declaration.
   * Mirrors _maybeAdvanceFromDiscardPhase's exact shape -- a
   * player-submitted phase with no Dealer action, waiting on the same
   * "every active player has acted" condition. Stud only, and only
   * ever reached for `declareHighLowBoth` presets (the profile table's
   * own transition into `Declare` is itself gated on that flag).
   */
  _maybeAdvanceFromDeclare() {
    if (this.profile !== 'stud' || this.handPhase !== 'Declare') return;
    // CHANGED 10.1: see _maybeAdvanceFromDiscardPhase()'s matching
    // comment -- same fix, same reasoning (defect 3).
    const active = this.players.filter((p) => this._isHandParticipant(p));
    if (active.length > 0 && active.every((p) => p.declaration !== null)) {
      this._setHandPhase('Showdown');
    }
  }

  /**
   * NEW 5.0, extended 6.0/7.0, CHANGED 8.0 (§2): called whenever a
   * betting round naturally closes. Looks up the active profile's own
   * `bettingRoundClosedTransitions` table (src/profiles/*.js) instead of
   * branching on `this.profile` here directly -- Draw's FirstBetting
   * "nobody opened" exception, Hold'em's plain unconditional four-street
   * lookup, and Stud's letter-based/`finalStreet`-branching progression
   * are now each just data owned by their own profile's table, looked up
   * the same generic way regardless of which profile is active. A
   * transition entry can be a literal next-phase string, or a function
   * of `this` (the gameTable) for a transition whose target depends on
   * table state at the moment -- see draw.js/stud.js for the two cases
   * that need one. Returning `null` from a function entry means "don't
   * advance" -- New Hand becomes the available action instead, checked
   * independently by `newHand()`'s own gate.
   */
  _onBettingRoundClosed() {
    const transitions = getProfileTable(this.profile)?.bettingRoundClosedTransitions;
    const transition = transitions?.[this.handPhase];
    if (!transition) return;
    const nextPhase = typeof transition === 'function' ? transition(this) : transition;
    if (nextPhase) this._setHandPhase(nextPhase);
  }

  _applyPendingSitOuts() {
    for (const player of this.players) {
      if (player.sitOutPending) {
        player.sittingOut = true;
        player.sitOutPending = false;
      }
    }
  }

  /**
   * NEW 4.2: resolves queued Sit In requests. Called everywhere `idle`
   * transitions to true -- an approved claim, or a Reshuffle (§4.1/§9).
   */
  _applyPendingSitIns() {
    for (const player of this.players) {
      if (player.sitInPending) {
        player.sittingOut = false;
        player.sitInPending = false;
      }
    }
  }

  /**
   * Default face-up/down for a card at a given zero-indexed position in a
   * hand (position = how many cards that player already had before this
   * one). Only Stud profiles define a pattern; everything else deals
   * private by default (spec §5.3).
   */
  _defaultFaceUpForPosition(position) {
    if (this.profile === 'stud' && Array.isArray(this.gameOptions?.pattern)) {
      const value = this.gameOptions.pattern[position];
      if (value === 'up') return true;
      if (value === 'down') return false;
    }
    return false;
  }

  /**
   * BUG FIX 8.2 (§5.10 extension): the STARTING index into
   * `gameOptions.pattern` for the given Stud street letter -- e.g. for a
   * 7-Card preset (`pattern` length 7, `StreetA` delivers 3 cards),
   * `StreetB` starts at index 3, `StreetC` at 4, and so on. Needed
   * because `_continueDeal()` can no longer safely use
   * `player.hand.length` as the pattern index (the pre-8.2 approach) --
   * a Baseball player who bought one or more extra cards has a hand
   * bigger than their actual street position, so indexing by count
   * silently drifted face-up/down determination out of sync for exactly
   * those players (the 8.1 bug this fixes). Indexing by STREET instead,
   * via this function plus `_dealResumeContext.perPlayerDealtCount`
   * (tracking each player's card count for the CURRENT deal() call
   * only, separate from their lifetime hand size), is correct regardless
   * of how many extra cards anyone's bought.
   */
  _streetPatternBaseIndex(letter) {
    const initialCount = this.finalStreet === 'E' ? 3 : 2;
    if (letter === 'A') return 0;
    const lettersAfterA = ['B', 'C', 'D', 'E'];
    return initialCount + lettersAfterA.indexOf(letter);
  }

  /**
   * Deal N cards to each active (not sitting out, not folded) player,
   * round-robin in turn order. Skips folded players (4.4) -- a no-op in
   * the ordinary case (a fresh hand always clears `folded` first), but
   * essential right after a New Hand entered mid-Cycle (§5.8), which
   * deliberately leaves `folded` intact so already-folded players stay
   * excluded. Optional `faceUpOverride`: when provided, every card dealt
   * in this action (to every recipient) uses that visibility instead of
   * the active Stud pattern's per-position default. Also resets
   * discardCountThisHand for everyone, since a fresh Deal marks the
   * start of a new hand's discard allowance.
   * CHANGED 5.0 (§5.1/§5.8): for the Draw profile, only clickable during
   * the `OpeningDeal` phase; on success, transitions to `FirstBetting`.
   * CHANGED 6.0 (§5.9): for Hold'em, this is the same primitive used to
   * deal hole cards (2 for Texas, 4 for Omaha) -- only clickable during
   * `PreFlop`; on success, transitions to `PreFlopBetting`. Every other
   * profile is completely unaffected -- Deal remains ungated for them,
   * exactly as it worked through 4.5. Dealer-only.
   * CHANGED 7.0 (§5.10): for Stud, this is the same primitive used for
   * every street's card -- the initial multi-card deal at `StreetA` (2 or
   * 3, preset-driven) and each subsequent single card at `StreetB`
   * through `StreetE` -- only clickable while `handPhase` is one of those
   * un-suffixed `Street*` phases; on success, transitions to the matching
   * `Street*Betting` phase and resets `openingBettorId` to null, since
   * it's re-selected fresh every street (§6.8).
   * CHANGED 8.1 (§5.10 extension, `dealIsInterruptable` presets only):
   * this single Dealer click can now pause mid-way through, waiting on
   * an affected player's Pay/Fold or Buy/Decline decision, and resume
   * automatically once that resolves -- with NO further Dealer action
   * anywhere in the sequence (spec's own wording: "the Dealer never
   * dealt the paused-for card differently in the first place"). Builds
   * a flat queue of card-slots (one entry per card still owed, in the
   * SAME order the original nested per-player loop always dealt in --
   * every one of recipient 1's cards, then recipient 2's, etc., not
   * redesigned to round-robin) and hands it to `_continueDeal()`, which
   * does the actual dealing and owns the pause/resume logic. For every
   * non-`dealIsInterruptable` preset (everything except the two Baseball
   * variants), this is functionally identical to the pre-8.1 behavior --
   * the queue always drains in one synchronous pass, nothing pauses.
   */
  deal(cardsPerPlayer, requesterId, faceUpOverride) {
    const dealer = this.getDealer();
    if (!dealer || dealer.id !== requesterId) {
      return { ok: false, error: 'Only the Dealer can deal.' };
    }
    if (this.pendingClaim) return { ok: false, error: 'A claim is pending approval.' };
    // NEW 8.1 (§5.10 extension): a second Deal click while a
    // dealIsInterruptable preset's dealing loop is already paused (e.g.
    // a Dealer double-click, or a stale/un-disabled Deal button on the
    // Dealer's own rail while waiting on another player's Pay/Fold or
    // Buy/Decline decision) must be rejected outright -- without this,
    // it would silently start a SECOND, independent deal queue and
    // clobber `_dealResumeContext`/`_dealQueue`, corrupting hand sizes.
    if (this._pendingDealInterrupt) {
      return { ok: false, error: 'A deal is already paused, waiting on a player decision.' };
    }
    const isDraw = this.profile === 'draw';
    const isHoldem = this.profile === 'holdem';
    const isStud = this.profile === 'stud';
    const studDealMatch = isStud ? /^Street([A-E])$/.exec(this.handPhase) : null;
    if (isDraw && this.handPhase !== 'OpeningDeal') {
      return { ok: false, error: 'Deal is only available during the Opening Deal phase.' };
    }
    if (isHoldem && this.handPhase !== 'PreFlop') {
      return { ok: false, error: 'Deal is only available during the Pre-Flop phase.' };
    }
    if (isStud && !studDealMatch) {
      return { ok: false, error: 'Deal is only available at the start of a street.' };
    }
    this._applyPendingSitOuts();

    // CHANGED 10.2 (the-cut-spec_v10-2.md §9.3 item 6): Stud reuses this
    // SAME method for every street within one hand -- StreetA (the
    // genuine initial deal, where `chips > 0` alone is exactly the right
    // question, same as every other profile's first deal) AND every
    // later street B-E (a single extra card each). The `chips > 0` check
    // alone is not sufficient from StreetB onward: a Player who sits
    // down and buys chips BETWEEN two Stud streets would pass it and
    // could be dealt into a hand already in progress, despite never
    // having received their StreetA cards. `p.hand.length > 0` (Stud
    // hands only ever grow, never shrink via a discard mechanic the way
    // Draw's can -- see _wasDealtOriginalHandThisRound()'s own comment
    // for why that same signal would be UNSAFE for Draw specifically) is
    // the correct, safe "was already part of this hand from StreetA
    // onward" check for Stud's later streets, added on top of the
    // unchanged StreetA/Draw/Hold'em behavior, not replacing it.
    const isStudLaterStreet = isStud && studDealMatch && studDealMatch[1] !== 'A';
    const recipients = this.turnOrder
      .map((id) => this.getPlayer(id))
      // CHANGED 10.3 (the-cut-spec_v10-3.md §B.1, live-confirmed):
      // `chips > 0` is correct for the genuine initial deal (StreetA/
      // Hold'em/Draw -- nobody can legitimately be mid-hand all-in
      // before a hand has started), but 10.2's own later-street fix
      // never re-examined whether `chips > 0` still belonged alongside
      // the new `hand.length > 0` check for Stud's LATER streets. It
      // doesn't: a genuinely all-in Player surviving from an earlier
      // street is still entitled to their card every subsequent street,
      // and `chips > 0` wrongly excluded them -- confirmed live to block
      // dealing entirely (3 of 4 remaining Players all-in on 3rd Street,
      // `recipients.length` dropped below MIN_PLAYERS_TO_DEAL). For the
      // later-street case, `hand.length > 0` plus folded/sittingOut are
      // sufficient and correct on their own -- `chips > 0` is only
      // consulted for the initial-deal case, unchanged.
      .filter((p) => p && !p.sittingOut && !p.folded && (isStudLaterStreet ? p.hand.length > 0 : p.chips > 0));
    if (recipients.length < MIN_PLAYERS_TO_DEAL) {
      return { ok: false, error: `Need at least ${MIN_PLAYERS_TO_DEAL} active (not sitting out, not folded) players to deal.` };
    }
    if (!Number.isInteger(cardsPerPlayer) || cardsPerPlayer < 1) {
      return { ok: false, error: 'Cards per player must be a positive whole number.' };
    }
    const needed = cardsPerPlayer * recipients.length;
    if (needed > this.deck.length) {
      return { ok: false, error: 'Not enough cards left in the deck for that deal.' };
    }

    // Per-hand bookkeeping that only makes sense once, at the START of a
    // fresh Deal action -- unaffected by whether this particular deal
    // goes on to pause partway through.
    for (const player of this.players) {
      player.discardCountThisHand = 0;
      player.mucked = 0;
    }
    this.burnedThisHand = 0;
    this.bettingRoundsThisHand = 0;
    this.discardWindowOpen = true;
    this.rabbitHuntAvailable = false;
    this.rabbitHuntCards = [];

    const queue = [];
    for (const player of recipients) {
      for (let i = 0; i < cardsPerPlayer; i++) queue.push(player.id);
    }
    this._dealResumeContext = {
      profile: this.profile,
      studLetter: studDealMatch ? studDealMatch[1] : null,
      faceUpOverride: typeof faceUpOverride === 'boolean' ? faceUpOverride : null,
      // BUG FIX 8.2: base pattern index for this street (Stud only;
      // null/unused for Draw/Hold'em, which have no pattern concept at
      // all) and a per-player counter of cards dealt so far in THIS
      // deal() call specifically -- see _streetPatternBaseIndex's own
      // comment for why this replaces player.hand.length.
      basePatternIndex: isStud && studDealMatch ? this._streetPatternBaseIndex(studDealMatch[1]) : null,
      perPlayerDealtCount: {},
    };
    return this._continueDeal(queue);
  }

  /**
   * NEW 8.1 (§5.10 extension): deals from the front of `queue` one card
   * at a time. After each FACE-UP card, checks whether the active
   * preset is `dealIsInterruptable` and the rank is a 3 or 4 -- if so,
   * `_resolveOrPauseInterrupt` either resolves it immediately (a `Free`
   * price -- there's no real decision when Pay/Buy always dominates at
   * no cost) or sets `_pendingDealInterrupt` and signals a pause. On a
   * pause, the remaining queue (everything not yet dealt) is stashed on
   * `this._dealQueue` and this returns immediately with the deal still
   * incomplete -- `handPhase` does NOT transition yet. Down-card streets
   * never trigger this at all, since the check only ever looks at
   * `card.faceUp` cards (spec: "down-card streets never trigger this").
   * Once the queue fully drains with nothing pending, `_finishDeal()`
   * applies the phase transition and every other end-of-deal side effect.
   * Called from `deal()` itself (the common, synchronous-completion
   * case) and from `payDealInterrupt`/`buyDealInterrupt`/
   * `declineDealInterrupt`/`fold`'s Baseball bypass (resuming a
   * previously-paused deal, possibly into ANOTHER pause if a second
   * player later in the same queue also draws a 3 or 4 -- multiple
   * triggers on one street resolve strictly in deal order, one at a
   * time, per spec).
   */
  _continueDeal(queue) {
    const interruptible = this.gameOptions?.dealIsInterruptable === true;
    while (queue.length > 0) {
      const playerId = queue.shift();
      const player = this.getPlayer(playerId);
      if (!player) continue; // defensive; shouldn't happen -- every queued id came from a real recipient
      const card = this.deck.pop();
      const ctx = this._dealResumeContext;
      // BUG FIX 8.2 (§5.10 extension): face-up/down now keys off the
      // STREET being dealt (via basePatternIndex + a per-player,
      // per-call counter), never off player.hand.length -- see
      // _streetPatternBaseIndex's comment for why. Draw/Hold'em (no
      // `basePatternIndex`, since they have no pattern concept at all)
      // fall through to the old hand.length-based lookup unchanged,
      // which was always correct for them (no bought-card concept exists
      // outside Stud).
      let faceUp;
      if (ctx && ctx.faceUpOverride !== null) {
        faceUp = ctx.faceUpOverride;
      } else if (ctx && typeof ctx.basePatternIndex === 'number') {
        const dealtSoFarThisStreet = ctx.perPlayerDealtCount[playerId] || 0;
        faceUp = this._defaultFaceUpForPosition(ctx.basePatternIndex + dealtSoFarThisStreet);
        ctx.perPlayerDealtCount[playerId] = dealtSoFarThisStreet + 1;
      } else {
        faceUp = this._defaultFaceUpForPosition(player.hand.length);
      }
      card.faceUp = faceUp;
      player.hand.push(card);

      if (interruptible && card.faceUp && (card.rank === '3' || card.rank === '4')) {
        const resolvedInline = this._resolveOrPauseInterrupt(player, card.rank);
        if (!resolvedInline) {
          this._dealQueue = queue; // whatever's left, for whenever this resumes
          return { ok: true }; // deal is genuinely incomplete -- no phase transition yet
        }
        // Free price: already auto-resolved inline; the loop just continues.
      }
    }
    this._dealQueue = null;
    this._finishDeal();
    return { ok: true };
  }

  /**
   * NEW 8.1: checks the relevant price (`priceForThrees`/`priceForFours`)
   * for a just-dealt face-up 3 or 4. A `Free` price auto-resolves right
   * here -- Pay always dominates Fold at no cost, Buy always dominates
   * Decline at no cost, so there's no real decision to wait on (spec's
   * own reasoning) -- and returns `true` so `_continueDeal`'s loop keeps
   * going without pausing. Any other price sets `_pendingDealInterrupt`
   * for the affected player and returns `false`, signaling a pause. A
   * Free auto-resolution also queues a brief announcement (see
   * `_queueAnnouncement`) -- the spec calls for "a brief, non-blocking
   * table announcement instead of pausing," and this is the one place
   * that decision is actually made.
   * BUG FIX 8.3 (§5.10 extension): a Free 4's auto-bought card can
   * itself chain into a NEW interrupt (see `_dealExtraCard`'s own
   * comment) -- if it does, this function's own return value now
   * propagates that (`false`), so a caller further up the chain (this
   * function's own recursive call, or `buyDealInterrupt`) correctly
   * knows a pause is now pending and doesn't prematurely resume dealing.
   */
  _resolveOrPauseInterrupt(player, rank) {
    const priceKey = rank === '3' ? 'priceForThrees' : 'priceForFours';
    const price = this.gameOptions?.[priceKey];
    if (price === 'free') {
      if (rank === '4') {
        const resolved = this._dealExtraCard(player); // auto-Buy; a free 3 is just an auto-Pay, no other effect
        this._queueAnnouncement(`${player.name} was dealt a 4 \u2014 Buy is Free, an extra card was dealt automatically.`);
        if (!resolved) return false; // the bought card itself chained into a new pause -- see _dealExtraCard
      } else {
        this._queueAnnouncement(`${player.name} was dealt a 3 \u2014 Pay is Free, resolved automatically.`);
      }
      return true;
    }
    this._pendingDealInterrupt = { playerId: player.id, triggerRank: rank };
    return false;
  }

  /**
   * NEW 8.1: appends a plain-text announcement to a per-instance queue
   * that `server.js` drains and broadcasts (as a one-off `announcement`
   * message, never persisted or replayed) right after the action that
   * triggered it finishes. Deliberately NOT part of `toRedactedState` --
   * an announcement is a transient event, not durable table state; a
   * client that reconnects mid-hand has no need to see it again, unlike
   * every other field this class exposes.
   */
  /**
   * CHANGED 9.0 (§6.11): accepts an optional `kind` tag, defaulting to
   * null for every existing (Baseball interrupt) call site -- lets the
   * client style specific announcement types differently (e.g. All-In's
   * "louder" notice, per spec) without pattern-matching announcement
   * text, which would be fragile and against this project's own
   * "primitives not rules" preference for explicit signals.
   */
  _queueAnnouncement(text, kind = null) {
    this._pendingAnnouncements.push({ text, kind });
  }

  /**
   * NEW 8.1: drains and returns every announcement queued since the
   * last drain. Called once per action handler in server.js, right
   * after broadcasting the resulting state -- see handleDeal and its
   * siblings. CHANGED 9.0 (§6.11): each entry is now `{ text, kind }`
   * rather than a plain string -- `kind` is null for every pre-9.0
   * (Baseball interrupt) announcement, `'allin'` for the new All-In
   * table-wide notice.
   */
  drainAnnouncements() {
    const announcements = this._pendingAnnouncements;
    this._pendingAnnouncements = [];
    return announcements;
  }

  /**
   * NEW 8.1: deals exactly one additional card to `player`, face-up or
   * face-down per `gameOptions.extraCardUpOrDown` -- Baseball's bought
   * (or auto-bought, if Free) extra card from a 4. Doesn't advance
   * street numbering or touch the deal queue at all (spec: "bought/extra
   * cards don't advance street numbering... there's no '8th Street'") --
   * this is a card ADDED to the player's hand outside the normal
   * per-street count, dealt immediately as a direct side effect of their
   * own Buy decision (or the Free auto-resolution), never a separate
   * Dealer click. Silently no-ops if the deck is empty rather than
   * throwing -- an edge case rare enough (52-card deck, extra buys are
   * occasional) that failing safe is preferable to rejecting an
   * otherwise-valid Buy/auto-Buy outright.
   * BUG FIX 8.3 (§5.10 extension): the bought card is now checked
   * against the exact same interrupt-trigger condition
   * `_continueDeal()`'s main per-player loop already uses -- "the
   * mechanic cares about a card's rank and orientation, not how it was
   * dealt" (spec's own wording). A face-up 3 or 4 here chains into a
   * fresh interrupt via `_resolveOrPauseInterrupt`, recursively, however
   * deep (no artificial cap -- vanishingly unlikely to go more than one
   * level given deck composition, but not specially prevented). The 8.2
   * build never made this check at all, so no chaining ever occurred in
   * practice, silently. Returns `true` if this card (and any further
   * chained cards) fully resolved with nothing left pending; `false` if
   * it (or a further chain) set a new `_pendingDealInterrupt` still
   * waiting on a player decision -- callers must check this before
   * assuming it's safe to resume the main deal queue.
   */
  _dealExtraCard(player) {
    if (this.deck.length === 0) return true; // nothing dealt, nothing to chain -- trivially resolved
    const card = this.deck.pop();
    card.faceUp = this.gameOptions?.extraCardUpOrDown === 'up';
    player.hand.push(card);
    const interruptible = this.gameOptions?.dealIsInterruptable === true;
    if (interruptible && card.faceUp && (card.rank === '3' || card.rank === '4')) {
      return this._resolveOrPauseInterrupt(player, card.rank);
    }
    return true;
  }

  /**
   * NEW 8.1: resolves one of the `priceForThrees`/`priceForFours` enum
   * values into an actual dollar amount, off the active preset's own
   * dollar-amount options. `free` is handled entirely inline in
   * `_resolveOrPauseInterrupt` and never reaches this function.
   * CHANGED 12.3 (the-cut-spec_v12-3.md Part E.2): old value set
   * (smallBet/bigBet/bigBetX2/bigBetX4/pot) replaced with a new one
   * (ante/bringIn/bringInX2/bringInX4/pot) -- Small Bet/Big Bet may not
   * even exist for the current Bet/Raise Limits (Part A hides them
   * outside Fixed-Limit), so the price list can no longer reference
   * them. Ante and Bring In always exist regardless of betting
   * structure. Same shape of lookup as before, new labels and new
   * source fields, no new architecture -- resolves only at the single
   * moment a price is actually paid (payDealInterrupt/
   * buyDealInterrupt below), not on every render.
   */
  _resolvePriceAmount(priceValue) {
    const ante = this.gameOptions?.anteAmount || 0;
    const bringIn = this.gameOptions?.bringIn || 0;
    switch (priceValue) {
      case 'ante':
        return ante;
      case 'bringIn':
        return bringIn;
      case 'bringInX2':
        return bringIn * 2;
      case 'bringInX4':
        return bringIn * 4;
      case 'pot':
        return this.pot;
      default:
        return 0;
    }
  }

  /**
   * NEW 8.1: the Pay half of Baseball's forced Pay-or-Fold decision on a
   * face-up 3 (§5.10 extension). Not a bet -- moves the priced amount
   * straight from the player's own chips into the pot; never touches
   * `currentBetToCall` or any other player's required action (spec's own
   * wording). Only the specific player currently named in
   * `_pendingDealInterrupt` can call this, and only for a '3' trigger --
   * Fold is the other half of this specific decision (reuses the
   * existing `fold()` primitive directly, see its own §8.1 bypass
   * branch, not a separate method here). Resumes the paused deal queue
   * immediately on success, which may pause again for a later player's
   * own 3 or 4 in the same street, per spec's strict-deal-order rule.
   */
  payDealInterrupt(requesterId) {
    const pending = this._pendingDealInterrupt;
    if (!pending || pending.playerId !== requesterId) {
      return { ok: false, error: 'No Pay decision is pending for you right now.' };
    }
    if (pending.triggerRank !== '3') {
      return { ok: false, error: 'Pay only applies to a face-up 3 -- Buy or Decline is for a 4.' };
    }
    const player = this.getPlayer(requesterId);
    if (!player) return { ok: false, error: 'Player not found.' };
    const amount = this._resolvePriceAmount(this.gameOptions?.priceForThrees);
    player.chips -= amount;
    this.pot += amount;
    this._pendingDealInterrupt = null;
    return this._continueDeal(this._dealQueue || []);
  }

  /**
   * NEW 8.1: the Buy half of Baseball's Buy-or-Decline decision on a
   * face-up 4 (§5.10 extension). Pays the priced amount into the pot,
   * same mechanics as Pay above, and deals one extra card automatically
   * (`_dealExtraCard`) -- no separate Dealer click for the extra card,
   * per spec. Only the specific player currently named in
   * `_pendingDealInterrupt` can call this, and only for a '4' trigger.
   * BUG FIX 8.3: clears THIS decision's pending state before dealing the
   * extra card, then checks `_dealExtraCard`'s return value -- if the
   * bought card itself chained into a NEW interrupt (already set by
   * `_dealExtraCard`/`_resolveOrPauseInterrupt` by the time we check),
   * this returns without resuming the main deal queue, leaving the new
   * pause in place for the affected player (which may or may not be the
   * same player) to resolve first.
   */
  buyDealInterrupt(requesterId) {
    const pending = this._pendingDealInterrupt;
    if (!pending || pending.playerId !== requesterId) {
      return { ok: false, error: 'No Buy decision is pending for you right now.' };
    }
    if (pending.triggerRank !== '4') {
      return { ok: false, error: 'Buy only applies to a face-up 4 -- Pay or Fold is for a 3.' };
    }
    const player = this.getPlayer(requesterId);
    if (!player) return { ok: false, error: 'Player not found.' };
    const amount = this._resolvePriceAmount(this.gameOptions?.priceForFours);
    player.chips -= amount;
    this.pot += amount;
    this._pendingDealInterrupt = null; // this decision is resolved; _dealExtraCard may set a NEW one below if it chains
    const resolved = this._dealExtraCard(player);
    if (!resolved) return { ok: true }; // chained into a new pause -- don't resume the main queue yet
    return this._continueDeal(this._dealQueue || []);
  }

  /**
   * NEW 8.1: the Decline half of Baseball's Buy-or-Decline decision on a
   * face-up 4 -- no payment, no extra card, not a fold; play just
   * continues normally (spec's own wording). Only the specific player
   * currently named in `_pendingDealInterrupt` can call this, and only
   * for a '4' trigger.
   */
  declineDealInterrupt(requesterId) {
    const pending = this._pendingDealInterrupt;
    if (!pending || pending.playerId !== requesterId) {
      return { ok: false, error: 'No Decline decision is pending for you right now.' };
    }
    if (pending.triggerRank !== '4') {
      return { ok: false, error: 'Decline only applies to a face-up 4.' };
    }
    this._pendingDealInterrupt = null;
    return this._continueDeal(this._dealQueue || []);
  }

  /**
   * NEW 8.1: the phase-transition and end-of-deal side effects
   * previously inlined at the tail end of `deal()` itself, factored out
   * so `_continueDeal()` can call this once the queue -- across however
   * many interrupt pauses, possibly zero -- is fully drained. For every
   * non-`dealIsInterruptable` preset, and even for interruptible presets
   * on a street where no 3/4 happens to come up face-up, this fires
   * synchronously within the original `deal()` call, exactly as the
   * pre-8.1 inlined version always did. Only for the two Baseball
   * presets, on a street where a pause actually occurred, does this fire
   * later -- from whichever of `payDealInterrupt`/`buyDealInterrupt`/
   * `declineDealInterrupt`/`fold`'s bypass finally drains the queue.
   */
  _finishDeal() {
    const ctx = this._dealResumeContext;
    this._dealResumeContext = null;
    if (!ctx) return; // defensive; should never happen -- deal() always sets this before calling _continueDeal
    if (ctx.profile === 'draw') {
      this._setHandPhase('FirstBetting');
    } else if (ctx.profile === 'holdem') {
      this._setHandPhase('PreFlopBetting');
    } else if (ctx.profile === 'stud') {
      // NEW 7.2 (§6.8): 7-Card Stud's StreetE is a special case -- its
      // card is dealt face-down, so the visible board hasn't changed
      // since StreetD's betting closed. Pre-fills the opening bettor
      // with whoever opened that just-closed round, if still active.
      const previousOpeningBettorId = this.openingBettorId;
      if (ctx.studLetter === 'E') {
        const previousOpener = previousOpeningBettorId ? this.getPlayer(previousOpeningBettorId) : null;
        this.openingBettorId =
          previousOpener && !previousOpener.folded && !previousOpener.sittingOut ? previousOpeningBettorId : null;
      } else {
        this.openingBettorId = null; // re-selected fresh every street (§6.8)
      }
      this._bringInObligationId = null;
      this._setHandPhase(`Street${ctx.studLetter}Betting`);
    } else {
      this.idle = false; // unchanged pre-5.0 behavior for every other profile
    }
  }

  /**
   * The reset routine shared by Reshuffle, Start Game (non-draw), and
   * (as of 5.0) RequestAntes's own phase-entry behavior for the Draw
   * profile -- collects every hand, the discard pile, community cards,
   * and any Rabbit Hunt reveals back into the deck, shuffles, clears
   * hands, resets bettingOpen/currentBetToCall/currentBet/revealed/
   * discardCountThisHand/mucked/bettingRoundsThisHand/discardWindowOpen/
   * rabbitHuntAvailable/rabbitHuntCards/discardPhaseActed/standingPat,
   * sets idle = true, and resolves any pending Sit In requests. Does NOT
   * touch the pot, chips/totalBuyIn, or gameChoiceId/profile/gameOptions.
   *
   * `clearFolded` is the one thing that varies by caller: Reshuffle and
   * Start Game (or RequestAntes entered from PreGame/CycleComplete)
   * clear it (fresh Cycle, everyone's back in); RequestAntes entered via
   * New Hand deliberately does NOT (folded players stay excluded from
   * the Cycle's next Hand, §5.8) -- the direct successor to 4.4/4.5's
   * retired Redeal primitive, which used the same distinction.
   */
  _performFullReset({ clearFolded }) {
    this._applyPendingSitOuts();

    for (const player of this.players) {
      this.deck.push(...player.hand);
      player.hand = [];
      player.currentBet = 0;
      if (clearFolded) player.folded = false;
      player.revealed = false;
      player.discardCountThisHand = 0;
      player.mucked = 0;
      player.discardPhaseActed = false; // NEW 5.0
      player.standingPat = false; // NEW 5.0
      player.declaration = null; // NEW 8.1 (§5.11) -- resets every RequestAntes entry, same as discardPhaseActed/standingPat
      player.allIn = false; // NEW 9.0 (§6.11)
      player.bettingCapped = false; // NEW 9.1 (§6.10)
      player.totalContributedThisHand = 0; // NEW 9.0 (§6.10)
      // FIXED 11.2 (Fix 2, required half): every other per-hand
      // transient field was already reset here -- `oweAnte` was the one
      // gap. postAnteBlind() has no hand-phase check of its own (see its
      // own updated comment for the defense-in-depth half of this fix),
      // so a stale nonzero `oweAnte` surviving a reset was sufficient on
      // its own to let a player post real money into the pot while the
      // table sat idle between games, after Terminate Cleanly or Restore
      // Stacks (both funnel through _forceTerminateCurrentHand() ->
      // this same shared reset).
      player.oweAnte = 0;
    }
    this.deck.push(...this.discardPile);
    this.discardPile = [];
    this.deck.push(...this.communityCards);
    this.communityCards = [];
    this.deck.push(...this.rabbitHuntCards);
    this.rabbitHuntCards = [];
    shuffle(this.deck);

    this.bettingOpen = false;
    this.currentBetToCall = 0;
    this._actedSinceRaise = new Set();
    this.burnedThisHand = 0;
    this.bettingRoundsThisHand = 0;
    this.discardWindowOpen = true;
    this.rabbitHuntAvailable = false;
    this.idle = true;
    this.openingBettorId = null; // NEW 7.0 (§6.8) -- Stud only, fresh selection required for the new Hand
    this._bringInObligationId = null;
    this._pendingDealInterrupt = null; // NEW 8.1 -- safety reset; a fresh hand starts with no paused deal
    this._dealQueue = null;
    this._dealResumeContext = null;
    this.pots = null; // NEW 9.0 -- fresh hand starts with no side-pot tiers
    this.raiseCountThisRound = 0; // NEW 9.0
    this._minRaiseIncrement = 0; // NEW 9.0
    this.provenLosers = new Set(); // NEW 9.6 (§6.10) -- fresh hand starts with nobody excluded from any pot
    this._applyPendingSitIns();
  }

  /**
   * Round reset: hands, discard pile, and community cards collected,
   * shuffled, and everyone's per-round state (including `folded`)
   * cleared. Sets idle = true. Retained for the "abandon a hand
   * mid-play, nobody claimed" case (§4.1) for non-phase-machine profiles.
   * CHANGED 5.0 (§4.1/§6.2/§10.8): blocked entirely for the Draw
   * profile -- its standalone UI button is suppressed as of 5.0, and
   * running it ad hoc server-side would desynchronize `handPhase` from
   * reality (exactly the failure mode the phase machine exists to
   * prevent). CHANGED 6.0 (§5.9/§12): blocked for Hold'em too, same
   * reasoning -- it also now runs on a real, server-enforced phase
   * machine. CHANGED 7.0 (§5.10/§12): blocked for Stud too, same
   * reasoning, now the third profile on a real phase machine. Mid-hand
   * abort/recovery for any of the three is an acknowledged open gap,
   * deferred to a future Game Management interface. Dealer-only.
   */
  reshuffle(requesterId) {
    const dealer = this.getDealer();
    if (!dealer || dealer.id !== requesterId) {
      return { ok: false, error: 'Only the Dealer can reshuffle.' };
    }
    if (this.pendingClaim) return { ok: false, error: 'A claim is pending approval.' };
    if (isPhaseGated(this.profile)) {
      return { ok: false, error: 'Shuffle is not available for this profile -- use New Hand or Same Game instead.' };
    }
    this._performFullReset({ clearFolded: true });
    return { ok: true };
  }

  /**
   * NEW 10.3 (the-cut-spec_v10-3.md Part A §1): the shared core both
   * Function 1 (Terminate Cleanly) and Function 2 (Restore Stacks) build
   * on -- force-ends whatever hand is in progress, from any phase,
   * resetting to the same terminal state a hand normally reaches once
   * its last pot is claimed. Deliberately factored out rather than
   * having Function 2 literally call terminateCleanly() -- each of
   * Functions 1/2 produces exactly ONE table-wide announcement of its
   * own (§0), not two, so the shared reset logic itself stays silent and
   * each public method queues its own single announcement afterward.
   *
   * `_performFullReset()` is verified directly to already leave
   * `this.pot`/`chips`/`totalBuyIn` completely untouched, and to already
   * clear `_pendingDealInterrupt`/`_dealQueue`/`_dealResumeContext` (a
   * paused Baseball-style deal interrupt), so a force-termination is
   * already safe from any mid-deal-pause state with no extra handling
   * needed there. Two things it does NOT already do, added here
   * explicitly: setting `handPhase` (every existing caller sets this
   * separately immediately after; `_performFullReset()` itself never
   * touches it) and clearing `pendingClaim`.
   *
   * Clearing `pendingClaim` here is a real DENIAL of that claim, not a
   * silent discard -- confirmed safe by construction: proposeClaim()
   * only ever stores proposed allocations in `pendingClaim`, never
   * touches `chips`/`this.pot` itself; only resolveClaim() (an actual
   * approval) moves money. Clearing it without ever calling
   * resolveClaim() means, by construction, no money from that claim
   * ever moved -- the full amount is still sitting in `this.pot`.
   *
   * Side pots collapse into the one combined `this.pot`, not preserved
   * tier-by-tier -- already the existing, natural behavior, not new
   * logic: `this.pots` (the plural tier array) is a derived,
   * computed-for-display breakdown, rebuilt fresh by `_recomputePots()`
   * from contribution data, never a separate store of money.
   * `_performFullReset()` sets `this.pots = null` while leaving
   * `this.pot` (the one real running total) completely untouched.
   */
  _forceTerminateCurrentHand() {
    this._performFullReset({ clearFolded: true });
    this._setHandPhase('CycleComplete');
    this.idle = true;
    this.pendingClaim = null;
  }

  /**
   * NEW 10.3 (Part A §1): Function 1, Table-Owner-only. Intended for
   * genuine emergencies only (the game is locked up or otherwise
   * unrecoverable) -- a policy statement for the Table Owner, not
   * something this code can enforce or distinguish (it has no way to
   * tell "the game is broken" from "a claim is legitimately being
   * approved right now"). The Table Owner is trusted not to reach for
   * this while the game is simply working normally.
   *
   * Leaves `this.pot` exactly where it was at the moment of
   * termination, deliberately, for later manual handling (Function 3)
   * or a full stack restore (Function 2) -- see _forceTerminateCurrentHand()'s
   * own comment for why no special-casing is needed to achieve this.
   */
  terminateGameCleanly(requesterId) {
    if (requesterId !== this.creatorId) {
      return { ok: false, error: 'Only the Host can terminate the game.' };
    }
    this._forceTerminateCurrentHand();
    this._queueAnnouncement('The Host has terminated the current hand. The pot remains untouched.', 'table-owner');
    return { ok: true };
  }

  /**
   * NEW 10.3 (Part A §2): Function 2, Table-Owner-only. Independently
   * invokable -- does not require Function 1 first (_forceTerminateCurrentHand()
   * is idempotent to call again if a hand happens to still be in
   * progress). Restores every seated Player's chips/totalBuyIn to what
   * they were at the start of the current CYCLE (not the whole
   * session), via the existing snapshot()/restore() pair in
   * src/player.js -- built in v8.0 for a future undo feature, never
   * called until now. A Player who joined after the snapshot was taken
   * is correctly left untouched by restore(), not zeroed -- that's
   * restore()'s own existing, documented behavior, not new logic
   * written here.
   *
   * CORRECTED 11.2 (Fix 1): this doc comment originally said "start of
   * the CURRENT hand" -- true only for a single-hand Cycle. `_preGameSnapshot`
   * itself is now only recaptured on a genuine new Cycle (see
   * _enterRequestAntes()'s own updated comment), so this restores to
   * the start of the CYCLE regardless of how many re-ante hands
   * happened first -- the only point where the total money in play is
   * unambiguous. Restoring to a mid-Cycle hand's own snapshot and then
   * zeroing the pot would otherwise discard whatever the prior hand(s)
   * in the same Cycle had already carried forward into it.
   *
   * Rejects outright, per Mike's own direct call, if no hand has ever
   * started this session -- there is nothing to restore TO, since
   * current stacks already ARE the "pre-game" state in that case.
   */
  restorePlayerStacks(requesterId) {
    if (requesterId !== this.creatorId) {
      return { ok: false, error: 'Only the Host can restore player stacks.' };
    }
    if (!this._preGameSnapshot) {
      return { ok: false, error: 'No hand has started yet this session -- stacks are already at their starting values, nothing to restore.' };
    }
    this._forceTerminateCurrentHand();
    restorePlayers(this.players, this._preGameSnapshot);
    this.pot = 0;
    this._queueAnnouncement('The Host has restored every player\u2019s stack to the start of the current cycle, and cleared the pot.', 'table-owner');
    return { ok: true };
  }

  /**
   * NEW 10.3 (Part A §3): Function 3, Table-Owner-only -- a staged batch
   * of `{ playerId, direction: 'take'|'give', amount }` allocations
   * against the existing `this.pot` balance, built up freely (add/edit/
   * remove) and previewed live, applied all at once only on an explicit
   * commit. Independent of Functions 1/2 -- not tied to a termination
   * event.
   *
   * Gated to idle-only for BOTH opening and every staging edit, not just
   * commit -- confirmed directly with Mike: these are emergency unlock
   * functions, reserved for the Table Owner, always invoked at an
   * already (fatally) idle table. There is no real scenario where
   * staging needs to start mid-hand, and gating the whole workflow this
   * way (rather than only the final commit) keeps the three functions'
   * idle-only story consistent end to end.
   */
  beginPotDistribution(requesterId) {
    if (requesterId !== this.creatorId) {
      return { ok: false, error: 'Only the Host can distribute the pot.' };
    }
    if (!this.idle) {
      return { ok: false, error: 'Pot Distribution can only be started while idle (no hand in progress).' };
    }
    if (this._pendingAllocationBatch) {
      return { ok: false, error: 'A Pot Distribution batch is already open.' };
    }
    this._pendingAllocationBatch = [];
    return { ok: true };
  }

  /** Shared validation for a single staged entry's shape -- used by both stageAllocation() and updateStagedAllocation(). */
  _validateAllocationEntry(playerId, direction, amount) {
    const target = this.getPlayer(playerId);
    if (!target) return 'Unknown player.';
    if (direction !== 'take' && direction !== 'give') return "Direction must be 'take' or 'give'.";
    if (!Number.isInteger(amount) || amount <= 0) return 'Amount must be a positive whole number.';
    return null;
  }

  /**
   * Adds one new staged allocation. Deliberately performs only input
   * validation here (known player, valid direction, positive whole
   * amount) -- NOT a check against current chips/pot sufficiency. §3.1
   * is explicit that nothing is applied to any real value while staging,
   * and the live preview (see toRedactedState) is exactly how the Table
   * Owner sees whether the batch, as currently built, is sound -- final
   * enforcement happens once, authoritatively, at commit time (§3.2).
   */
  stageAllocation(requesterId, { playerId, direction, amount } = {}) {
    if (requesterId !== this.creatorId) {
      return { ok: false, error: 'Only the Host can distribute the pot.' };
    }
    if (!this.idle) {
      return { ok: false, error: 'Pot Distribution can only be edited while idle (no hand in progress).' };
    }
    if (!this._pendingAllocationBatch) {
      return { ok: false, error: 'No Pot Distribution batch is open -- start one first.' };
    }
    const error = this._validateAllocationEntry(playerId, direction, amount);
    if (error) return { ok: false, error };
    const entry = { id: this._nextAllocationId++, playerId, direction, amount };
    this._pendingAllocationBatch.push(entry);
    return { ok: true, allocationId: entry.id };
  }

  updateStagedAllocation(requesterId, allocationId, { direction, amount } = {}) {
    if (requesterId !== this.creatorId) {
      return { ok: false, error: 'Only the Host can distribute the pot.' };
    }
    if (!this.idle) {
      return { ok: false, error: 'Pot Distribution can only be edited while idle (no hand in progress).' };
    }
    if (!this._pendingAllocationBatch) {
      return { ok: false, error: 'No Pot Distribution batch is open.' };
    }
    const entry = this._pendingAllocationBatch.find((e) => e.id === allocationId);
    if (!entry) return { ok: false, error: 'Unknown staged allocation.' };
    const error = this._validateAllocationEntry(entry.playerId, direction, amount);
    if (error) return { ok: false, error };
    entry.direction = direction;
    entry.amount = amount;
    return { ok: true };
  }

  removeStagedAllocation(requesterId, allocationId) {
    if (requesterId !== this.creatorId) {
      return { ok: false, error: 'Only the Host can distribute the pot.' };
    }
    if (!this.idle) {
      return { ok: false, error: 'Pot Distribution can only be edited while idle (no hand in progress).' };
    }
    if (!this._pendingAllocationBatch) {
      return { ok: false, error: 'No Pot Distribution batch is open.' };
    }
    const before = this._pendingAllocationBatch.length;
    this._pendingAllocationBatch = this._pendingAllocationBatch.filter((e) => e.id !== allocationId);
    if (this._pendingAllocationBatch.length === before) {
      return { ok: false, error: 'Unknown staged allocation.' };
    }
    return { ok: true };
  }

  /** Ends the session without applying anything -- real values were never touched while staging, so this is a pure state clear. */
  discardPotDistributionBatch(requesterId) {
    if (requesterId !== this.creatorId) {
      return { ok: false, error: 'Only the Host can distribute the pot.' };
    }
    if (!this._pendingAllocationBatch) {
      return { ok: false, error: 'No Pot Distribution batch is open.' };
    }
    this._pendingAllocationBatch = null;
    return { ok: true };
  }

  /**
   * Applies the entire staged batch at once, or none of it -- Committed
   * Atomically, per §3.2's own title. Re-validated here, not just at
   * staging time: computed as the NET effect per Player (every staged
   * entry for that Player combined, not just the largest single one --
   * a Player with two separate `take` entries that individually fit
   * their current chips but don't fit TOGETHER must still be caught),
   * confirming no Player's final chips and no final pot balance would go
   * negative. A single validation pass before touching anything achieves
   * the same "never observably negative at any point" guarantee §3.2
   * asks for, without needing to apply-then-unwind on a late failure.
   *
   * Does not touch totalContributedThisHand or totalBuyIn -- a
   * correction tool, not a real betting or buy-in event, same as
   * Functions 1/2.
   */
  commitPotDistribution(requesterId) {
    if (requesterId !== this.creatorId) {
      return { ok: false, error: 'Only the Host can distribute the pot.' };
    }
    if (!this.idle) {
      return { ok: false, error: 'Pot Distribution can only be committed while idle (no hand in progress).' };
    }
    if (!this._pendingAllocationBatch) {
      return { ok: false, error: 'No Pot Distribution batch is open.' };
    }
    if (this._pendingAllocationBatch.length === 0) {
      return { ok: false, error: 'Nothing is staged -- add at least one allocation before committing.' };
    }

    // For each Player represented in the batch, the NET effect of every
    // entry involving them, not just the largest single entry -- a
    // Player with two separate `take` entries that individually fit
    // their current chips but don't fit TOGETHER must still be caught
    // here. `netPot` mirrors the same net-effect logic for the one
    // shared pot balance.
    const netByPlayer = new Map();
    let netPot = this.pot;
    for (const entry of this._pendingAllocationBatch) {
      const target = this.getPlayer(entry.playerId);
      if (!target) return { ok: false, error: 'A staged allocation references a player who is no longer seated.' };
      const signed = entry.direction === 'take' ? entry.amount : -entry.amount;
      netByPlayer.set(entry.playerId, (netByPlayer.get(entry.playerId) || 0) + signed);
      netPot += entry.direction === 'take' ? entry.amount : -entry.amount;
    }
    for (const [playerId, net] of netByPlayer) {
      const target = this.getPlayer(playerId);
      if (target.chips - net < 0) {
        return { ok: false, error: `${target.name}'s staged allocations would leave them with negative chips -- adjust the batch.` };
      }
    }
    if (netPot < 0) {
      return { ok: false, error: 'This batch would leave the pot negative -- adjust the batch.' };
    }

    for (const [playerId, net] of netByPlayer) {
      const target = this.getPlayer(playerId);
      target.chips -= net;
    }
    this.pot = netPot;
    this._pendingAllocationBatch = null;
    // FIXED 11.2 (Fix 4): rewritten from a bare "has distributed the
    // pot" into an actual per-player breakdown -- one entry per player
    // in the committed batch, ordered by seat position (this.players is
    // already in seat order; filtering it by netByPlayer membership
    // preserves that rather than iterating the Map's own insertion
    // order). Sign is the negation of the already-computed `net` value
    // above: a positive `net` means the player was a `take` target (they
    // LOSE that amount from `target.chips -= net`), so the player-facing
    // sign is flipped to read naturally as a gain/loss. A player whose
    // own staged entries happen to net to exactly zero still gets an
    // entry, reading plainly "$0" -- not omitted, and not signed.
    const orderedEntries = this.players
      .filter((p) => netByPlayer.has(p.id))
      .map((p) => {
        const gain = -netByPlayer.get(p.id);
        const amountText = gain === 0 ? '$0' : `${gain > 0 ? '+' : '\u2212'}$${Math.abs(gain)}`;
        return `${p.name}: ${amountText}`;
      });
    this._queueAnnouncement(`The Host has distributed the pot: ${orderedEntries.join('; ')}.`, 'table-owner');
    return { ok: true };
  }

  /**
   * NEW 10.3 (Part A §3.1): the Table Owner's own live preview -- what
   * `this.pot` and every affected Player's `chips` would be if the
   * current batch were committed right now, recomputed fresh on every
   * read from the real current values plus the staged batch's net
   * effect. Shares the exact same net-effect logic commitPotDistribution()
   * validates against, so the preview the Table Owner sees while
   * building the batch is never out of step with what commit would
   * actually do.
   */
  _buildAllocationBatchPreview() {
    const netByPlayer = new Map();
    let previewPot = this.pot;
    for (const entry of this._pendingAllocationBatch) {
      const signed = entry.direction === 'take' ? entry.amount : -entry.amount;
      netByPlayer.set(entry.playerId, (netByPlayer.get(entry.playerId) || 0) + signed);
      previewPot += entry.direction === 'take' ? entry.amount : -entry.amount;
    }
    return {
      allocations: this._pendingAllocationBatch.map((e) => ({ ...e })),
      previewPot,
      previewChipsByPlayerId: Object.fromEntries(
        Array.from(netByPlayer.entries()).map(([playerId, net]) => [playerId, (this.getPlayer(playerId)?.chips ?? 0) - net])
      ),
    };
  }

  /**
   * Self-service: a non-folded player discards any of their own cards,
   * anytime (not turn-gated for non-Draw profiles). Moves cards from
   * hand to the discard pile, and into their own visible `mucked` pile
   * at the table (4.1).
   *
   * For non-Draw profiles, two restriction layers, both scoped to Game
   * Choices that define `maxDiscards` -- consistent with how the 4.0 cap
   * itself was scoped, so Stud/Hold'em/no-choice-active remain
   * unrestricted:
   *  - 4.0: total discarded this hand can't exceed maxDiscards.
   *  - 4.1: once you've discarded at all this hand, you can't discard
   *    again, even with allowance left -- and the window closes for
   *    everyone once the Dealer starts dealing replacements or opens
   *    the hand's second betting round.
   *
   * CHANGED 5.0 (§5.7/§5.8): for the Draw profile, replaced by the phase
   * machine entirely -- only clickable during `DiscardPhase`, blocked
   * once this player has already acted this hand (via Discard OR Stand
   * Pat, now mutually exclusive), minimum 1 card (Stand Pat is the only
   * way to signal "not discarding" as of 5.0). `maxDiscards` enforcement
   * itself is unchanged. Sets `discardPhaseActed`; may advance the phase
   * to `DrawPhase` once every active player has acted.
   */
  discard(requesterId, cardIds) {
    const player = this.getPlayer(requesterId);
    if (!player) return { ok: false, error: 'Player not found.' };
    if (player.folded) return { ok: false, error: "You've folded and can't discard." };
    const isDraw = this.profile === 'draw';
    if (isDraw) {
      if (this.handPhase !== 'DiscardPhase') {
        return { ok: false, error: 'Discard is only available during the Discard phase.' };
      }
      if (player.discardPhaseActed) {
        return { ok: false, error: 'You have already acted this hand (Discard or Stand Pat).' };
      }
    }
    if (!Array.isArray(cardIds) || cardIds.length === 0) {
      return { ok: false, error: 'Choose at least one card to discard.' };
    }
    const uniqueIds = [...new Set(cardIds)];
    const toDiscard = [];
    for (const id of uniqueIds) {
      const card = player.hand.find((c) => c.id === id);
      if (!card) return { ok: false, error: `You don't hold a card with id "${id}".` };
      toDiscard.push(card);
    }

    const maxDiscards = this.gameOptions?.maxDiscards;
    if (typeof maxDiscards === 'number') {
      if (!isDraw && player.discardCountThisHand > 0) {
        return { ok: false, error: "You've already discarded this hand -- once per hand only." };
      }
      if (!isDraw && !this.discardWindowOpen) {
        return { ok: false, error: 'The discard window has closed for this hand.' };
      }
      if (uniqueIds.length > maxDiscards) {
        return { ok: false, error: `You can discard at most ${maxDiscards} cards.` };
      }
    }

    player.hand = player.hand.filter((c) => !uniqueIds.includes(c.id));
    this.discardPile.push(...toDiscard);
    player.discardCountThisHand += uniqueIds.length;
    player.mucked += uniqueIds.length; // seat's visible face-down pile (§10.5)

    if (isDraw) {
      player.discardPhaseActed = true;
      this._maybeAdvanceFromDiscardPhase();
    }
    return { ok: true };
  }

  /**
   * NEW 5.0 (§5.7): a player's affirmative declaration that they're
   * keeping their hand as dealt. Same eligibility as Discard (any
   * non-folded player holding cards, once per hand, not turn-gated) and
   * mutually exclusive with it -- choosing either locks out the other
   * for the rest of the hand, both tracked via the same
   * `discardPhaseActed` flag. Draw profile only; only available during
   * `DiscardPhase`. Visually replaces that seat's muck-pile display with
   * the literal text "Stand Pat" (§10.2) client-side.
   */
  standPat(requesterId) {
    const player = this.getPlayer(requesterId);
    if (!player) return { ok: false, error: 'Player not found.' };
    if (player.folded) return { ok: false, error: "You've folded and can't stand pat." };
    if (this.profile !== 'draw') {
      return { ok: false, error: 'Stand Pat is only available for the Draw profile.' };
    }
    if (this.handPhase !== 'DiscardPhase') {
      return { ok: false, error: 'Stand Pat is only available during the Discard phase.' };
    }
    if (player.discardPhaseActed) {
      return { ok: false, error: 'You have already acted this hand (Discard or Stand Pat).' };
    }
    if ((player.hand?.length || 0) === 0) {
      return { ok: false, error: 'You have no cards to stand pat with.' };
    }
    player.discardPhaseActed = true;
    player.standingPat = true;
    this._maybeAdvanceFromDiscardPhase();
    return { ok: true };
  }

  /**
   * NEW 8.1 (§5.11), GENERALIZED 8.2: a player's stated claim during the
   * `Declare` phase (declareHighLowBoth presets only). Mirrors Stand
   * Pat's eligibility shape closely -- any active (non-folded, per Q4
   * decision also not-yet-declared) player, player-submitted, not
   * turn-gated, no Dealer action involved at all. Pure stored label:
   * never validated against actual hand strength (§12/§5.11) -- the
   * server only checks that `value` is one of the three allowed
   * strings, never what it means.
   *
   * CHANGED 8.2: accepts generic `"a"`/`"b"`/`"both"` now, not literal
   * `"high"`/`"low"`/`"both"` -- 8.1's assumption that every
   * declareHighLowBoth preset was a genuine High/Low split was wrong
   * (found in testing): Chicago's two variants split High Hand vs. a
   * spade, never High vs. Low at all. What `"a"`/`"b"` actually MEAN is
   * entirely preset-defined display text, supplied by the new
   * `declareOptions` Hidden Option (§3) and applied client-side only --
   * this method itself has no opinion on what the two slots represent,
   * consistent with the server never evaluating what a declaration means
   * in the first place.
   *
   * One-shot by design (Mike's explicit call, anticipating a possible
   * future sequential-declaration feature where an early declaration
   * could otherwise be seen and reacted to before others declare): once
   * `player.declaration` is set, it can never be changed for the rest
   * of the hand, not even by the same player re-submitting the same value.
   */
  declare(requesterId, value) {
    const player = this.getPlayer(requesterId);
    if (!player) return { ok: false, error: 'Player not found.' };
    if (player.folded) return { ok: false, error: "You've folded and can't declare." };
    if (player.sittingOut) return { ok: false, error: "You're sitting out and can't declare." };
    // NEW 10.2 (the-cut-spec_v10-2.md §9.3 item 8): declare() had NO
    // dealt-in guard at all -- unlike its sibling standPat(), which
    // already explicitly checks this. A never-dealt Player could submit
    // a phantom declaration. Stud hands only ever grow (no discard
    // mechanic that could legitimately empty one, unlike Draw -- see
    // _wasDealtOriginalHandThisRound()'s own comment), so a plain
    // `hand.length === 0` check is safe here, mirroring standPat()'s
    // exact guard.
    if ((player.hand?.length || 0) === 0) {
      return { ok: false, error: 'You have no cards to declare with.' };
    }
    if (this.profile !== 'stud' || this.handPhase !== 'Declare') {
      return { ok: false, error: 'Declare is only available during the Declare phase.' };
    }
    if (value !== 'a' && value !== 'b' && value !== 'both') {
      return { ok: false, error: 'Declaration must be "a", "b", or "both".' };
    }
    if (player.declaration !== null) {
      return { ok: false, error: 'You have already declared this hand -- declarations cannot be changed.' };
    }
    player.declaration = value;
    this._maybeAdvanceFromDeclare();
    return { ok: true };
  }

  /**
   * "Draw" as of 5.0 (formerly "Deal to Specific Player") -- Dealer
   * deals cards to one specific, non-folded player, e.g. replacing
   * discards, or Baseball's pay-to-buy extra card. Count auto-calculates
   * from the active preset's cardsPerPlayer minus the target's current
   * hand size, but the Dealer can override it. No server-side
   * eligibility check beyond "not folded" -- deliberately a primitive,
   * not a rule (spec §5.2, §12): whether the target "should" get a card
   * right now is a human judgment call.
   * CHANGED 5.0: for the Draw profile, only clickable during
   * `DrawPhase`; on success, transitions to `SecondBetting` -- a single
   * click (in either single-player or All Players mode) ends the phase,
   * per the phase table's "Dealer clicks Draw -> SecondBetting."
   */
  dealToPlayer(requesterId, targetPlayerId, countOverride) {
    const dealer = this.getDealer();
    if (!dealer || dealer.id !== requesterId) {
      return { ok: false, error: 'Only the Dealer can deal to a specific player.' };
    }
    if (this.pendingClaim) return { ok: false, error: 'A claim is pending approval.' };
    const isDraw = this.profile === 'draw';
    if (isDraw && this.handPhase !== 'DrawPhase') {
      return { ok: false, error: 'Draw is only available during the Draw phase.' };
    }
    const target = this.getPlayer(targetPlayerId);
    if (!target) return { ok: false, error: 'Player not found.' };
    // CHANGED 10.2 (the-cut-spec_v10-2.md §9.3 item 5): routed through
    // _wasDealtOriginalHandThisRound() -- NOT _isHandParticipant(),
    // which would incorrectly reject a Player who legitimately discarded
    // their entire hand and is now correctly awaiting a redraw with
    // hand.length === 0 (see that function's own doc comment for why
    // this distinction is necessary here specifically). Previously
    // checked `target.folded` alone, with no sittingOut or dealt-in
    // check at all -- a never-dealt $0-chip Player, or a sitting-out
    // Player, could both be dealt real cards here.
    if (target.sittingOut || !this._wasDealtOriginalHandThisRound(target)) {
      return { ok: false, error: "Can't deal to a folded, sitting-out, or never-dealt-in player." };
    }
    if (target.folded) return { ok: false, error: "Can't deal to a folded player." };

    let count;
    if (Number.isInteger(countOverride) && countOverride > 0) {
      count = countOverride;
    } else {
      const targetSize = this.gameOptions?.cardsPerPlayer;
      count = typeof targetSize === 'number' ? Math.max(0, targetSize - target.hand.length) : 1;
    }
    if (count <= 0) {
      return { ok: false, error: 'Nothing to deal (target already has at least the preset hand size).' };
    }
    if (count > this.deck.length) {
      return { ok: false, error: 'Not enough cards left in the deck.' };
    }

    for (let i = 0; i < count; i++) {
      const card = this.deck.pop();
      const position = target.hand.length;
      card.faceUp = this._defaultFaceUpForPosition(position);
      target.hand.push(card);
    }
    this.discardWindowOpen = false; // still-maintained bookkeeping (4.1); no longer a Draw gate as of 5.0
    target.mucked = 0; // sweep this seat's discard pile visual on redraw (§10.5)
    if (isDraw) this._setHandPhase('SecondBetting');
    return { ok: true };
  }

  /**
   * "Draw" in All Players mode (4.4) -- deals to every eligible (not
   * folded, not sitting out) player who currently needs cards, each
   * receiving their own correct auto-calculated count in one action.
   * Deliberately no override -- a single shared count could over-deal a
   * player who discarded fewer cards than others, which is exactly the
   * failure mode this mode exists to avoid. Kept as a separate method
   * from dealToPlayer() rather than folded into its signature, since the
   * two are mutually exclusive at the protocol level anyway (server.js
   * routes between them).
   * CHANGED 5.0: same DrawPhase gating and SecondBetting transition as
   * dealToPlayer() above -- either mode ends the phase on one click.
   */
  dealToAllPlayers(requesterId) {
    const dealer = this.getDealer();
    if (!dealer || dealer.id !== requesterId) {
      return { ok: false, error: 'Only the Dealer can deal to a specific player.' };
    }
    if (this.pendingClaim) return { ok: false, error: 'A claim is pending approval.' };
    const isDraw = this.profile === 'draw';
    if (isDraw && this.handPhase !== 'DrawPhase') {
      return { ok: false, error: 'Draw is only available during the Draw phase.' };
    }
    const targetSize = this.gameOptions?.cardsPerPlayer;
    if (typeof targetSize !== 'number') {
      return { ok: false, error: 'No Cards Per Player value is set for the active Game Choice.' };
    }
    // CHANGED 10.2 (the-cut-spec_v10-2.md §9.3 item 4, live-confirmed by
    // Mike prior to this audit): routed through
    // _wasDealtOriginalHandThisRound() (folded/sittingOut checked
    // separately, since neither is part of that function's own question)
    // -- previously `!p.folded && !p.sittingOut` alone counted a
    // never-dealt $0-chip Player as needing cards, and they received
    // real cards from the shared deck. NOT _isHandParticipant() here --
    // see _wasDealtOriginalHandThisRound()'s own doc comment for why a
    // bare dealt-in check would wrongly exclude a Player who legitimately
    // discarded their entire hand.
    const eligible = this.players.filter((p) => !p.sittingOut && this._wasDealtOriginalHandThisRound(p) && !p.folded);
    const needy = eligible.filter((p) => p.hand.length < targetSize);
    if (needy.length === 0) {
      // For non-Draw profiles this is genuinely nothing to do -- reject
      // as before. For Draw, this is a real, valid scenario (e.g. every
      // active player Stood Pat) -- DrawPhase's only exit is "Dealer
      // clicks Draw," which must still work even when it deals zero
      // cards, so this succeeds as a no-op and still advances the phase.
      if (!isDraw) return { ok: false, error: 'No players currently need cards.' };
      this._setHandPhase('SecondBetting');
      return { ok: true };
    }
    const totalNeeded = needy.reduce((sum, p) => sum + (targetSize - p.hand.length), 0);
    if (totalNeeded > this.deck.length) {
      return { ok: false, error: 'Not enough cards left in the deck.' };
    }

    for (const player of needy) {
      const count = targetSize - player.hand.length;
      for (let i = 0; i < count; i++) {
        const card = this.deck.pop();
        const position = player.hand.length;
        card.faceUp = this._defaultFaceUpForPosition(position);
        player.hand.push(card);
      }
      player.mucked = 0;
    }
    this.discardWindowOpen = false;
    if (isDraw) this._setHandPhase('SecondBetting');
    return { ok: true };
  }

  /**
   * NEW 4.0: Dealer deals N cards face-up into the shared communityCards
   * area (not any individual hand). Count is preset-driven per street
   * (e.g. Hold'em flop=3/turn=1/river=1), inferred from how many
   * community cards already exist; Dealer can override. Always face-up
   * -- no face-down option exists for this primitive.
   * CHANGED 6.0 (§5.9): for the Hold'em profile, phase-gated to
   * `Flop`/`Turn`/`River` -- the three streets renamed "The Flop"/
   * "The Turn"/"The River" client-side, same underlying primitive and
   * count auto-calc as always. On success, transitions to the matching
   * `XBetting` phase.
   */
  dealCommunity(requesterId, countOverride) {
    const dealer = this.getDealer();
    if (!dealer || dealer.id !== requesterId) {
      return { ok: false, error: 'Only the Dealer can deal community cards.' };
    }
    if (this.pendingClaim) return { ok: false, error: 'A claim is pending approval.' };
    const isHoldem = this.profile === 'holdem';
    const holdemDealPhases = ['Flop', 'Turn', 'River'];
    if (isHoldem && !holdemDealPhases.includes(this.handPhase)) {
      return { ok: false, error: 'Community cards are not available right now.' };
    }

    let count;
    if (Number.isInteger(countOverride) && countOverride > 0) {
      count = countOverride;
    } else {
      const pattern = this.gameOptions?.communityPattern;
      if (Array.isArray(pattern) && pattern.length > 0) {
        let cumulative = 0;
        let streetSize = null;
        for (const streetCount of pattern) {
          if (this.communityCards.length === cumulative) {
            streetSize = streetCount;
            break;
          }
          cumulative += streetCount;
        }
        count = streetSize === null ? 1 : streetSize; // all defined streets already dealt -> fall back to 1
      } else {
        count = 1;
      }
    }
    if (count <= 0) return { ok: false, error: 'Count must be a positive whole number.' };
    if (count > this.deck.length) return { ok: false, error: 'Not enough cards left in the deck.' };

    for (let i = 0; i < count; i++) {
      const card = this.deck.pop();
      card.faceUp = true;
      this.communityCards.push(card);
    }

    if (isHoldem) {
      const nextPhase = { Flop: 'FlopBetting', Turn: 'TurnBetting', River: 'RiverBetting' }[this.handPhase];
      this._setHandPhase(nextPhase);
    }
    return { ok: true };
  }

  /**
   * Dealer-only, manual, standalone. Moves the top card of the deck
   * directly into the discard pile, unseen by anyone. Not automatic, not
   * enforced -- general-purpose, available regardless of which Game
   * Choice (or none) is active. Visibility of the Burn control itself is
   * gated client-side by the active preset's burnAvailable flag (v4.2
   * §5.5) -- this method stays unrestricted server-side, consistent with
   * every other profile/preset-gated primitive in this app.
   */
  burn(requesterId) {
    const dealer = this.getDealer();
    if (!dealer || dealer.id !== requesterId) {
      return { ok: false, error: 'Only the Dealer can burn a card.' };
    }
    if (this.deck.length === 0) return { ok: false, error: 'No cards left in the deck to burn.' };
    this.discardPile.push(this.deck.pop());
    this.burnedThisHand += 1; // NEW 4.2 -- shared burn pile visual count
    return { ok: true };
  }

  /**
   * NEW 4.3 (§5.6/§12): Dealer-only, purely cosmetic -- reveals what
   * would have come next from the hand that just ended, for curiosity.
   * Zero effect on the pot or any outcome, which is already settled by
   * the time this is usable. No count input: each call reveals exactly
   * one more card, face-up, appended to rabbitHuntCards. Only available
   * in the narrow window between an approved claim and the next
   * Reshuffle/Deal (gameTable.rabbitHuntAvailable) -- narrower than the
   * general `idle` window, since it depends on the exact leftover deck
   * from that specific hand still being intact.
   */
  rabbitHunt(requesterId) {
    const dealer = this.getDealer();
    if (!dealer || dealer.id !== requesterId) {
      return { ok: false, error: 'Only the Dealer can Rabbit Hunt.' };
    }
    if (!this.rabbitHuntAvailable) {
      return { ok: false, error: 'Rabbit Hunt is only available right after a claim, before the next Reshuffle or Deal.' };
    }
    if (this.deck.length === 0) return { ok: false, error: 'No cards left in the deck.' };
    const card = this.deck.pop();
    card.faceUp = true;
    this.rabbitHuntCards.push(card);
    return { ok: true };
  }

  /**
   * NEW 6.0: extracted from _autoApplyAnte so the same deterministic
   * search can also answer "who is currently Big Blind" for Hold'em's
   * PreFlopBetting anchor (§6.6) -- there's no persisted "this player is
   * Big Blind" flag (oweAnte is transient, cleared the moment it's
   * paid), so the anchor logic recomputes the same two seats fresh from
   * turnOrder + dealerId + sitting-out status, exactly as they were
   * originally assigned at RequestAntes. Safe to recompute: nothing
   * about the active roster changes between RequestAntes and
   * PreFlopBetting within a single Hand.
   */
  _computeBlindSeats(referenceDealerId) {
    const idx = this.turnOrder.indexOf(referenceDealerId);
    if (idx === -1) return [];
    const blindSeats = [];
    for (let step = 1; step <= this.turnOrder.length && blindSeats.length < 2; step++) {
      const candidate = this.getPlayer(this.turnOrder[(idx + step) % this.turnOrder.length]);
      // CHANGED 9.6: also excludes chips === 0 -- a $0-chip player is
      // never assigned a blind, computed fresh here, never a persisted flag.
      // FIXED 12.5 (Part A): also excludes folded -- matches
      // _dealableActivePlayers()'s own filter exactly, confirmed by
      // direct comparison. A folded player was being assigned a real
      // blind obligation for a hand they were never going to be dealt
      // into, with no legal way to ever post it.
      if (candidate && !candidate.folded && !candidate.sittingOut && candidate.chips > 0) blindSeats.push(candidate);
    }
    return blindSeats;
  }

  /**
   * NEW 4.3: shared ante/blind auto-application logic, used by Start
   * Game/New Hand's shared `_enterRequestAntes` entry point.
   * blind-type: small/big blind to the two active seats after
   * `referenceDealerId`, via `_computeBlindSeats`. flat-type: every
   * active (non-sitting-out) player gets gameOptions.anteAmount.
   * manual-type (4.4): no-op -- the software never evaluates a manual
   * ante (e.g. a Stud bring-in that depends on visible up-cards); the
   * Dealer always sets it by hand via setAnteBlind. No-op either way if
   * no Game Choice is active or the relevant amount isn't a number.
   * CHANGED 6.0: no code change here at all -- Hold'em's `anteType:
   * 'blind'` reuses this exact mechanism unchanged, confirmed by the
   * spec as sufficient (§6.1).
   */
  _autoApplyAnte(referenceDealerId) {
    if (this.gameOptions?.anteType === 'blind') {
      const blindSeats = this._computeBlindSeats(referenceDealerId);
      const { smallBlind, bigBlind } = this.gameOptions;
      if (blindSeats[0] && typeof smallBlind === 'number') blindSeats[0].oweAnte = smallBlind;
      if (blindSeats[1] && typeof bigBlind === 'number') blindSeats[1].oweAnte = bigBlind;
    } else if (this.gameOptions?.anteType === 'flat') {
      const amount = this.gameOptions.anteAmount;
      if (typeof amount === 'number') {
        for (const player of this.players) {
          // CHANGED 9.6: also excludes chips === 0 -- computed fresh, never a persisted flag.
          // FIXED 12.5 (Part A): also excludes folded -- matches
          // _dealableActivePlayers()'s own filter exactly (confirmed by
          // direct comparison, not assumed). A folded player was left
          // with a real, nonzero oweAnte for a re-ante New Hand they
          // were correctly excluded from being dealt into at all --
          // stuck with an obligation and no legal way to post it, since
          // _maybeAdvanceFromRequestAntes() (correctly) never waited on
          // them either.
          if (!player.folded && !player.sittingOut && player.chips > 0) player.oweAnte = amount;
        }
      }
    }
    // anteType === 'manual' (or no Game Choice active): intentionally no-op.
  }

  /**
   * Moves the Dealer role to the next active seat to the Dealer's left
   * (skipping sitting-out seats). CHANGED 5.0 (§6.3): no longer accepts
   * a specific target player at all -- pure "next active seat," full
   * stop. If the group needs it to land on someone out of normal
   * rotation, click repeatedly. This is a universal change (every
   * profile), unrelated to the Draw-specific phase machine -- just a UI/
   * protocol simplification that removed a rarely-needed option.
   * Availability: for Draw, only `PreGame`/`CycleComplete`
   * (`handPhase`-gated, does not itself change `handPhase`); for every
   * other profile, the old `idle === true` gate, unchanged from 4.4.
   */
  /**
   * NEW 9.4 (§9): the core "hand the Dealer role to the next eligible
   * player" logic, factored out of passTheBuck() so it can also be
   * reused for the automatic $0-chips-Dealer case below -- an internal,
   * system-triggered transfer skips passTheBuck()'s own
   * authorization/phase-gating checks (not relevant to an automatic
   * transfer), but finds the next eligible seat exactly the same way.
   */
  _reassignDealerToNextEligible(currentDealer) {
    let nextDealer = null;
    const dealerIdx = this.turnOrder.indexOf(currentDealer.id);
    for (let step = 1; step <= this.turnOrder.length; step++) {
      const candidate = this.getPlayer(this.turnOrder[(dealerIdx + step) % this.turnOrder.length]);
      // NEW 11.0 (Part E, per §8's "multiple simultaneous disconnects
      // generalize correctly" principle): a currently-disconnected Player
      // is just as ineligible to receive the Dealer role as a sitting-out
      // one -- added when this function gained a second, disconnect-
      // triggered caller (expireDisconnectGrace()) alongside passTheBuck().
      // Doesn't affect passTheBuck() itself: a connected Player is always
      // `connected === true`, so this is a no-op for that caller.
      if (candidate && !candidate.sittingOut && candidate.connected !== false && candidate.id !== currentDealer.id) {
        nextDealer = candidate;
        break;
      }
    }
    if (!nextDealer) return null;
    currentDealer.isDealer = false;
    nextDealer.isDealer = true;
    return nextDealer;
  }

  passTheBuck(requesterId) {
    const dealer = this.getDealer();
    if (!dealer || dealer.id !== requesterId) {
      return { ok: false, error: 'Only the Dealer can pass the buck.' };
    }
    if (this.pendingClaim) return { ok: false, error: 'A claim is pending approval.' };
    if (isPhaseGated(this.profile)) {
      if (this.handPhase !== 'PreGame' && this.handPhase !== 'CycleComplete') {
        return { ok: false, error: 'Pass the Buck is only available between hands.' };
      }
    } else if (!this.idle) {
      return { ok: false, error: 'Pass the Buck is only available while idle (no hand in progress).' };
    }
    if (this.turnOrder.length < 2) {
      return { ok: false, error: 'Need at least 2 players.' };
    }

    const nextDealer = this._reassignDealerToNextEligible(dealer);
    if (!nextDealer) return { ok: false, error: 'No eligible player to hand the Dealer button to.' };
    return { ok: true };
  }

  /**
   * "Starting a hand" -- triggered by either the Options popup's "Start"
   * button or the Same Game button (§10.4); same underlying action
   * either way. Does not move the Dealer role. Players still click Post
   * Ante/Blind themselves to pay.
   * CHANGED 5.0 (§6.2): for the Draw profile, this is now simply a
   * TRIGGER into the `PreGame`/`CycleComplete` -> `RequestAntes`
   * transition -- the reset/ante-request logic lives exactly once, in
   * `_enterRequestAntes()` (owned by the phase itself, not duplicated
   * here), and Deal is no longer bundled into this click at all; it's
   * always a separate, later, `OpeningDeal`-phase action. CHANGED 6.0
   * (§5.9): Hold'em joins Draw on this same phase-machine path --
   * `startGame` is Hold'em's *only* entry point into `RequestAntes`
   * (there's no New-Hand-within-Cycle loop for Hold'em, so `clearFolded`
   * is always `true` here regardless of profile). For every other
   * profile (Stud, or no profile at all), unchanged from 4.4: one click
   * does the full reset AND applies the ante, since those profiles have
   * no phase-gated Deal to defer to.
   */
  startGame(requesterId) {
    const dealer = this.getDealer();
    if (!dealer || dealer.id !== requesterId) {
      return { ok: false, error: 'Only the Dealer can start the game.' };
    }
    if (this.pendingClaim) return { ok: false, error: 'A claim is pending approval.' };
    if (!this.gameChoiceId) {
      return { ok: false, error: 'Select a Game Choice first.' };
    }
    // NEW 11.0 (Part I audit finding, see _anyoneDisconnected()'s own
    // comment): don't deal a fresh hand while anyone is still mid-grace-
    // period -- wait for them, same "table freezes" principle Part B
    // already applies to an in-progress hand.
    if (this._anyoneDisconnected()) {
      return { ok: false, error: 'A player is disconnected -- wait for them to reconnect, or for their grace period to expire, before starting a new hand.' };
    }
    if (isPhaseGated(this.profile)) {
      if (this.handPhase !== 'PreGame' && this.handPhase !== 'CycleComplete') {
        return { ok: false, error: 'You can only start while idle (no hand in progress).' };
      }
      this._enterRequestAntes(true); // clearFolded: true -- a genuine new Cycle
      return { ok: true };
    }
    if (!this.idle) {
      return { ok: false, error: 'You can only start while idle (no hand in progress).' };
    }
    this._performFullReset({ clearFolded: true });
    // NOTE 11.0: _positionAnchorId() is a no-op passthrough to dealer.id
    // here -- the Part E split only ever gets set for phase-gated
    // profiles (see expireDisconnectGrace()); kept for consistency with
    // every other _autoApplyAnte()/_computeBlindSeats() call site.
    this._autoApplyAnte(this._positionAnchorId());
    return { ok: true };
  }

  /**
   * NEW 5.0 (§5.8), replaces the retired "Redeal" primitive (4.4/4.5).
   * Draw and (as of 7.0) Stud only -- Hold'em has no New-Hand-within-Cycle
   * loop at all (§5.9). A genuinely SMALLER action than the old Redeal:
   * where Redeal bundled reshuffle + re-ante + deal into one click, New
   * Hand is simply a trigger into `RequestAntes` -- it carries no reset
   * logic of its own (that lives exactly once, in `_enterRequestAntes()`,
   * shared with Start Game/Same Game). Deal is always a separate, later,
   * ante-gated step. The one thing that varies by entry point is fold
   * status, and per spec that decision belongs to `RequestAntes` itself
   * based on how it was entered -- here, always preserved (the same
   * Cycle continuing), never cleared.
   *
   * Draw: available in exactly two moments, both requiring `reAnteable`:
   *  - From `FirstBetting`, once the round has closed with nobody having
   *    ever opened (`currentBetToCall` stayed 0) -- real Jacks-or-Better
   *    rules kill the hand immediately here, no draw phase at all.
   *  - From `Showdown`, once nobody has claimed the pot.
   * Stud (NEW 7.0, §5.10): only the `Showdown`/"nobody claims" moment
   * applies -- Stud's Dealer-selected opening bettor always faces a live
   * Bring-In on the first street (§6.8), so there's no "nobody opened"
   * analog the way Draw's `requiresOpeners` presets need. Same
   * `reAnteable` gate either way (e.g. Black Mariah).
   */
  newHand(requesterId) {
    const dealer = this.getDealer();
    if (!dealer || dealer.id !== requesterId) {
      return { ok: false, error: 'Only the Dealer can start a new hand.' };
    }
    if (this.pendingClaim) return { ok: false, error: 'A claim is pending approval.' };
    // NEW 11.0 (Part I audit finding) -- see startGame()'s identical
    // guard and _anyoneDisconnected()'s own comment for the reasoning.
    if (this._anyoneDisconnected()) {
      return { ok: false, error: 'A player is disconnected -- wait for them to reconnect, or for their grace period to expire, before starting a new hand.' };
    }
    // CHANGED 8.0 (§2): reads the capability flag instead of naming
    // Draw and Stud explicitly -- a future profile that sets
    // usesReAnteableLoop: true in its own table picks this up
    // automatically, nothing to remember to add here.
    if (!getProfileTable(this.profile)?.capabilities?.usesReAnteableLoop) {
      return { ok: false, error: 'New Hand is only available for profiles that support the New-Hand-within-Cycle loop.' };
    }
    // CHANGED 8.1 (§6.9): Kill Hand reuses this exact action/mechanism,
    // so a hasKillCard preset needs to reach this gate even when NOT
    // reAnteable. No current preset does both independently -- Black
    // Mariah happens to set both flags -- but the two triggers are
    // logically distinct (§6.9's Showdown availability is gated on
    // hasKillCard alone, not reAnteable), and a future hasKillCard-only
    // preset should work correctly without this method needing another pass.
    if (!this.reAnteable && !this.hasKillCard) {
      return { ok: false, error: 'New Hand is only available for re-anteable or Kill Hand-eligible Game Choices.' };
    }
    // BUG FIX (found in a post-5.0 regression audit, not one of 5.1's
    // five originally-reported issues): this was missing a guard that a
    // betting round had actually happened and closed. Without
    // `bettingRoundsThisHand >= 1`, the moment Deal transitioned into a
    // fresh FirstBetting, `bettingOpen` was still false (Dealer hadn't
    // clicked Open Betting Round yet) and `currentBetToCall` was still 0
    // (freshly reset) -- so this trigger read as satisfied immediately,
    // before the Dealer had any chance to open the first round at all.
    // Draw-only -- Stud's own phase names never include 'FirstBetting',
    // so this is naturally false for Stud without an extra profile check.
    // CHANGED 8.1: explicit `this.reAnteable` conjunct added -- previously
    // implied by the early return above always requiring it; no longer
    // safe to assume now that the early return also admits hasKillCard-only
    // presets through.
    const stuckFirstBetting =
      this.reAnteable &&
      this.profile === 'draw' &&
      this.handPhase === 'FirstBetting' &&
      this.bettingRoundsThisHand >= 1 &&
      !this.bettingOpen &&
      this.currentBetToCall === 0;
    // CHANGED 8.1: explicit `this.reAnteable` conjunct added, same reasoning as above.
    const stuckShowdown = this.reAnteable && this.handPhase === 'Showdown';
    // NEW 8.1 (§6.9), CHANGED 8.3 per Mike's preference: Kill Hand's own
    // trigger, independent of reAnteable, available anywhere in the
    // mid-hand window a profile table defines via `isWithinKillHandWindow`
    // (Stud-only; see stud.js). Optional chaining means this is safely
    // `undefined` (falsy) for any profile table that doesn't define the
    // function -- Draw and Hold'em never reach a truthy result here.
    // REMOVED 8.3: this used to also fire at Showdown (`this.handPhase
    // === 'Showdown'`), on the original 8.1 reasoning that Kill Hand
    // should be reachable "any time during the hand." Mike's 8.3 call:
    // a "nobody qualifies" situation at Showdown for a `reAnteable` +
    // `hasKillCard` preset (e.g. Black Mariah) is a genuine, ordinary
    // New-Hand-within-Cycle situation, not a kill-card situation --
    // Showdown's New Hand is now ALWAYS the plain button (via
    // `stuckShowdown` above, unchanged), never the restyled Kill Hand
    // variant, regardless of `hasKillCard`. If a `hasKillCard` preset
    // were ever NOT `reAnteable` (no current preset does this), New Hand
    // would now be completely unavailable at Showdown for it -- a real,
    // intentional consequence of this change, not an oversight.
    const killHandTrigger = this.hasKillCard && !!getProfileTable(this.profile)?.isWithinKillHandWindow?.(this);
    if (!stuckFirstBetting && !stuckShowdown && !killHandTrigger) {
      return { ok: false, error: 'New Hand is not available right now.' };
    }
    this.killHandConfirmPending = false; // NEW 8.2 -- clears the table-wide notice the instant the hand actually gets killed, alongside the normal confirm path
    this._enterRequestAntes(false); // clearFolded: false -- same Cycle continues, folded players stay out
    return { ok: true };
  }

  /**
   * NEW 8.2 (§6.9): the Dealer just opened the Kill Hand confirmation
   * dialog on their own screen -- signals every OTHER player at the
   * table with a non-blocking, read-only notice, since a `hasKillCard`
   * preset's Kill Hand is destructive enough to be worth flagging before
   * it's confirmed, not just after. Dealer-only, hasKillCard presets
   * only. Doesn't itself validate the same trigger conditions
   * `newHand()` checks -- this is purely a UI-coordination signal, not
   * the action that actually kills the hand (that's still `newHand`,
   * unchanged, fired only on actual confirmation).
   */
  killHandStartConfirm(requesterId) {
    const dealer = this.getDealer();
    if (!dealer || dealer.id !== requesterId) {
      return { ok: false, error: 'Only the Dealer can do this.' };
    }
    if (!this.hasKillCard) {
      return { ok: false, error: 'Kill Hand is not available for this Game Choice.' };
    }
    this.killHandConfirmPending = true;
    return { ok: true };
  }

  /**
   * NEW 8.2 (§6.9): the Dealer clicked Cancel on the Kill Hand
   * confirmation dialog without confirming -- clears the table-wide
   * notice immediately, "with no other indication anything was
   * attempted" (spec's own wording). `newHand()` also clears this same
   * flag on the CONFIRM path, so between the two, the notice always
   * clears the instant the dialog closes either way.
   */
  killHandCancelConfirm(requesterId) {
    const dealer = this.getDealer();
    if (!dealer || dealer.id !== requesterId) {
      return { ok: false, error: 'Only the Dealer can do this.' };
    }
    this.killHandConfirmPending = false;
    return { ok: true };
  }

  /**
   * Dealer selects a Game Choice preset, resolving
   * gameChoiceId/profile/gameOptions from its defaults, plus the four
   * top-level flags reAnteable/advanceTurnRequired/burnAvailable/
   * requiresOpeners (NEW 4.5) -- fixed per preset, not Dealer-editable
   * via Options, unlike everything in gameOptions. Falls back to
   * DEFAULT_PRESET_FLAGS for any preset that doesn't specify them
   * (currently every Stud/Hold'em preset). Gated by `gameTable.idle === true`
   * (spec §11, since 4.1).
   */
  setGameChoice(requesterId, gameChoiceId) {
    const dealer = this.getDealer();
    if (!dealer || dealer.id !== requesterId) {
      return { ok: false, error: 'Only the Dealer can set the Game Choice.' };
    }
    if (this.pendingClaim) return { ok: false, error: 'A claim is pending approval.' };
    if (!this.idle) {
      return { ok: false, error: 'You can only select a Game Choice while idle (no hand in progress).' };
    }
    const preset = GAME_CHOICES.find((g) => g.id === gameChoiceId);
    if (!preset) return { ok: false, error: 'Unknown Game Choice.' };
    this.gameChoiceId = preset.id;
    this.profile = preset.profile;
    // CHANGED 8.1 (§3, Game Choice preset schema restructure): presets
    // now author their option values in two separate buckets --
    // `hiddenOptions` (baked in, never Dealer-editable) and
    // `dealerOptions` (Dealer-editable, sticky per session) -- purely an
    // authoring/UI-organization distinction (per Mike's call: no server
    // enforcement needed, since the UI simply never exposes a control
    // for a hiddenOptions key). Runtime storage is UNCHANGED from every
    // prior version: still one flat `gameOptions` object, merged here
    // once at selection time, exactly as `setGameOption` already expects
    // to read/write it.
    // NEW 12.5 (Part C, documentation only -- no behavior change):
    // this line unconditionally resets gameOptions to the preset's
    // stored defaults EVEN if gameChoiceId is already the same preset
    // that's already active -- there is deliberately no "already the
    // active game, leave gameOptions alone" check. Confirmed real,
    // asked-about-live difference from `startGame()` (Same Game),
    // which never calls setGameChoice at all and so never touches
    // gameOptions -- whatever was configured for the hand just played
    // carries over exactly as-is. Selecting the identical game via
    // Select, by contrast, discards any Dealer customization from the
    // hand just played. As far as this session can tell, intentional
    // rather than a bug -- documented here since it was only ever
    // explained in chat before now.
    this.gameOptions = { ...preset.hiddenOptions, ...preset.dealerOptions };
    this.reAnteable = typeof preset.reAnteable === 'boolean' ? preset.reAnteable : DEFAULT_PRESET_FLAGS.reAnteable;
    this.advanceTurnRequired =
      typeof preset.advanceTurnRequired === 'boolean' ? preset.advanceTurnRequired : DEFAULT_PRESET_FLAGS.advanceTurnRequired;
    this.burnAvailable =
      typeof preset.burnAvailable === 'boolean' ? preset.burnAvailable : DEFAULT_PRESET_FLAGS.burnAvailable;
    this.requiresOpeners =
      typeof preset.requiresOpeners === 'boolean' ? preset.requiresOpeners : DEFAULT_PRESET_FLAGS.requiresOpeners;
    this.finalStreet =
      preset.finalStreet === 'D' || preset.finalStreet === 'E' ? preset.finalStreet : DEFAULT_PRESET_FLAGS.finalStreet;
    // NEW 8.1 (§3, §6.9): same top-level-sibling placement as reAnteable etc.
    this.hasKillCard = preset.hasKillCard === true;
    this.killCard = typeof preset.killCard === 'string' ? preset.killCard : null;
    this.openingBettorId = null; // NEW 7.0 -- fresh gameTable-level reset whenever the Game Choice changes
    this._bringInObligationId = null;
    this._pendingDealInterrupt = null; // NEW 8.1 -- safety reset, mirrors the Bring-In reset above
    this._dealQueue = null;
    this._dealResumeContext = null;
    this.pots = null; // NEW 9.0 -- safety reset, mirrors the above
    this.raiseCountThisRound = 0;
    this._minRaiseIncrement = 0;
    this.provenLosers = new Set(); // NEW 9.6 -- safety reset, mirrors the above
    return { ok: true };
  }

  /**
   * Dealer overrides one resolved option value without changing the
   * underlying Game Choice/profile. Lightly type-checked against the
   * existing value's type. CHANGED 4.3 (§10.5): now gated by
   * `gameTable.idle === true`, matching setGameChoice's existing gate -- the
   * spec's Options-popup table describes the Dealer's view as fully
   * "read-only, no edits accepted" once a hand is in progress, which
   * reads as a real restriction, not just a UI convenience; enforcing it
   * server-side keeps a mid-hand game from being reconfigured out from
   * under the table.
   */
  setGameOption(requesterId, key, value) {
    const dealer = this.getDealer();
    if (!dealer || dealer.id !== requesterId) {
      return { ok: false, error: 'Only the Dealer can override a game option.' };
    }
    if (!this.idle) {
      return { ok: false, error: 'Options can only be edited while idle (no hand in progress).' };
    }
    if (!this.gameOptions || !Object.prototype.hasOwnProperty.call(this.gameOptions, key)) {
      return { ok: false, error: 'Unknown game option for the active Game Choice.' };
    }
    // NEW 9.1 (§3, §6.10): raiseCap is deliberately a MIXED-type field --
    // an integer under Pot-Limit/Fixed-Limit, or the literal string
    // "no-cap" under No-Limit -- so it can't use the generic "coerce to
    // whatever type the existing value already is" logic below (that
    // would reject "no-cap" as soon as the stored value happened to be
    // a number, or vice versa). Handled as its own case instead.
    if (key === 'raiseCap') {
      if (value === 'no-cap') {
        this.gameOptions.raiseCap = 'no-cap';
      } else {
        const n = Number(value);
        if (!Number.isInteger(n) || n < 1) return { ok: false, error: 'raiseCap must be a positive whole number, or "no-cap".' };
        this.gameOptions.raiseCap = n;
      }
      return { ok: true };
    }
    const existing = this.gameOptions[key];
    if (typeof existing === 'number') {
      const n = Number(value);
      if (!Number.isFinite(n)) return { ok: false, error: 'That option expects a number.' };
      this.gameOptions[key] = n;
    } else if (typeof existing === 'string') {
      this.gameOptions[key] = String(value);
    } else if (Array.isArray(existing)) {
      if (!Array.isArray(value)) return { ok: false, error: 'That option expects a list of values.' };
      this.gameOptions[key] = value;
    } else {
      this.gameOptions[key] = value;
    }
    // NEW 9.1 (§3): raiseCap is DEPENDENT on bettingStructure -- "No Cap"/
    // disabled under No-Limit, defaults to 3/active under Pot-Limit or
    // Fixed-Limit. Auto-resets to the new structure's default every time
    // bettingStructure changes, guaranteed server-side (not left to the
    // client to remember a second call) so a stale value from a previous
    // selection can never linger.
    if (key === 'bettingStructure' && Object.prototype.hasOwnProperty.call(this.gameOptions, 'raiseCap')) {
      this.gameOptions.raiseCap = this.gameOptions.bettingStructure === 'no-limit' ? 'no-cap' : 3;
    }
    return { ok: true };
  }

  _nextTurnPlayerId() {
    if (this.turnOrder.length === 0) return null;
    const idx = this.turnOrder.indexOf(this.currentTurnPlayerId);
    for (let step = 1; step <= this.turnOrder.length; step++) {
      const candidateId = this.turnOrder[(idx + step) % this.turnOrder.length];
      const candidate = this.getPlayer(candidateId);
      if (!candidate) continue;
      // CHANGED 10.1 (the-cut-spec_v10-1.md §8.2/§8.3 defect 1): routed
      // through the shared _canAct() -- previously reimplemented this
      // exact combination inline (sittingOut/folded/allIn/bettingCapped),
      // missing the dealt-in check _canAct() now supplies, which let a
      // never-dealt $0-chip Player be handed a turn.
      if (this.bettingOpen && !this._canAct(candidate)) continue;
      if (!this.bettingOpen && candidate.sittingOut) continue;
      return candidateId;
    }
    return this.currentTurnPlayerId;
  }

  advanceTurn(requesterId) {
    const dealer = this.getDealer();
    if (!dealer || dealer.id !== requesterId) {
      return { ok: false, error: 'Only the Dealer can advance the turn.' };
    }
    if (this.turnOrder.length === 0) {
      return { ok: false, error: 'No players in the table.' };
    }
    this.currentTurnPlayerId = this._nextTurnPlayerId();
    return { ok: true };
  }

  // ---------------------------------------------------------------
  // Betting (unchanged from 3.3)
  // ---------------------------------------------------------------

  /**
   * CHANGED 6.0 (§6.6): the seat betting starts on -- the "anchor" --
   * is normally the Dealer (Draw's only case, and Hold'em's three
   * post-flop streets all identically), but Hold'em's `PreFlopBetting`
   * specifically starts left of the Big Blind ("Under the Gun") instead.
   * This needs its own explicit anchor rather than reusing Draw's
   * hardcoded "left of Dealer" assumption as-is, since the two rules
   * only coincide post-flop -- confirmed against standard Hold'em
   * convention, not just transcribed from the original draft doc, which
   * had this inconsistent for `FlopBetting` before review caught it.
   * There's no persisted "this player is Big Blind" flag to read (oweAnte
   * is transient, cleared the moment it's paid) -- `_computeBlindSeats`
   * deterministically recomputes the same two seats fresh each time,
   * safe because nothing about the active roster changes between
   * RequestAntes and PreFlopBetting within a single Hand.
   * CHANGED 7.0 (§5.10/§6.8): Stud doesn't compute its opening actor at
   * all -- who's showing the strongest/weakest hand is a card-value
   * judgment the server never evaluates (§12), so the Dealer selects it
   * manually every street via `setOpeningBettor`. `openBetting` is
   * rejected for a Stud gameTable until that selection exists. Once present,
   * the selected player themselves is seated to act first -- unlike
   * Draw/Hold'em's anchor-then-+1 convention (anchor is the seat BEFORE
   * the first actor), Stud's selection IS the first actor, since they
   * carry the forced Bring-In obligation on `StreetABetting` specifically
   * (§6.8) and must be the one immediately on the clock.
   */
  openBetting(requesterId) {
    const dealer = this.getDealer();
    if (!dealer || dealer.id !== requesterId) {
      return { ok: false, error: 'Only the Dealer can open a betting round.' };
    }
    if (this.pendingClaim) return { ok: false, error: 'A claim is pending approval.' };
    const isDraw = this.profile === 'draw';
    const isHoldem = this.profile === 'holdem';
    const isStud = this.profile === 'stud';
    const drawBettingPhases = ['FirstBetting', 'SecondBetting'];
    const holdemBettingPhases = ['PreFlopBetting', 'FlopBetting', 'TurnBetting', 'RiverBetting'];
    const studBettingPhases = ['StreetABetting', 'StreetBBetting', 'StreetCBetting', 'StreetDBetting', 'StreetEBetting'];
    if (isDraw && !drawBettingPhases.includes(this.handPhase)) {
      return { ok: false, error: 'Betting is not available right now.' };
    }
    if (isHoldem && !holdemBettingPhases.includes(this.handPhase)) {
      return { ok: false, error: 'Betting is not available right now.' };
    }
    if (isStud && !studBettingPhases.includes(this.handPhase)) {
      return { ok: false, error: 'Betting is not available right now.' };
    }
    // NEW 7.0 (§6.8): a genuinely new precondition Draw/Hold'em never
    // needed, since they never require Dealer input to determine who
    // starts. Also confirms the selected player is still eligible --
    // they could in principle have sat out between selection and opening,
    // though the dropdown itself only ever lists active players.
    if (isStud) {
      // NEW 10.4 (the-cut-spec_v10-4.md Part E, live-confirmed): when
      // every remaining hand participant is bettingCapped (all-in), no
      // opener candidate can ever satisfy _canAct(), the dropdown is
      // correctly empty, and this requirement used to reject outright --
      // a genuine lockup, confirmed pre-existing but only reachable
      // starting with B.1's own fix (dealing itself used to fail first
      // and block things earlier). _maybeCloseBettingRound(), called
      // unconditionally at the end of this function, already handles an
      // empty "who can still act" list correctly (JS: `[].every(...)` is
      // vacuously true) -- its own comment already describes exactly
      // this scenario, and Hold'em/Draw already rely on it successfully.
      // So: only enforce the opener requirement when at least one hand
      // participant genuinely CAN act; otherwise skip it entirely and
      // fall through to that same already-proven auto-close path --
      // no new closing/advancing logic needed, only a bypass of the one
      // gate that didn't already know how to handle "nobody can act."
      const anyoneCanAct = this.players.some((p) => this._isHandParticipant(p) && this._canAct(p));
      if (anyoneCanAct) {
        const opener = this.openingBettorId ? this.getPlayer(this.openingBettorId) : null;
        // CHANGED 10.2 (the-cut-spec_v10-2.md §9.3 item 1's immediate
        // neighbor -- same defect signature, found in the same audit pass):
        // routed through _canAct() instead of the narrower folded/sittingOut
        // check, which never caught a never-dealt, all-in, or bettingCapped
        // opener slipping through between selection and opening.
        if (!opener || !this._canAct(opener)) {
          return { ok: false, error: 'Select an opening bettor before opening betting.' };
        }
      } else {
        // NEW 10.4 (Part E): visible to everyone at the table, not just
        // a tooltip on the Dealer's own button -- the round is about to
        // auto-close via the vacuous-truth path in _maybeCloseBettingRound()
        // below, with no real betting action from anyone.
        this._queueAnnouncement('No one can act this street -- betting is skipped.');
      }
    }
    // CHANGED 10.1 (the-cut-spec_v10-1.md §8.4, confirmed via direct
    // reproduction before this fix, not just traced): the old `chips > 0`
    // filter correctly excluded a never-dealt $0-chip Player (defect-1
    // territory) but ALSO incorrectly excluded a genuinely-all-in Player
    // surviving from an EARLIER street in the SAME hand -- reproduced
    // directly: two Hold'em players, the short stack goes all-in
    // pre-flop, both survive to the flop, and openBetting() on the flop
    // was rejected outright ("Need at least 2 active players"), with no
    // other path forward (the early-claim shortcut doesn't apply --
    // both players remain genuinely pot-eligible) -- a real,
    // hand-blocking dead end in the pre-10.1 build, not a hypothetical.
    // _isHandParticipant() is the correct definition here: dealt in, not
    // folded, not sitting out, regardless of remaining chips.
    const active = this.players.filter((p) => this._isHandParticipant(p));
    if (active.length < MIN_PLAYERS_TO_DEAL) {
      return { ok: false, error: `Need at least ${MIN_PLAYERS_TO_DEAL} active (not sitting out) players to open betting.` };
    }
    if (this.bettingOpen) {
      return { ok: false, error: 'A betting round is already open.' };
    }
    // CHANGED 11.0 (Part E): positional anchor, not necessarily the
    // current Dealer -- see _positionAnchorId()'s own comment.
    const blindSeats = isHoldem && this.handPhase === 'PreFlopBetting' ? this._computeBlindSeats(this._positionAnchorId()) : [];
    const [smallBlindPlayer, bigBlindPlayer] = blindSeats;
    // NEW 7.0 (§6.8): Bring In applies only on Stud's very first betting
    // round of the hand -- simpler than Hold'em's blind seeding, since no
    // money is already in the pot at this point (not pre-posted).
    const bringInApplies = isStud && this.handPhase === 'StreetABetting' && typeof this.gameOptions?.bringIn === 'number';

    this.bettingOpen = true;
    this._actedSinceRaise = new Set();
    this._bringInObligationId = null;
    // NEW 9.0 (§6.10): fresh per-round raise tracking. PreFlopBetting
    // seeds the minimum raise increment at the Big Blind (the round's
    // Bet, per §6.10's terminology); every other street starts at 0
    // until the first Bet lands (set below, in placeBet()).
    this.raiseCountThisRound = 0;
    // NEW 9.0 (§6.10): seeds the minimum-raise floor at the round's own
    // forced-open amount -- the Big Blind (Hold'em PreFlopBetting) or the
    // Bring-In (Stud StreetABetting, NEW 9.4) -- both ARE "the round's
    // Bet" per the universal terminology (§6.10), so both seed the same
    // way. Every other street/profile starts at 0 until the first
    // voluntary Bet lands (set in placeBet()).
    this._minRaiseIncrement =
      isHoldem && this.handPhase === 'PreFlopBetting' && typeof this.gameOptions?.bigBlind === 'number'
        ? this.gameOptions.bigBlind
        : bringInApplies
          ? this.gameOptions.bringIn
          : 0;
    if (bigBlindPlayer && typeof this.gameOptions?.bigBlind === 'number') {
      // PreFlopBetting only: the blinds are already live money, not a
      // fresh $0 round. Seed the amount everyone else must face, and
      // each blind-poster's own already-contributed amount, instead of
      // discarding that fact the way every other betting round correctly does.
      this.currentBetToCall = this.gameOptions.bigBlind;
      for (const player of this.players) {
        player.currentBet =
          player.id === bigBlindPlayer.id
            ? this.gameOptions.bigBlind
            : player.id === smallBlindPlayer?.id && typeof this.gameOptions?.smallBlind === 'number'
              ? this.gameOptions.smallBlind
              : 0;
      }
    } else if (bringInApplies) {
      // Not pre-posted -- the opening bettor's own currentBet stays $0;
      // they face the Bring In as their own live call/raise/fold
      // obligation (Fold unavailable, see below), same shape as everyone
      // else always facing a fresh currentBetToCall, just seeded non-zero.
      this.currentBetToCall = this.gameOptions.bringIn;
      for (const player of this.players) player.currentBet = 0;
      this._bringInObligationId = this.openingBettorId;
    } else {
      this.currentBetToCall = 0;
      for (const player of this.players) {
        player.currentBet = 0;
        // folded must NOT reset here -- see fold()'s own docs; a hand can
        // have more than one betting round, and folded persists across all
        // of them within the same hand.
      }
    }

    if (isStud) {
      // The selected opening bettor acts first, full stop -- not "the
      // seat after them" the way Draw's/Hold'em's anchor convention
      // works. Already validated above to be active and eligible.
      this.currentTurnPlayerId = this.openingBettorId;
    } else {
      let anchorId = this._positionAnchorId(); // default: left of the positional anchor (CHANGED 11.0, Part E)
      if (bigBlindPlayer) anchorId = bigBlindPlayer.id;
      const anchorIdx = this.turnOrder.indexOf(anchorId);
      this.currentTurnPlayerId =
        anchorIdx === -1 || this.turnOrder.length === 0
          ? this.turnOrder[0] || null
          : this.turnOrder[(anchorIdx + 1) % this.turnOrder.length];
      if (this.currentTurnPlayerId) {
        const startPlayer = this.getPlayer(this.currentTurnPlayerId);
        // CHANGED 10.2 (the-cut-spec_v10-2.md §9.3 item 1): this ran as a
        // ONE-TIME check on a single candidate, using an inline
        // sittingOut/folded/allIn/bettingCapped combination that never
        // included the dealt-in check -- a never-dealt $0-chip Player
        // could be set as currentTurnPlayerId directly here, completely
        // bypassing _nextTurnPlayerId()'s own already-fixed loop.
        // Reproduced live: a never-dealt Player was shown as owing the
        // current bet and holding the acting turn. Routed through the
        // shared _canAct() -- the exact same question, correctly
        // including the dealt-in check this time.
        if (!this._canAct(startPlayer)) {
          this.currentTurnPlayerId = this._nextTurnPlayerId();
        }
      }
    }
    this.bettingRoundsThisHand += 1; // still-maintained bookkeeping; no longer a Draw/Hold'em/Stud gate (handPhase replaces that role)
    if (this.bettingRoundsThisHand >= 2) this.discardWindowOpen = false;
    // NEW 9.0 (§6.11): if every remaining active player is already
    // all-in (nobody left who can actually act this round -- e.g. two
    // short stacks went all-in pre-flop and the rest folded), the round
    // needs to close itself immediately rather than sit open forever
    // waiting on a turn nobody can take. _maybeCloseBettingRound() finds
    // an empty "still needs to act" list in exactly this case and closes
    // right away -- harmless no-op otherwise (real players still owe a
    // turn, so it stays open as normal).
    this._maybeCloseBettingRound();
    return { ok: true };
  }

  /**
   * NEW 7.0 (§5.10/§6.8): Dealer manually selects who opens the CURRENT
   * betting round -- Stud's genuinely new mechanism, since who's showing
   * the strongest/weakest up-cards is a card-value judgment the server
   * never evaluates (§12). Re-selected every street, not just the first:
   * resets to null at the entry of every `StreetXBetting` phase (handled
   * by `deal()`, which is what transitions into it), so a fresh selection
   * is required each time. Only settable before betting opens for the
   * current street -- once `openBetting` has locked in the turn-order
   * anchor, changing this would have no coherent effect until the next
   * street resets it anyway.
   */
  setOpeningBettor(requesterId, playerId) {
    const dealer = this.getDealer();
    if (!dealer || dealer.id !== requesterId) {
      return { ok: false, error: 'Only the Dealer can select the opening bettor.' };
    }
    if (this.pendingClaim) return { ok: false, error: 'A claim is pending approval.' };
    if (this.profile !== 'stud') {
      return { ok: false, error: 'Select Opening Bettor is only available for the Stud profile.' };
    }
    const studBettingPhases = ['StreetABetting', 'StreetBBetting', 'StreetCBetting', 'StreetDBetting', 'StreetEBetting'];
    if (!studBettingPhases.includes(this.handPhase)) {
      return { ok: false, error: 'Select Opening Bettor is only available during a betting street.' };
    }
    if (this.bettingOpen) {
      return { ok: false, error: 'Betting is already open for this street.' };
    }
    const target = this.getPlayer(playerId);
    if (!target) return { ok: false, error: 'Player not found.' };
    // CHANGED 10.1 (the-cut-spec_v10-1.md §8.2/§8.3 defect 5): a single
    // call to the shared _canAct() replaces the two separate hand-rolled
    // checks this used to have (folded/sittingOut, then
    // allIn/bettingCapped) -- confirmed live by Mike's own testing that a
    // Dealer could select a never-dealt $0-chip Player here and the
    // server would accept it, since neither of the old checks asked
    // "was this Player actually dealt into the current hand."
    if (!this._canAct(target)) {
      return { ok: false, error: 'The opening bettor must be an active player, dealt into this hand, still able to act.' };
    }
    this.openingBettorId = target.id;
    return { ok: true };
  }

  /**
   * CHANGED 5.0: now also triggers the Draw-profile phase transition the
   * instant a round actually closes, via _onBettingRoundClosed().
   */
  _maybeCloseBettingRound() {
    if (!this.bettingOpen) return;
    // CHANGED 10.1 (the-cut-spec_v10-1.md §8.2/§8.3 defect 2): routed
    // through the shared _canAct() -- the same combination
    // _nextTurnPlayerId() now uses, previously reimplemented
    // independently here and missing the same dealt-in check. A
    // never-dealt $0-chip Player could never satisfy "has acted" and
    // would hang the round forever.
    const activeIds = this.players.filter((p) => this._canAct(p)).map((p) => p.id);
    const everyoneHasActed = activeIds.every((id) => this._actedSinceRaise.has(id));
    if (everyoneHasActed) {
      this.bettingOpen = false;
      this._onBettingRoundClosed();
    }
  }

  _requireActingPlayer(requesterId) {
    if (!this.bettingOpen) return { error: 'There is no open betting round.' };
    if (requesterId !== this.currentTurnPlayerId) return { error: "It isn't your turn to act." };
    const player = this.getPlayer(requesterId);
    if (!player) return { error: 'Player not found.' };
    if (player.folded) return { error: "You've folded this round and can't act." };
    if (player.sittingOut) return { error: "You're sitting out and can't act." };
    return { player };
  }

  // NEW 9.4: _activeStackCap() ("shortest active stack" cap, the pre-9.0/
  // §14 item 10 Draw/Stud fallback) is retired -- no longer called now
  // that _validateBetOrRaise covers all three profiles.

  /**
   * NEW 9.0 (§6.10 Side Pots), extended to Stud and Draw in 9.4: fully automatic, derived
   * pot-tier computation -- a pure function of two already-tracked
   * inputs (every player's `totalContributedThisHand` and who's folded),
   * re-run from scratch on every contribution-affecting action (fold,
   * call, placeBet, allIn). This is arithmetic, not a hand-ranking
   * judgment, so it stays on the server side of the primitives-not-rules
   * line (§12) the same way `currentBetToCall`/`pot` already do.
   *
   * REWRITTEN 9.1 -- two real bugs in the 9.0 formula, both found via
   * `side-pot-scenario-reference.md`'s 27-action regression fixture:
   *
   * BUG 1 (FIXED 9.1): tier boundaries used to come from every distinct
   * contribution level among non-folded players. Wrong -- a small blind
   * and big blind sitting at different, not-yet-equalized amounts
   * (neither all-in, simply not yet having acted) aren't a real dividing
   * line. Boundaries now come ONLY from genuine all-in thresholds.
   *
   * BUG 2 (FIXED 9.1): the per-tier amount used to be "gap x count of
   * players who reached the tier's FULL upper bound" -- which silently
   * dropped money from a player who folds with a contribution landing
   * PARTWAY into a tier, before that tier's own boundary is established
   * by a later all-in. Corrected to the general formula: each player,
   * folded or not, contributes whatever portion of their own total lands
   * inside a tier's [lower, upper) range.
   *
   * One tier per gap between consecutive all-in thresholds (implicit 0
   * at the start), PLUS one final open tier above the highest threshold
   * if anyone's contribution actually reaches beyond it -- bounded, for
   * the purposes of the amount formula, by whatever the single highest
   * contribution actually is (never a fixed number, since nobody else is
   * all-in up there to set one). A tier this open-ended in practice
   * self-corrects the moment the uncalled-bet refund rule (below) fires,
   * since a refund is exactly what prevents this open tier from ever
   * containing genuinely unmatched money once the hand's outcome is
   * certain -- see `_checkUncalledBetRefund()`.
   *
   * Eligibility per tier: non-folded AND contributed at least that
   * tier's own upper bound. A folded player's money still counts toward
   * every tier's AMOUNT wherever it lands, never toward eligibility.
   *
   * `this.pots` stays `null` -- the ordinary, unchanged single-`$XXX`-
   * figure case -- unless at least two genuine tiers actually exist.
   *
   * Tier `id`s are assigned by ascending threshold (0 = Main Pot,
   * ascending = Side Pot 1, 2, ...) -- stable across recomputation
   * because a genuine all-in threshold never disappears once set (an
   * all-in player has no further actions available, so can never fold
   * afterward and remove that level from the non-folded set). `claimed`
   * flags carry forward from the previous computation, matched by
   * threshold, so an already-resolved pot stays resolved across
   * subsequent recomputes (claimPot/resolveClaim never call this once
   * betting for the hand has fully finished).
   */
  _recomputePots() {
    const contributors = this.players.filter((p) => (p.totalContributedThisHand || 0) > 0);
    if (contributors.length === 0) {
      this.pots = null;
      return;
    }
    const nonFolded = contributors.filter((p) => !p.folded);

    // BUG 1 FIX (9.1): boundaries come ONLY from genuine all-in thresholds.
    const boundaries = Array.from(new Set(nonFolded.filter((p) => p.allIn).map((p) => p.totalContributedThisHand))).sort(
      (a, b) => a - b
    );
    if (boundaries.length === 0) {
      this.pots = null;
      return;
    }

    const allLevels = [0, ...boundaries];
    const tierRanges = [];
    for (let i = 1; i < allLevels.length; i++) {
      tierRanges.push({ lower: allLevels[i - 1], upper: allLevels[i] });
    }
    const highestBoundary = boundaries[boundaries.length - 1];
    const maxContribution = Math.max(...contributors.map((p) => p.totalContributedThisHand));
    if (maxContribution > highestBoundary) {
      // The final open tier -- bounded only by whatever's currently been
      // contributed there, not a fixed all-in threshold.
      tierRanges.push({ lower: highestBoundary, upper: Infinity });
    }

    // BUG 2 FIX (9.1): per-tier amount = sum over every contributor
    // (folded or not) of however much of THEIR OWN total lands inside
    // this tier's range.
    const computed = tierRanges
      .map((range) => {
        const upperForMath = range.upper === Infinity ? maxContribution : range.upper;
        const amount = contributors.reduce((sum, p) => {
          const inTier = Math.max(0, Math.min(p.totalContributedThisHand, upperForMath) - range.lower);
          return sum + inTier;
        }, 0);
        const eligiblePlayerIds = nonFolded.filter((p) => p.totalContributedThisHand >= upperForMath).map((p) => p.id);
        return { amount, eligiblePlayerIds, threshold: range.upper === Infinity ? upperForMath : range.upper };
      })
      .filter((t) => t.amount > 0);

    if (computed.length <= 1) {
      // Either nothing materialized, or there's only one genuine tier --
      // functionally identical to the ordinary no-split display.
      this.pots = null;
      return;
    }

    const previousByThreshold = new Map((this.pots || []).map((p) => [p.threshold, p]));
    this.pots = computed.map((t, i) => ({
      id: i,
      label: i === 0 ? 'Main Pot' : `Side Pot ${i}`,
      amount: t.amount,
      eligiblePlayerIds: t.eligiblePlayerIds,
      threshold: t.threshold,
      claimed: previousByThreshold.get(t.threshold)?.claimed || false,
    }));
  }

  /**
   * NEW 9.1 (§6.10): the uncalled-bet refund rule. Runs after every fold
   * and after every All-In (mid-round, not deferred to round-close) --
   * fold, because folding is what can make an ALREADY-PLACED, previously
   * legal bet suddenly uncallable (Scenarios A-D); All-In, because it's
   * deliberately exempt from `_validateHoldemBetOrRaise`'s proactive
   * opponent-ceiling cap (below) -- an all-in FOR MORE than anyone else
   * can cover is exactly what All-In is for, so it can create a brand
   * new excess immediately, with no fold required at all. Ordinary
   * Call/Bet/Raise never need this check on their own -- the proactive
   * cap already prevents them from creating a new excess in the first
   * place; this check only ever has to correct for excesses that arise
   * from something OTHER than the current actor's own capped action.
   *
   * Effective ceiling for a given non-folded opponent = their own
   * `totalContributedThisHand` plus their remaining `chips` -- UNLESS
   * they're already `bettingCapped`, in which case their ceiling is
   * frozen at their current total: a capped player can never contribute
   * further for the rest of the hand, so their remaining chips don't
   * represent real future capacity and must not inflate anyone else's
   * safe ceiling.
   */
  _checkUncalledBetRefund() {
    if (!isPhaseGated(this.profile)) return; // NEW 9.4: extended from Hold'em-only to every phase-gated profile
    // BUG FIX (found while tracing refund-scenario-reference.md's
    // fixtures): "others" must include every non-folded, non-sitting-out
    // player -- NOT just players who've already contributed something
    // this hand. A player who hasn't acted yet this round can still
    // fully cover a bet with their entire remaining stack; excluding
    // them here wrongly shrinks the ceiling and can trigger a refund
    // long before it's actually warranted.
    const contributors = this.players.filter((p) => (p.totalContributedThisHand || 0) > 0);
    const nonFoldedContributors = contributors.filter((p) => !p.folded);
    if (nonFoldedContributors.length === 0) return;
    const highest = nonFoldedContributors.reduce(
      (top, p) => (p.totalContributedThisHand > top.totalContributedThisHand ? p : top),
      nonFoldedContributors[0]
    );
    // CHANGED 10.2 (the-cut-spec_v10-2.md §9.3 item 3): routed through
    // _isHandParticipant() -- previously `!p.folded && !p.sittingOut`
    // directly on ALL seated Players, the same never-dealt-Player gap as
    // everything in §8, but with a distinct consequence here: if a
    // never-dealt $0-chip Player was the ONLY other non-folded,
    // non-sitting-out seat, they were counted as a real opponent with a
    // $0 ceiling, which could trigger a spurious full refund --
    // `others.length >= 1` read as "someone real is still in it" when
    // there wasn't. Distinct from item 2 (a correct refund amount with a
    // stale downstream value) -- this is a WRONG refund amount.
    const others = this.players.filter((p) => p.id !== highest.id && this._isHandParticipant(p));
    if (others.length === 0) return; // nobody left to compare against -- the sole-survivor case, handled by the early-claim shortcut instead
    const ceiling = Math.max(
      ...others.map((p) => (p.bettingCapped ? p.totalContributedThisHand : (p.totalContributedThisHand || 0) + p.chips))
    );
    if (highest.totalContributedThisHand <= ceiling) return;

    const refund = highest.totalContributedThisHand - ceiling;
    highest.totalContributedThisHand -= refund;
    highest.chips += refund;
    highest.currentBet = Math.max(0, highest.currentBet - refund); // keeps the shared betting rail's "Total Bet" figure consistent
    // FIXED 10.2 (the-cut-spec_v10-2.md §9.2/§9.3 item 2): a DIFFERENT
    // category of defect from every other item in this pass -- not a
    // missing eligibility check, but a mutation that updated the
    // refunded Player's own currentBet without resyncing the ONE other
    // value every other Player's Call/Check/Raise decision is computed
    // from. Everywhere else in this file that sets currentBetToCall
    // (placeBet(), allIn()), it's kept equal to the current highest
    // bettor's own currentBet -- the same relationship this refund just
    // changed on one side without touching the other. Reproduced live:
    // an all-in for $2,300 correctly refunded down to a $750 effective
    // bet, and the next Player to act was shown $2,300 owed instead of
    // the correct $750. Mirrors the exact adjustment already applied to
    // highest.currentBet, immediately above -- same amount, same reason,
    // the missing half of the same update.
    this.currentBetToCall = Math.max(0, this.currentBetToCall - refund);
    this.pot -= refund;
    highest.allIn = false; // CHANGED 9.1 (§6.10, §3): allIn is a purely display concept as of 9.1 -- clears the instant any refund restores a stack
    highest.bettingCapped = true; // NEW 9.1 -- the functional exclusion, permanent for the rest of the hand regardless of allIn's own value
    this._queueAnnouncement(`$${refund} returned to ${highest.name} \u2014 no remaining player can cover more.`, 'refund');

    // Cascades (§6.10): a fold (or all-in) can trigger more than one
    // refund event in sequence -- re-run in case this correction itself
    // reveals a new highest contributor who's now also over the (freshly
    // updated) ceiling. Resolves in practice within one or two further
    // passes; recursion is cheap and defensively correct either way.
    this._checkUncalledBetRefund();
  }

  /**
   * NEW 9.4 (§6.10): the current street's Fixed-Limit Small/Big Bet
   * dollar amount, profile-aware -- Hold'em derives it from
   * smallBlind/bigBlind (unchanged since 9.0); Stud and Draw use their
   * own directly-configured smallBet/bigBet Dealer Options instead,
   * since neither has blinds to derive anything from. Street mapping,
   * verified against real published Fixed-Limit convention (not a
   * formula): Stud's A/B streets are always Small Bet, C onward always
   * Big Bet -- this single rule covers both 5-Card (finalStreet 'D':
   * only ever reaches C/D, both Big Bet) and 7-Card (finalStreet 'E':
   * reaches C/D/E, all Big Bet) without needing to branch on variant at
   * all, since 5-Card Stud simply never reaches streets past D. Draw's
   * pre-draw round is Small Bet, the post-draw (final) round Big Bet.
   */
  _fixedLimitSize() {
    if (this.profile === 'holdem') {
      const bigBlind = typeof this.gameOptions?.bigBlind === 'number' ? this.gameOptions.bigBlind : 0;
      const isSmall = this.handPhase === 'PreFlopBetting' || this.handPhase === 'FlopBetting';
      return isSmall ? bigBlind : bigBlind * 2;
    }
    const smallBet = typeof this.gameOptions?.smallBet === 'number' ? this.gameOptions.smallBet : 0;
    const bigBet = typeof this.gameOptions?.bigBet === 'number' ? this.gameOptions.bigBet : 0;
    if (this.profile === 'draw') {
      return this.handPhase === 'FirstBetting' ? smallBet : bigBet;
    }
    if (this.profile === 'stud') {
      const m = /^Street([A-E])Betting$/.exec(this.handPhase);
      const letter = m ? m[1] : null;
      return letter === 'A' || letter === 'B' ? smallBet : bigBet;
    }
    return 0;
  }

  /**
   * NEW 9.4 (§6.11 bug fix): the maximum TOTAL a Bet/Raise/All-In could
   * legally reach right now, under the active betting structure --
   * deliberately NOT capped at "one short of the player's own stack"
   * the way _validateBetOrRaise's ordinary-Raise ceiling is (that -1 is
   * specifically to force a genuine full-stack commitment through the
   * dedicated All-In action instead); All-In itself needs the TRUE
   * legal max, since reaching it exactly is exactly what it's for.
   */
  _legalMaxBetOrRaiseTotal(player) {
    const ownStackCap = player.currentBet + player.chips;
    const structure = this.gameOptions?.bettingStructure || 'no-limit';
    if (structure === 'fixed-limit') {
      const fixedSize = this._fixedLimitSize();
      const total = this.currentBetToCall > 0 ? this.currentBetToCall + fixedSize : fixedSize;
      return Math.min(total, ownStackCap);
    }
    if (structure === 'pot-limit') {
      const callAmount = Math.max(0, this.currentBetToCall - player.currentBet);
      const potAfterCall = this.pot + callAmount;
      return Math.min(this.currentBetToCall + potAfterCall, ownStackCap);
    }
    return ownStackCap; // No-Limit: no ceiling beyond the player's own stack.
  }

  /**
   * NEW 11.2 (Fix 3), factored out in 11.4 (Part D.3) so
   * _canBetOrRaise() below can reuse the exact same computation
   * _validateBetOrRaise() already relies on, rather than a second copy
   * that could quietly drift out of sync -- exactly the failure mode
   * Fix 3 itself was caused by. Returns `null` when there's nobody else
   * left in the hand for a ceiling to mean anything against (matching
   * the 10.1 fix this whole check builds on: a never-dealt $0-chip
   * Player at a heads-up table must not produce a $0 ceiling).
   */
  _opponentCeiling(player) {
    const otherOpponents = this.players.filter((p) => p.id !== player.id && this._isHandParticipant(p));
    if (otherOpponents.length === 0) return null;
    return Math.max(...otherOpponents.map((p) => (p.bettingCapped ? p.totalContributedThisHand : p.totalContributedThisHand + p.chips)));
  }

  /**
   * NEW 11.4 (Part D.2): "if this Player bet the smallest possible
   * amount ($1), what would their cumulative total for the hand
   * become" -- the probe used to distinguish "no bet at all is
   * possible" (even $1 would exceed the ceiling) from "a smaller bet
   * would still be legal" (the attempted amount was simply too big).
   * Mirrors _validateBetOrRaise()'s own `proposedCumulativeTotal`
   * formula exactly, with `amount` fixed at 1.
   */
  _minimumPossibleCumulativeTotal(player) {
    return player.totalContributedThisHand + (1 - player.currentBet);
  }

  /**
   * NEW 11.4 (Part D.3): the SAME check _validateBetOrRaise() already
   * enforces reactively (rejecting a blocked Bet on click), exposed
   * here as a proactive query -- "is ANY legal Bet/Raise currently
   * possible for this Player at all" -- so toRedactedState() can surface
   * it as `canBetOrRaise` and the client can disable the Bet/All-In
   * buttons per the Standing Convention, the same established pattern
   * already used for Buy Chips's own `canBuyChips` (_canBuyChips()).
   * Gated behind GATE_BETTING_BUTTONS_WHEN_UNCALLABLE -- see that
   * constant's own comment for the Beta-window revert story.
   */
  _canBetOrRaise(player) {
    if (!GATE_BETTING_BUTTONS_WHEN_UNCALLABLE) return true;
    const opponentCeiling = this._opponentCeiling(player);
    if (opponentCeiling === null) return true;
    return this._minimumPossibleCumulativeTotal(player) <= opponentCeiling;
  }

  /**
   * NEW 9.0 (§6.10), extended to Stud and Draw in 9.4 (renamed from
   * _validateHoldemBetOrRaise -- the whole point of 9.4 is that this
   * validation is no longer Hold'em-specific). Deliberately generic:
   * every profile-specific detail (Small/Big Bet dollar amount, minimum
   * bet floor) is isolated in _fixedLimitSize() and the No-Limit/
   * Pot-Limit minBet line below, so this function's own control flow
   * never branches on profile at all.
   */
  _validateBetOrRaise(player, amount) {
    const ownStackCap = player.currentBet + player.chips;
    // NEW 9.0 (§6.11): committing the player's ENTIRE remaining stack is
    // exclusively the dedicated All-In action's job as of 9.0 -- "a
    // dedicated action... rather than inferring intent by comparing an
    // entered amount against a player's exact remaining stack." Bet/Raise
    // are rejected outright once they'd do that, whether the player is
    // genuinely short-stacked or simply choosing to shove voluntarily.
    if (amount >= ownStackCap) {
      return { ok: false, error: 'That would commit your entire stack \u2014 use All-In instead.' };
    }

    // NEW 9.1 (§6.10): a Bet/Raise (never All-In, which is deliberately
    // exempt -- see _checkUncalledBetRefund()'s own doc comment) can
    // never exceed the largest amount any single remaining non-folded
    // opponent could still possibly cover. This prevents the excess from
    // ever being created in the first place for a voluntary Bet/Raise --
    // the uncalled-bet refund rule (fold-triggered, and All-In-triggered)
    // still exists for the cases this can't prevent: a bet that was
    // legal WHEN PLACED (every opponent could still cover it at the
    // time) becoming excessive AFTER an opponent later folds.
    // CHANGED 10.1 (the-cut-spec_v10-1.md §8.2/§8.3 defect 6): routed
    // through _isHandParticipant() -- previously reimplemented the same
    // folded/sittingOut combination inline, missing the dealt-in check.
    // A never-dealt $0-chip Player, the only "other opponent" at a
    // heads-up table, would give an opponentCeiling of $0 and incorrectly
    // cap a real Player's legal bet down to $0.
    const opponentCeiling = this._opponentCeiling(player);
    if (opponentCeiling !== null) {
      // FIXED 11.2 (Fix 3): `amount` here is a STREET-LOCAL figure (the
      // proposed new value of player.currentBet for THIS betting round,
      // reset every street) -- comparing it directly against
      // `opponentCeiling` (built from `totalContributedThisHand`, a
      // WHOLE-HAND CUMULATIVE figure) only worked by accident on a
      // player's very first street, where the two scales happen to
      // coincide. Once any earlier street's money is already in play,
      // this player's own cumulative total for the hand -- their
      // existing totalContributedThisHand PLUS what this action would
      // actually move (`amount - player.currentBet`, the same
      // `additional` the caller itself computes) -- is the right,
      // unit-consistent figure to compare, matching how
      // _checkUncalledBetRefund() already does this correctly. Live-
      // reproduced directly against GameTable before this fix: three
      // Players already all-in and capped at $100 total from an earlier
      // street, the fourth (also at $100 cumulative already) betting a
      // further $10 was incorrectly allowed, since $10 is trivially less
      // than the $100 ceiling even though nobody could ever call it.
      const proposedCumulativeTotal = player.totalContributedThisHand + (amount - player.currentBet);
      if (proposedCumulativeTotal > opponentCeiling) {
        // NEW 11.4 (Part D.2): distinguishes "a smaller bet would still
        // be legal" from "no bet at all is possible" -- the pre-11.4
        // message always suggested All-In as a working alternative,
        // which is actively wrong advice in the second case. Pure
        // string change; the condition/variables above are untouched.
        // `_minimumPossibleCumulativeTotal(player)` is literally "what
        // if they bet the smallest possible amount, $1" -- if even that
        // still exceeds the ceiling, nothing smaller would have worked
        // either, matching D.1's own "not even $1" framing exactly.
        if (this._minimumPossibleCumulativeTotal(player) > opponentCeiling) {
          return { ok: false, error: 'No player can cover any additional bets. You must Check to continue.' };
        }
        return {
          ok: false,
          error: `No remaining player could cover a raise beyond $${opponentCeiling} \u2014 use All-In if you want to commit more than that.`,
        };
      }
    }

    const structure = this.gameOptions?.bettingStructure || 'no-limit';
    const isOpeningBet = this.currentBetToCall === 0;
    const increment = amount - this.currentBetToCall;
    // BUG FIX 9.5 (§6.10), immediate/emergency: the Pot-Limit Maximum
    // formula below must credit what the acting player has already put
    // in THIS STREET -- CONFIRMED with Mike this does NOT also apply to
    // Minimum Raise (see that check's own comment for why they're
    // genuinely different formulas, not the same bug in two places, as
    // an earlier draft of this fix assumed). Using raw
    // `this.currentBetToCall` where `callAmount` belongs double-counted
    // the player's own prior contribution in Pot-Limit's own formula
    // specifically (potAfterCall already includes it once). For a
    // player with $0 already in this street (e.g. a fresh UTG),
    // `callAmount === this.currentBetToCall` exactly, so this fix is a
    // pure no-op in that case and every prior worked example (§6.10's
    // own $1/$2 pot-limit example, all of 9.0-9.4's tests) continues to
    // hold unchanged.
    const callAmount = Math.max(0, this.currentBetToCall - player.currentBet);

    if (structure === 'fixed-limit') {
      const fixedSize = this._fixedLimitSize(); // NEW 9.4: profile-aware, was inline Hold'em-only math
      if (isOpeningBet) {
        if (amount !== fixedSize) {
          return { ok: false, error: `Fixed-Limit bets must be exactly $${fixedSize} on this street.` };
        }
      } else {
        // Raise cap: "bet plus three raises" by default, waived heads-up.
        // NEW 9.1: raiseCap can be the literal string "no-cap" (§3) --
        // guarded here defensively even though it should only ever be
        // that under No-Limit (setGameOption's auto-reset guarantees a
        // real number under Fixed-Limit/Pot-Limit).
        const cap = this.gameOptions?.raiseCap;
        // CHANGED 10.1 (the-cut-spec_v10-1.md §8.2/§8.3 defect 4):
        // routed through _isHandParticipant() -- a never-dealt $0-chip
        // Player at a 3-handed table (2 real players, 1 phantom) was
        // previously counted here, making a genuinely-heads-up situation
        // fail to waive the raise cap.
        const headsUp = this.players.filter((p) => this._isHandParticipant(p)).length === 2;
        if (!headsUp && cap !== 'no-cap' && this.raiseCountThisRound >= (typeof cap === 'number' ? cap : 3)) {
          return { ok: false, error: 'No more raises are allowed this round (Fixed-Limit raise cap reached).' };
        }
        if (increment !== fixedSize) {
          return { ok: false, error: `Fixed-Limit raises must be exactly $${fixedSize} on this street.` };
        }
      }
      return { ok: true };
    }

    // No-Limit / Pot-Limit share the same Minimum Bet/Raise formula.
    if (isOpeningBet) {
      const minBet = typeof this.gameOptions?.bigBlind === 'number' ? this.gameOptions.bigBlind : 0;
      if (minBet > 0 && amount < minBet) {
        return { ok: false, error: `Bet must be at least $${minBet} (the table's minimum bet).` };
      }
    } else {
      // BUG FIX 9.5 (§6.10), CONFIRMED with Mike: Minimum Raise is
      // measured from the TABLE's shared current bet, the same for
      // every player regardless of what they've individually already
      // posted -- NOT credited by the acting player's own contribution
      // the way Pot-Limit Maximum is (below). These are genuinely
      // different formulas answering different questions: Minimum Raise
      // asks "how big must this raise be, uniformly, given the last
      // raise's size" (MRT = MRB + Current Bet, where MRB = the most
      // recent raise's own size / this._minRaiseIncrement); Pot-Limit
      // Maximum asks "how big can the pot grow given what THIS PLAYER
      // is about to add" (credits their own call amount correctly, see
      // below). An earlier draft of this fix applied the same "credit
      // the player" pattern to both, which broke this one specifically
      // -- confirmed by tracing the exact dollar amounts against the
      // 9.0 worked example (BB $10, raise to $30, SB with $5 already in
      // facing it): crediting would let the SB's "minimum" raise be
      // only a $15 increase over the $30 bet, less than the $20 minimum
      // raise size everyone else must meet -- a real rules violation,
      // not a fix. This formula is therefore UNCHANGED from 9.0-9.4.
      const minRaiseTotal = this.currentBetToCall + this._minRaiseIncrement;
      if (amount < minRaiseTotal) {
        return {
          ok: false,
          error: `Raise must be at least $${this._minRaiseIncrement} more than the current bet to call ($${this.currentBetToCall}) \u2014 raise to at least $${minRaiseTotal}.`,
        };
      }
      // NEW 9.1: raiseCap now also applies under Pot-Limit, extended from
      // Fixed-Limit-only -- a real, if less common, house-rule combination.
      if (structure === 'pot-limit') {
        const cap = this.gameOptions?.raiseCap;
        // CHANGED 10.1 (the-cut-spec_v10-1.md §8.2/§8.3 defect 4):
        // routed through _isHandParticipant() -- a never-dealt $0-chip
        // Player at a 3-handed table (2 real players, 1 phantom) was
        // previously counted here, making a genuinely-heads-up situation
        // fail to waive the raise cap.
        const headsUp = this.players.filter((p) => this._isHandParticipant(p)).length === 2;
        if (!headsUp && cap !== 'no-cap' && this.raiseCountThisRound >= (typeof cap === 'number' ? cap : 3)) {
          return { ok: false, error: 'No more raises are allowed this round (Pot-Limit raise cap reached).' };
        }
      }
    }

    if (structure === 'pot-limit') {
      // Maximum raise = (pot including every bet/raise so far this round)
      // + (the acting player's own call amount) -- the pot size AFTER
      // their call, not before (§6.10's worked example).
      const potAfterCall = this.pot + callAmount;
      // BUG FIX 9.5 (§6.10): maxTotal = callAmount + potAfterCall -- was
      // `this.currentBetToCall + potAfterCall`, re-adding the player's
      // own already-committed amount a second time (callAmount and
      // this.currentBetToCall are identical only when the player has
      // $0 in already; otherwise this.currentBetToCall = callAmount +
      // player.currentBet, so using it here double-counted
      // player.currentBet on top of what potAfterCall already credits).
      const maxTotal = Math.min(callAmount + potAfterCall, ownStackCap - 1);
      // (capped one short of ownStackCap, since committing the full
      // stack is exclusively All-In's job -- see the check above)
      if (amount > maxTotal) {
        return { ok: false, error: `Pot-Limit maximum raise is to $${maxTotal} right now.` };
      }
    }
    // No-Limit: no further ceiling beyond the player's own stack, already checked above.

    return { ok: true };
  }

  placeBet(requesterId, amount) {
    const guard = this._requireActingPlayer(requesterId);
    if (guard.error) return { ok: false, error: guard.error };
    const player = guard.player;

    if (!Number.isInteger(amount) || amount <= 0) {
      return { ok: false, error: 'Bet amount must be a positive whole number.' };
    }
    if (amount <= this.currentBetToCall) {
      return {
        ok: false,
        error:
          this.currentBetToCall > 0
            ? `Raise must be more than the current bet to call ($${this.currentBetToCall}).`
            : 'Bet must be greater than zero.',
      };
    }

    // NEW 9.4 (§6.10): full betting-structure enforcement now applies to
    // every phase-gated profile, not just Hold'em -- the old
    // _activeStackCap() "shortest active stack" fallback (§14 item 10's
    // deferral) is retired for Draw/Stud along with it.
    const validation = this._validateBetOrRaise(player, amount);
    if (!validation.ok) return validation;

    const wasOpeningBet = this.currentBetToCall === 0;
    const increment = amount - this.currentBetToCall;
    const additional = amount - player.currentBet;
    player.chips -= additional;
    player.currentBet = amount;
    this.pot += additional;
    this.currentBetToCall = amount;
    player.totalContributedThisHand = (player.totalContributedThisHand || 0) + additional; // NEW 9.0 (§6.10)

    // NEW 9.0 (§6.10), extended 9.4: update the running minimum-raise
    // floor and the raise-cap counter. The opening Bet itself seeds the
    // floor but doesn't count as a "raise" for the cap.
    if (wasOpeningBet) {
      this._minRaiseIncrement = amount;
    } else {
      this._minRaiseIncrement = increment;
      this.raiseCountThisRound += 1;
    }

    if (this._bringInObligationId === player.id) this._bringInObligationId = null; // NEW 7.0 (§6.8): resolved by raising over it
    this._actedSinceRaise = new Set([player.id]);
    this._recomputePots(); // NEW 9.0 (§6.10), extended 9.4
    // NEW 11.2 (Fix 3, defense-in-depth half): _validateBetOrRaise()'s
    // own proactive cap (just above) is the required fix and should
    // prevent an uncallable excess from ever being created by an
    // ordinary Bet/Raise in the first place -- this is not a
    // duplicate/parallel safeguard replacing that, it's a backstop so
    // this category of bug (a proactive check and a reactive one
    // silently drifting out of unit-agreement, exactly what happened
    // here) can't slip through both layers at once again. A correct
    // proactive cap makes this call a no-op in practice.
    this._checkUncalledBetRefund();
    this.currentTurnPlayerId = this._nextTurnPlayerId();
    this._maybeCloseBettingRound();
    return { ok: true };
  }

  call(requesterId) {
    const guard = this._requireActingPlayer(requesterId);
    if (guard.error) return { ok: false, error: guard.error };
    const player = guard.player;

    if (this.currentBetToCall <= 0) {
      return { ok: false, error: 'There is no bet to call yet.' };
    }
    const owed = this.currentBetToCall - player.currentBet;
    if (owed <= 0) {
      return { ok: false, error: 'You have already matched the current bet.' };
    }

    // NEW 9.0 (§6.11), extended to Stud/Draw in 9.4: a call that would
    // use up the player's entire remaining stack (or more than they
    // have) must go through the dedicated All-In action instead -- same
    // "explicit trigger, never inferred from an amount" reasoning as
    // placeBet's equivalent check above. Covers Stud's Bring-In too --
    // "Confirmed 9.4: a player whose stack doesn't cover the full
    // Bring-In can meet it as a short All-In" falls out of this
    // unchanged, since Bring-In is just a seeded currentBetToCall like
    // any other.
    if (owed >= player.chips) {
      return { ok: false, error: 'Calling would commit your entire stack \u2014 use All-In instead.' };
    }

    player.chips -= owed;
    player.currentBet = this.currentBetToCall;
    this.pot += owed;
    player.totalContributedThisHand = (player.totalContributedThisHand || 0) + owed; // NEW 9.0 (§6.10)

    if (this._bringInObligationId === player.id) this._bringInObligationId = null; // NEW 7.0 (§6.8): resolved by paying it
    this._actedSinceRaise.add(player.id);
    this._recomputePots(); // NEW 9.0 (§6.10), extended 9.4
    this.currentTurnPlayerId = this._nextTurnPlayerId();
    this._maybeCloseBettingRound();
    return { ok: true };
  }

  /**
   * NEW 9.0 (§6.11), extended to Stud and Draw in 9.4: commits the
   * player's entire remaining stack, filling whatever role the
   * situation calls for -- an opening Bet (currentBetToCall is $0), a
   * Call for less than the full amount owed (if their stack doesn't
   * cover it, including Stud's Bring-In), or a Raise to a total that
   * happens to be everything they have. Always bypasses the minimum
   * bet/raise requirement (the entire point of the all-in exception).
   * BUG FIX 9.4: the amount committed is now capped at
   * min(player's full stack, legal maximum for the current betting
   * structure) -- the pre-9.4 implementation always committed the full
   * stack with zero check against bettingStructure, letting a
   * deep-stacked player bypass the Fixed-Limit/Pot-Limit legal maximum
   * entirely (confirmed via research: All-In exists only for a SHORT
   * stack below the legal max, never as a way for a deep stack to
   * exceed it), and corrupted _minRaiseIncrement for every later player
   * with a too-large reference increment besides. A capped-short
   * commitment leaves the player with real chips still in front of
   * them, so Player.allIn (the display badge) is only ever set true
   * when the FULL stack was actually committed -- see below.
   */
  allIn(requesterId) {
    const guard = this._requireActingPlayer(requesterId);
    if (guard.error) return { ok: false, error: guard.error };
    const player = guard.player;

    if (player.chips <= 0) {
      return { ok: false, error: 'You have no chips left to go all-in with.' };
    }

    const ownStackCap = player.currentBet + player.chips;
    const legalMax = this._legalMaxBetOrRaiseTotal(player); // NEW 9.4 (§6.11 bug fix)
    const newTotal = Math.min(ownStackCap, legalMax);
    const amount = newTotal - player.currentBet; // chips actually committed -- may be less than player.chips if capped
    const wasOpeningBet = this.currentBetToCall === 0;
    const constitutesRaise = newTotal > this.currentBetToCall;

    player.chips -= amount;
    player.currentBet = newTotal;
    this.pot += amount;
    player.totalContributedThisHand = (player.totalContributedThisHand || 0) + amount;
    // NEW 9.4: only a genuine full-stack commitment reads as "All-In" --
    // a capped-short commitment leaves real chips in front of the
    // player, so the badge would be misleading if shown here too.
    player.allIn = newTotal === ownStackCap;

    if (this._bringInObligationId === player.id) this._bringInObligationId = null;

    if (constitutesRaise) {
      const increment = newTotal - this.currentBetToCall;
      this.currentBetToCall = newTotal;
      // NEW 9.0 (§6.10): an all-in raise reopens the action for everyone
      // else, same as any other raise -- even an all-in for LESS than a
      // formal minimum raise (the all-in exception's entire point).
      // Simplification, noted in the 9.0 README: this app doesn't
      // separately track whether an under-minimum all-in reopens raising
      // for players who already fully called the previous bet (some
      // formal rule sets restrict that) -- every raise, all-in or not,
      // reopens action for everyone here, matching how every other raise
      // in this app already behaves.
      this._minRaiseIncrement = wasOpeningBet ? newTotal : increment;
      if (!wasOpeningBet) this.raiseCountThisRound += 1;
      this._actedSinceRaise = new Set([player.id]);
    } else {
      this._actedSinceRaise.add(player.id);
    }

    this._checkUncalledBetRefund(); // NEW 9.1 (§6.10) -- All-In is exempt from the proactive opponent-ceiling cap, so it can create a brand-new excess immediately, with no fold required
    this._recomputePots(); // NEW 9.0 (§6.10), extended 9.4
    this._queueAnnouncement(`${player.name} is ALL IN for $${amount}!`, 'allin'); // NEW 9.0 (§6.11): dramatic table-wide notice
    this.currentTurnPlayerId = this._nextTurnPlayerId();
    this._maybeCloseBettingRound();
    return { ok: true };
  }

  check(requesterId) {
    const guard = this._requireActingPlayer(requesterId);
    if (guard.error) return { ok: false, error: guard.error };
    const player = guard.player;

    if (this.currentBetToCall !== player.currentBet) {
      return { ok: false, error: "Can't check \u2014 there's a bet to call." };
    }

    this._actedSinceRaise.add(player.id);
    this.currentTurnPlayerId = this._nextTurnPlayerId();
    this._maybeCloseBettingRound();
    return { ok: true };
  }

  /**
   * NEW 5.1 (§6.4): during the Draw/Hold'em/Stud phase machine's
   * `Showdown` phase, Fold is available to any non-folded, non-sitting-out
   * player, not turn-gated at all -- Showdown isn't sequential the way a
   * betting round is; anyone can act whenever ready, the same pattern
   * already used for Discard/Stand Pat. Lets a player who sees they can't
   * win, or simply doesn't want to reveal a bluff, bow out without
   * revealing their hand. Same effect as always: excludes them from
   * claiming or being included in any split allocation.
   * CHANGED 8.1 (§5.11): `Declare` gets the exact same non-turn-gated
   * treatment as Showdown, per spec -- "not folded-gated separately from
   * Fold's existing Showdown-phase rule." A fold during Declare also
   * removes that player from the active-player count `Declare` is
   * waiting on, so it can complete the phase on its own if they were the
   * last one still needing to declare.
   * Falls through to the normal turn-gated betting-round fold for every
   * other situation, unchanged, EXCEPT the deal-interrupt bypass and the
   * Stud-only Bring-In restriction just below.
   */
  fold(requesterId) {
    // NEW 8.1 (§5.10 extension): the affected player's Fold half of
    // Baseball's Pay-or-Fold decision -- "the existing Fold primitive,
    // unchanged," per spec, but it has to bypass the normal turn-gate
    // entirely here, since a deal-interrupt pause happens BEFORE betting
    // even opens for that street (bettingOpen is false, there's no
    // "turn" to be gated by at this moment at all). Resolves the
    // interrupt and resumes the paused deal loop exactly like
    // pay/buy/decline do -- see _continueDeal().
    if (this._pendingDealInterrupt && this._pendingDealInterrupt.playerId === requesterId) {
      const player = this.getPlayer(requesterId);
      if (!player) return { ok: false, error: 'Player not found.' };
      player.folded = true;
      this._pendingDealInterrupt = null;
      return this._continueDeal(this._dealQueue || []);
    }

    if (isPhaseGated(this.profile) && (this.handPhase === 'Showdown' || this.handPhase === 'Declare')) {
      const player = this.getPlayer(requesterId);
      if (!player) return { ok: false, error: 'Player not found.' };
      if (player.folded) return { ok: false, error: "You've already folded." };
      if (player.sittingOut) return { ok: false, error: "You're sitting out and can't fold." };
      player.folded = true;
      // NEW 9.0 (§6.10): folding removes eligibility for every pot,
      // including ones already contributed to -- recompute immediately,
      // even here at Showdown, since Fold at Showdown (§6.4) can still
      // change who's eligible for an as-yet-unclaimed side pot.
      // NEW 9.1: the uncalled-bet refund check runs on every fold too,
      // even this late-game one -- see _checkUncalledBetRefund()'s doc
      // comment. Both now apply to every phase-gated profile as of 9.4.
      this._checkUncalledBetRefund();
      this._recomputePots();
      if (this.handPhase === 'Declare') this._maybeAdvanceFromDeclare();
      return { ok: true };
    }

    // NEW 7.0 (§6.8): the first case in the app where Fold becomes
    // unavailable to a specific seat for a specific forced action --
    // Stud's selected opening bettor can't fold their forced Bring-In on
    // StreetABetting; they must Call (pay it) or Raise. Cleared the
    // instant that action resolves (see call()/placeBet() above), so this
    // never blocks Fold for them again this street, let alone any later one.
    if (this.profile === 'stud' && this._bringInObligationId === requesterId) {
      return { ok: false, error: "The Bring-In can't be folded -- call or raise." };
    }

    const guard = this._requireActingPlayer(requesterId);
    if (guard.error) return { ok: false, error: guard.error };
    guard.player.folded = true;

    this._actedSinceRaise.add(guard.player.id);
    // NEW 9.1 (§6.10): the uncalled-bet refund check -- fires on every
    // fold, before the next pot-tier recomputation, per spec.
    this._checkUncalledBetRefund();
    this._recomputePots(); // NEW 9.0 (§6.10), extended 9.4
    this.currentTurnPlayerId = this._nextTurnPlayerId();
    this._maybeCloseBettingRound();
    return { ok: true };
  }

  /**
   * Dealer manually flags one player as owing a specific ante/blind
   * amount (0 clears it). Kept functionally unrestricted here regardless
   * of the active preset's `reAnteable` flag (v4.2 §6.1) -- `reAnteable`
   * only controls whether the Dealer's Rail *shows* this control
   * (reAnteable: true keeps it visible, for mid-hand re-ante scenarios
   * Advance can't trigger on its own); it doesn't change what the server
   * accepts, consistent with every other profile/preset-gated primitive
   * in this app (Discard, Deal to Specific Player, Burn) being UI
   * decluttering only, never a server-side block.
   */
  setAnteBlind(requesterId, playerId, amount) {
    const dealer = this.getDealer();
    if (!dealer || dealer.id !== requesterId) {
      return { ok: false, error: 'Only the Dealer can set an ante/blind.' };
    }
    const target = this.getPlayer(playerId);
    if (!target) return { ok: false, error: 'Player not found.' };
    if (!Number.isInteger(amount) || amount < 0) {
      return { ok: false, error: 'Ante/blind amount must be a non-negative whole number.' };
    }
    target.oweAnte = amount;
    return { ok: true };
  }

  postAnteBlind(requesterId) {
    const player = this.getPlayer(requesterId);
    if (!player) return { ok: false, error: 'Player not found.' };
    // FIXED 11.2 (Fix 2, defense-in-depth half): the required fix is
    // oweAnte actually being reset by _performFullReset() (see its own
    // comment) -- this phase gate is an additional, independent
    // safeguard so this endpoint can't be exploited through some OTHER
    // stale-per-player-field-surviving-a-reset bug in the future, the
    // same category of issue as the one that motivated the required
    // fix. Scoped to phase-gated profiles only: the legacy no-Game-
    // Choice "flexible toolbox" mode never transitions `handPhase` away
    // from its constructor default ('PreGame') at all -- it has no real
    // phase machine to gate against in the first place (confirmed by an
    // existing pre-11.2 test exercising postAnteBlind() in exactly that
    // mode; gating unconditionally broke it).
    if (isPhaseGated(this.profile) && this.handPhase !== 'RequestAntes') {
      return { ok: false, error: 'Ante/blind posting is only available during the Ante Phase.' };
    }
    if (player.oweAnte <= 0) return { ok: false, error: "You don't owe an ante/blind." };
    // REVERTED 10.4 (the-cut-spec_v10-4.md B.2, superseding the 10.3
    // partial-post fix): the partial-post approach shipped in 10.3
    // broke a real invariant this codebase depends on -- blind-seat
    // IDENTITY (who's Small/Big Blind) is deliberately never persisted
    // (computed fresh by _computeBlindSeats(), called once during
    // _autoApplyAnte() and again, independently, inside openBetting()).
    // Before 10.3, nothing could ever drop a Player's chips from
    // positive to exactly 0 in the gap between those two calls; the
    // partial-post fix made that possible (a Player can go all-in
    // posting their OWN blind), and a second _computeBlindSeats() call
    // running after that could compute a DIFFERENT Big Blind than the
    // one who actually posted -- live-confirmed to cascade into: the
    // real Big Blind never dealt in, the wrongly-recomputed "Big Blind"
    // skipped as an actor entirely, and that Player's currentBet seeded
    // to an amount they never posted. Two live, cascading, money-
    // affecting defects from one change is enough evidence this
    // approach needs to not exist, not a third attempt at containing
    // it -- reverted outright rather than patched further.
    if (player.oweAnte > player.chips) {
      return { ok: false, error: 'Not enough chips to post the ante/blind.' };
    }
    const amount = player.oweAnte;
    player.chips -= amount;
    this.pot += amount;
    player.oweAnte = 0;
    player.totalContributedThisHand = (player.totalContributedThisHand || 0) + amount; // NEW 9.0 (§6.10)
    this._maybeAdvanceFromRequestAntes();
    return { ok: true };
  }

  /**
   * NEW 10.4 (the-cut-spec_v10-4.md B.2 replacement): with the 10.3
   * partial-post fix reverted, a seated Player who owes more than they
   * have goes back to being a genuine dead end -- RequestAntes can never
   * advance past them (_maybeAdvanceFromRequestAntes() waits for every
   * active Player's oweAnte to reach 0), and there was previously no
   * recovery path short of the Table-Owner-only Function 1. This is the
   * additive piece: a Dealer-level (not Table-Owner-only) misdeal
   * specifically for this stuck state, reusing the exact same
   * _forceTerminateCurrentHand() reset Function 1 already uses and this
   * same version already re-verified correct -- leans entirely on
   * already-proven machinery, nothing new being trusted for the first
   * time.
   *
   * Deliberately gated to the genuinely stuck case, not offered any time
   * RequestAntes is active -- see _stuckAntePlayers()'s own doc comment.
   */
  misdealStuckAntes(requesterId) {
    const dealer = this.getDealer();
    if (!dealer || dealer.id !== requesterId) {
      return { ok: false, error: 'Only the Dealer can misdeal.' };
    }
    if (this.handPhase !== 'RequestAntes') {
      return { ok: false, error: 'Misdeal is only available while stuck at ante/blind collection.' };
    }
    const stuck = this._stuckAntePlayers();
    if (stuck.length === 0) {
      return { ok: false, error: "Nothing is stuck -- every seated player can still post normally." };
    }
    this._forceTerminateCurrentHand();
    const names = stuck.map((p) => p.name).join(', ');
    const verb = stuck.length === 1 ? 'owes' : 'owe';
    this._queueAnnouncement(
      `Misdeal -- ${names} ${verb} more than they can post. Sit Out or Buy More Chips before the Dealer deals again.`
    );
    return { ok: true };
  }

  /**
   * NEW 10.4 (B.2 replacement): every seated Player who currently owes
   * an ante/blind they can never cover -- the exact condition that makes
   * RequestAntes a genuine dead end rather than just "still waiting on
   * someone." Shared between misdealStuckAntes() (server enforcement)
   * and toRedactedState (client visibility for the misdeal control),
   * per the Standing Convention this version establishes.
   */
  _stuckAntePlayers() {
    if (this.handPhase !== 'RequestAntes') return [];
    return this.players.filter((p) => p.oweAnte > p.chips);
  }

  /**
   * CHANGED 5.0 (§6.4): the "next active player in turn order" approver
   * (used when the Dealer themselves proposes) now skips sitting-out
   * players -- BUG FIX: previously it didn't, meaning a sitting-out
   * (possibly AFK) player could become the required approver and stall
   * the whole claim. Mirrors the same skip-sitting-out pattern already
   * used for blind assignment.
   * CHANGED 5.3 (§6.5): for the Draw profile, `claimPot` is no longer
   * strictly `Showdown`-only -- it's now also available from ANY earlier
   * phase the instant exactly one active (non-folded, non-sitting-out)
   * player remains. Previously, a lone remaining active player (everyone
   * else already folded) still had to be walked through every remaining
   * phase (Discard, Draw, 2nd Betting) before actually claiming, even
   * though the outcome was already decided. An approved early claim ends
   * the Hand immediately (`resolveClaim` already transitions to
   * `CycleComplete` unconditionally on approval, regardless of which
   * phase it fired from -- no change needed there). General
   * phase-machine behavior, not Draw-specific in itself -- extended to
   * Hold'em in 6.0 and to Stud in 7.0, both flagged explicitly in the
   * spec as an easy-to-miss required gate extension.
   *
   * NEW 8.2 (§6.5): `carryAmount` -- the dollar amount, if any, marked
   * "Carry to Next Game" rather than allocated to a player. Defaults to
   * 0 (no carry), matching every pre-8.2 call site's behavior exactly.
   * The existing "allocations must sum exactly to the pot" check now
   * includes it: `sum(allocations) + carryAmount === pot`. Finally
   * implements what `stud-7card-high-chicago`/`stud-7card-low-chicago`'s
   * own rules text has always promised ("any pot not allocated carries
   * over") but the claim mechanism had no way to actually do until now.
   * Available on every claim, not gated to split-pot/`declareHighLowBoth`
   * presets specifically -- one mechanism, no special-casing, per spec.
   */
  /**
   * NEW 9.0 (§6.10): when `this.pots` is populated, the "current" pot is
   * whichever unclaimed pot has the HIGHEST id -- strict Last-Pot-First,
   * matching how the pots actually resolved in reality (most recently
   * created money first, id 0 / Main Pot last). Returns `null` when
   * `this.pots` isn't populated (the ordinary single-pot case) or every
   * pot is already claimed.
   */
  _currentClaimablePot() {
    if (!Array.isArray(this.pots) || this.pots.length === 0) return null;
    const unclaimed = this.pots.filter((p) => !p.claimed);
    if (unclaimed.length === 0) return null;
    return unclaimed.reduce((top, p) => (p.id > top.id ? p : top), unclaimed[0]);
  }

  claimPot(requesterId, allocations, carryAmount = 0) {
    const proposer = this.getPlayer(requesterId);
    if (!proposer) return { ok: false, error: 'Player not found.' };
    if (this.pendingClaim) return { ok: false, error: 'A claim is already pending approval.' };

    // NEW 9.0 (§6.10): multi-pot mode, reusing this exact mechanism once
    // per pot, strict Last-Pot-First. `currentPot` is null in the
    // ordinary single-pot case (this.pots not populated).
    const multiPot = Array.isArray(this.pots) && this.pots.length > 0;
    let currentPot = null;
    if (multiPot) {
      currentPot = this._currentClaimablePot();
      if (!currentPot) return { ok: false, error: 'Every pot has already been claimed.' };
    }
    const potAmount = multiPot ? currentPot.amount : this.pot;

    // CHANGED 10.1 (the-cut-spec_v10-1.md §8.2, defects 7/8/9): ONE call
    // to the shared _currentClaimEligiblePlayerIds() now governs the
    // proposer, every allocation recipient, and the single-eligible-
    // player early-claim count below -- previously three independent
    // hand-rolled combinations (the ordinary single-pot case in
    // particular had NO eligibility check on the proposer or recipients
    // beyond folded/sittingOut, and no provenLosers exclusion at all --
    // a real gap this unification closes, not just a refactor). See
    // _currentClaimEligiblePlayerIds()'s own doc comment for exactly
    // what it does and doesn't touch (Side Pot computation itself is
    // untouched, per §0).
    const eligibleIds = this._currentClaimEligiblePlayerIds();
    if (!eligibleIds.includes(proposer.id)) {
      return {
        ok: false,
        error: multiPot ? `You're not eligible for ${currentPot.label}.` : "You're not eligible to claim the pot.",
      };
    }

    if (isPhaseGated(this.profile) && this.handPhase !== 'Showdown') {
      if (eligibleIds.length !== 1) {
        return {
          ok: false,
          error: "The pot can only be claimed at Showdown, or earlier if you're the only eligible player left for it.",
        };
      }
    }
    if (potAmount <= 0) return { ok: false, error: 'There is nothing in this pot to claim.' };

    if (!Number.isInteger(carryAmount) || carryAmount < 0) {
      return { ok: false, error: 'Carry to Next Game must be a non-negative whole-dollar amount.' };
    }
    if (!Array.isArray(allocations) || (allocations.length === 0 && carryAmount === 0)) {
      return { ok: false, error: 'Allocate at least one recipient.' };
    }
    const seen = new Set();
    let total = 0;
    for (const entry of allocations) {
      if (!entry || typeof entry.playerId !== 'string' || !Number.isInteger(entry.amount) || entry.amount <= 0) {
        return { ok: false, error: 'Each allocation needs a player and a positive whole-dollar amount.' };
      }
      if (seen.has(entry.playerId)) {
        return { ok: false, error: 'Each player can only appear once in the allocation.' };
      }
      seen.add(entry.playerId);
      const recipient = this.getPlayer(entry.playerId);
      if (!recipient) return { ok: false, error: 'Allocation includes an unknown player.' };
      if (!eligibleIds.includes(entry.playerId)) {
        return {
          ok: false,
          error: multiPot
            ? `${recipient.name} isn't eligible for ${currentPot.label}.`
            : `${recipient.name} isn't eligible to receive part of the pot.`,
        };
      }
      total += entry.amount;
    }
    if (total + carryAmount !== potAmount) {
      return {
        ok: false,
        error: `Allocations (plus any Carry to Next Game amount) must sum exactly to ${multiPot ? currentPot.label : 'the pot'} ($${potAmount}).`,
      };
    }

    const dealer = this.getDealer();
    if (!dealer) return { ok: false, error: 'No Dealer is assigned to approve claims right now.' };

    let approverId;
    if (proposer.id === dealer.id) {
      const dealerIdx = this.turnOrder.indexOf(dealer.id);
      // NEW 5.3: generalized approver fallback. First choice is still the
      // next ACTIVE (not folded, not sitting-out) seat to the Dealer's
      // left. If none exists at all -- the Dealer is the sole active
      // player, exactly the case the early-claim shortcut is built for --
      // fall back to the first FOLDED seat to the Dealer's left instead.
      // Sitting-out players are never eligible either way (assumed AFK),
      // in either search. A general fallback rule, not scoped just to
      // the early-claim case -- it applies wherever "Dealer proposed, no
      // active approver available" arises.
      let approver = null;
      for (let step = 1; step <= this.turnOrder.length; step++) {
        const candidate = this.getPlayer(this.turnOrder[(dealerIdx + step) % this.turnOrder.length]);
        // CHANGED 10.2 (the-cut-spec_v10-2.md §9.3 item 7): routed
        // through _isHandParticipant() -- previously
        // `!candidate.sittingOut && !candidate.folded` alone, with no
        // dealt-in check, could select a never-dealt Player with zero
        // stake in the hand to approve a real money claim.
        if (candidate && this._isHandParticipant(candidate) && candidate.id !== dealer.id) {
          approver = candidate;
          break;
        }
      }
      if (!approver) {
        for (let step = 1; step <= this.turnOrder.length; step++) {
          const candidate = this.getPlayer(this.turnOrder[(dealerIdx + step) % this.turnOrder.length]);
          if (candidate && !candidate.sittingOut && candidate.folded && candidate.id !== dealer.id) {
            approver = candidate;
            break;
          }
        }
      }
      // NEW 5.3, open gap logged not resolved: if every other seated
      // player is sitting out (none folded), this can still come up
      // empty -- genuinely nobody eligible. Deferred to a future Table
      // Management interface, not solved here.
      if (!approver) return { ok: false, error: 'No eligible player is available to approve this claim.' };
      approverId = approver.id;
    } else {
      approverId = dealer.id;
    }

    this.pendingClaim = {
      proposerId: proposer.id,
      allocations: allocations.map((a) => ({ playerId: a.playerId, amount: a.amount })),
      approverId,
      carryAmount, // NEW 8.2 (§6.5)
      potId: multiPot ? currentPot.id : null, // NEW 9.0 (§6.10) -- null in the ordinary single-pot case
    };
    return { ok: true };
  }

  resolveClaim(requesterId, approve) {
    if (!this.pendingClaim) return { ok: false, error: 'There is no pending claim to resolve.' };
    if (requesterId !== this.pendingClaim.approverId) {
      return { ok: false, error: 'Only the designated approver can resolve this claim.' };
    }

    if (approve) {
      for (const { playerId, amount } of this.pendingClaim.allocations) {
        const recipient = this.getPlayer(playerId);
        if (recipient) recipient.chips += amount;
      }
      // CHANGED 8.2 (§6.5): the pot decreases by exactly what's paid out
      // -- any amount marked Carry to Next Game simply stays in
      // `this.pot`, the one other case (alongside a rejected claim
      // leaving the pot untouched) where it doesn't fully clear.
      // CHANGED 9.0 (§6.10): expressed as a decrement rather than a hard
      // reset to `carryAmount`, since a multi-pot hand can have earlier
      // (higher-id) pots already claimed and paid out before this one --
      // `this.pot -= paidOut` is exactly equivalent to the old
      // `this.pot = carryAmount` in the single-pot case (allocations +
      // carry always summed to the pot being claimed), and generalizes
      // correctly when more than one pot claim happens across a hand.
      const paidOut = this.pendingClaim.allocations.reduce((sum, a) => sum + a.amount, 0);
      this.pot -= paidOut;

      // NEW 9.0 (§6.10): multi-pot mode -- mark just this one pot
      // claimed and leave it visible (dimmed/"Claimed" client-side),
      // rather than ending the hand. The hand only fully resolves once
      // EVERY pot has been claimed, in strict Last-Pot-First order.
      const multiPot = Array.isArray(this.pots) && this.pots.length > 0 && this.pendingClaim.potId !== null;
      let allPotsResolved = true;
      if (multiPot) {
        const pot = this.pots.find((p) => p.id === this.pendingClaim.potId);
        if (pot) {
          pot.claimed = true;
          // NEW 9.6 (§6.10): anyone eligible for THIS pot who did not
          // receive a positive allocation from it is now PROVEN to lose
          // the hand -- excluded from every remaining (lower-id) pot's
          // eligibility too, from here forward. Recipients are only ever
          // listed in `allocations` with a positive amount (validated in
          // claimPot), so "eligible but absent from the recipient list"
          // is exactly "received $0."
          const recipientIds = new Set(this.pendingClaim.allocations.map((a) => a.playerId));
          for (const id of pot.eligiblePlayerIds) {
            if (!recipientIds.has(id)) this.provenLosers.add(id);
          }
        }
        allPotsResolved = this.pots.every((p) => p.claimed);
      }

      if (allPotsResolved) {
        this.bettingOpen = false;
        this.currentBetToCall = 0;
        for (const player of this.players) {
          player.currentBet = 0;
          player.folded = false;
          player.allIn = false; // NEW 9.0 (§6.11) -- cleared on the same lifecycle as folded, fresh for the next hand
          player.bettingCapped = false; // NEW 9.1 (§6.10)
          player.totalContributedThisHand = 0; // NEW 9.0 (§6.10)
        }
        this.pots = null; // NEW 9.0 -- fresh slate; the next hand starts with no pot tiers
        this.idle = true; // the moment a claim resolves, even before any next-hand trigger (§4.1)
        // CHANGED 8.3 (§14 item 17): narrowed from all three phase-gated
        // profiles to Hold'em only, and further restricted to only open
        // when the claim resolved via an early claim (§5.3/§6.5, one
        // active player remaining) BEFORE the River was dealt -- a full
        // run to Showdown, or an early claim on/after River, never offers
        // it, since every community card is already visible by then and
        // there's nothing left to "hunt."
        // BUG FIX 8.4 (§5.9/§14 item 17, specification bug, not a build
        // bug -- the 8.3 spec itself defined this wrong): checking
        // `handPhase` against a list of phase NAMES was checking the wrong
        // thing. Reaching the phase `River` does NOT mean the river card
        // has been dealt -- `River` is the phase the Dealer is about to
        // deal it FROM (dealCommunity() requires handPhase already be
        // 'River'/'Flop'/'Turn' before it deals anything at all, same
        // reasoning as Stud's un-suffixed `StreetX` phases). Hold'em's
        // `TurnBetting -> River` transition is unconditional the moment a
        // betting round closes, even down to a single surviving player who
        // already acted earlier in that same round -- a hand that folded
        // down to one player mid-TurnBetting could close normally and land
        // on `handPhase === 'River'` with the river never actually shown,
        // and the old phase-name check wrongly withheld Rabbit Hunt in
        // exactly that case. Checking the community card COUNT directly
        // is both correct and simpler -- no phase-name enumeration needed,
        // and it can never be fooled by a phase name that doesn't actually
        // reflect what's been dealt.
        const isEarlyClaimBeforeRiver = this.profile === 'holdem' && this.communityCards.length < 5;
        this.rabbitHuntAvailable = isEarlyClaimBeforeRiver;
        // CHANGED 10.1 (the-cut-spec_v10-1.md §8.3 defect 11): queued
        // Sit-In intent resolved here immediately, at the exact instant
        // idle becomes true -- but queued Sit-Out intent previously did
        // NOT, only resolving later at the next deal()/_performFullReset()
        // call. That asymmetry left a real window, right here, where a
        // Player who already declared "sitting out next game" was still
        // treated as available -- including as a Pass-the-Buck recipient,
        // since passTheBuck() only runs while idle (confirmed safe per
        // §8.3, gated on table-wide idle state) and idle is now true.
        // Resolving both together, symmetrically, the instant idle
        // transitions, closes that window at its actual source rather
        // than patching passTheBuck()'s own candidate scan.
        this._applyPendingSitOuts();
        this._applyPendingSitIns();
        if (isPhaseGated(this.profile)) this._setHandPhase('CycleComplete');
      }
    }
    this.pendingClaim = null;
    return { ok: true };
  }

  revealHand(requesterId) {
    const player = this.getPlayer(requesterId);
    if (!player) return { ok: false, error: 'Player not found.' };
    player.revealed = true;
    return { ok: true };
  }

  setTableName(requesterId, name) {
    if (requesterId !== this.creatorId) {
      return { ok: false, error: 'Only the table creator can rename the table.' };
    }
    const trimmed = (typeof name === 'string' ? name : '').trim().slice(0, MAX_TABLE_NAME_LENGTH);
    this.name = trimmed || null;
    return { ok: true };
  }

  /**
   * NEW 4.5 (§10.1): the optional dollar amount that triggers an
   * automatic Buy Chips prompt for anyone entering the table below it.
   * Creator-only, mirroring setTableName's permission pattern -- the
   * spec explicitly flags this as an assumption, not an explicit
   * decision, since post-creation editability wasn't confirmed. `null`
   * (or any non-positive value) clears it.
   */
  setSuggestedBuyIn(requesterId, amount) {
    if (requesterId !== this.creatorId) {
      return { ok: false, error: 'Only the table creator can set the suggested buy-in.' };
    }
    if (amount === null || amount === undefined || amount === '') {
      this.suggestedBuyIn = null;
      return { ok: true };
    }
    if (!Number.isInteger(amount) || amount < 0) {
      return { ok: false, error: 'Suggested buy-in must be a non-negative whole number.' };
    }
    this.suggestedBuyIn = amount > 0 ? amount : null;
    return { ok: true };
  }

  buyChips(requesterId, amount) {
    const player = this.getPlayer(requesterId);
    if (!player) return { ok: false, error: 'Player not found.' };
    if (!Number.isInteger(amount) || amount <= 0) {
      return { ok: false, error: 'Buy-in amount must be a positive whole number.' };
    }
    // CHANGED 10.4 (Standing Convention / B.3): both gate checks now
    // route through the shared _canBuyChips() -- see its own doc
    // comment. No behavior change from 10.3's own logic, only removing
    // the second, independent copy of it.
    if (!this._canBuyChips(player)) {
      return this._isPending(player)
        ? { ok: false, error: "Can't buy chips while your outcome for this hand is still pending." }
        : { ok: false, error: "Can't buy chips -- you're already committed to the hand being formed." };
    }
    // CHANGED 9.6: the NEW-9.2 auto-return-from-sitting-out logic here is
    // removed -- it existed to handle a player automatically sat out for
    // $0 chips buying back in, but that mechanism itself is gone as of
    // 9.6 (a $0-chip player was never actually "sitting out" -- see
    // _activePlayers()'s comment). A player CAN still be genuinely
    // sitting out (their own voluntary Sit Out, or disconnected) with
    // $0 chips at the same time, purely by coincidence -- buying chips
    // in that case correctly does NOT auto-return them; a manual Sit In
    // is still required, exactly as for any other voluntary sit-out.
    bankBuyChips(player, amount); // NEW 8.0 (§4) -- delegates to the Player/Bank module, the only place chips/totalBuyIn are mutated on a buy-in
    return { ok: true };
  }

  /**
   * NEW 8.0 (ARCHITECTURE_v8.md §4), not yet called anywhere. Thin
   * passthroughs to the Player/Bank module's snapshot capability, at the
   * natural call site (GameTable owns `this.players`). Exist now so a
   * future hand/cycle undo feature (master spec §14 item 16) has
   * something to build on without a second pass through this module --
   * not itself the undo feature, which isn't scoped or built this release.
   */
  snapshotBank() {
    return snapshotPlayers(this.players);
  }

  restoreBank(snap) {
    restorePlayers(this.players, snap);
  }

  /**
   * NEW 5.0 (§9): Dealer and sitting-out are now mutually exclusive
   * states -- a player holding the Dealer role can't use Sit Out at all
   * (neither mode), full stop. They must Pass the Buck first; only then
   * does Sit Out become available to them, same as anyone else. Closes a
   * real gap: without this, a sitting-out (possibly AFK) Dealer could
   * stall the whole table -- nobody else can deal, open betting, or
   * otherwise run the hand. Universal, not Draw-specific.
   */
  sitOut(requesterId, mode) {
    const player = this.getPlayer(requesterId);
    if (!player) return { ok: false, error: 'Player not found.' };
    if (player.isDealer) return { ok: false, error: "The Dealer can't sit out -- Pass the Buck first." };
    if (player.sittingOut) return { ok: false, error: 'Already sitting out.' };
    if (mode !== 'foldAndSitOut' && mode !== 'sitOutNextGame') {
      return { ok: false, error: 'Invalid sit-out mode.' };
    }

    if (mode === 'sitOutNextGame') {
      player.sitOutPending = true;
      return { ok: true };
    }

    // CHANGED 10.1 (the-cut-spec_v10-1.md §8.3 defect 10): the fold
    // condition used to be `this.bettingOpen && !player.folded` -- true
    // only if a betting round happened to be open at the EXACT instant
    // this was called. Outside a betting window (mid-Discard-phase,
    // mid-Declare-phase, between streets) a Player could "Fold and Sit
    // Out" while still holding a live, unresolved hand -- contradicting
    // the button's own label, and producing two further inconsistencies
    // with §2.5's truth table: they'd stay pot-eligible despite being
    // marked sitting out, and Buy Chips would stay incorrectly blocked
    // for them (since _isPending() only excludes on `folded`, never
    // `sittingOut` itself) despite the table stating Buy Chips should
    // always be available while sitting out.
    //
    // The correct condition is _canAct(): does this Player currently
    // hold a real, actionable, UNRESOLVED stake, regardless of whether
    // literal betting happens to be open right now? If they're already
    // all-in/bettingCapped, there is nothing left to fold FROM -- their
    // stake is already locked in and forcing folded=true on them would
    // incorrectly zero out real pot equity, a worse bug than the one
    // being fixed. _canAct() is exactly this distinction: dealt in, not
    // already folded/sitting out, and NOT all-in/bettingCapped.
    // NEW 11.0: this unconditional-fold rule is _foldForSitOut() below --
    // sitOut()'s own explicit "Fold and Sit Out" choice, distinct from
    // the involuntary "check if free" rule expireDisconnectGrace() uses
    // (_resolveAbsentPlayerTurn()) for a disconnect timeout.
    this._foldForSitOut(player);
    player.sittingOut = true;
    player.sitOutPending = false;
    return { ok: true };
  }

  /**
   * Opts back in. CHANGED 4.2 (§9): if a hand is in progress
   * (`idle === false`), this no longer takes effect immediately -- it
   * sets `sitInPending`, auto-resolved by `_applyPendingSitIns()` the
   * next time idle becomes true (an approved claim or a Reshuffle).
   * While idle, behavior is unchanged from 4.1: immediate.
   */
  /**
   * NEW 9.2 (§9), CHANGED 9.6: originally shared by sitIn() and
   * buyChips()'s auto-clear for the $0-chips case -- that auto-clear is
   * gone as of 9.6 (a $0-chip player was never actually sittingOut to
   * begin with, see _activePlayers()'s own comment), so this is now
   * sitIn()'s own helper alone. Kept as a separate method regardless --
   * still a real, reusable idle-vs-mid-hand branch, and removing the
   * abstraction now would just mean re-inlining it if anything else
   * ever needs the same "return from sitting out" logic later.
   */
  _returnFromSitOut(player) {
    if (this.idle) {
      player.sittingOut = false;
    } else {
      player.sitInPending = true;
    }
  }

  sitIn(requesterId) {
    const player = this.getPlayer(requesterId);
    if (!player) return { ok: false, error: 'Player not found.' };
    if (!player.sittingOut) return { ok: false, error: 'You are not sitting out.' };
    if (player.sitInPending) return { ok: false, error: 'Already rejoining next hand.' };

    this._returnFromSitOut(player);
    return { ok: true };
  }

  /**
   * Redacted view of one player's hand for a given viewer. Full
   * visibility if it's the viewer's own hand or that player has
   * revealed. Otherwise: NEW 4.0 -- per-card redaction rather than
   * all-or-nothing. The array is always the same length as the real
   * hand; each entry is either the full card (if that specific card's
   * faceUp is true -- a Stud up-card, visible to everyone per spec §5.3)
   * or a bare `{ faceUp: false }` stub carrying no suit/rank/id.
   */
  _redactedHand(player, forPlayerId) {
    if (player.id === forPlayerId || player.revealed) return player.hand;
    return player.hand.map((card) => (card.faceUp ? card : { faceUp: false }));
  }

  toRedactedState(forPlayerId) {
    return {
      code: this.code,
      name: this.name || this.code,
      creatorId: this.creatorId,
      // NEW 11.0 (Part B): the Table Owner Settings dialog's own value --
      // exposed to everyone (harmless, and the client needs it to render
      // "will fold in Ns" countdown text for any disconnected Player, not
      // just the Table Owner).
      reconnectTimeoutSeconds: this.reconnectGraceSeconds,
      // NEW 11.0 (Part H.2): when the table will auto-close if no real
      // activity happens before then. The client derives its own T-5min
      // banner and T-1min Table-Owner popup purely by comparing this to
      // its own clock -- never pushed as separate one-off messages.
      tableCloseAt: this.lastActivityAt + this.inactivityTimeoutSeconds * 1000,
      // NEW 11.0 (Part D): Table Owner visibility into every seated
      // Player's own reconnect code, per the spec's explicit "read it to
      // them if their phone dies" rationale. `null` for everyone else --
      // a Player's own code is instead sent to them directly, once, at
      // join/reconnect time (see server.js), never repeated in the
      // broadcast state where every other seated Player would see it too.
      reconnectCodes: forPlayerId === this.creatorId ? Object.fromEntries(this.players.map((p) => [p.id, p.reconnectCode])) : null,
      suggestedBuyIn: this.suggestedBuyIn,
      includeJokers: this.includeJokers,
      deckCount: this.deck.length,
      currentTurnPlayerId: this.currentTurnPlayerId,
      pot: this.pot,
      bettingOpen: this.bettingOpen,
      currentBetToCall: this.currentBetToCall,
      pendingClaim: this.pendingClaim,
      communityCards: this.communityCards,
      gameChoiceId: this.gameChoiceId,
      profile: this.profile,
      gameOptions: this.gameOptions,
      reAnteable: this.reAnteable,
      advanceTurnRequired: this.advanceTurnRequired,
      burnAvailable: this.burnAvailable,
      requiresOpeners: this.requiresOpeners,
      finalStreet: this.finalStreet, // NEW 7.0 (§5.10) -- Stud only, drives 5-Card/7-Card banner text variant
      openingBettorId: this.openingBettorId, // NEW 7.0 (§6.8) -- Stud only
      bringInObligationId: this._bringInObligationId, // NEW 7.0 (§6.8) -- Stud only, drives client-side Fold gating
      hasKillCard: this.hasKillCard, // NEW 8.1 (§6.9) -- currently Stud/Black-Mariah only, drives the restyled New Hand button's visibility
      killCard: this.killCard, // NEW 8.1 (§6.9) -- display-only (e.g. "Qs"); client renders it human-readable
      // NEW 8.4 (§6.9): the server-computed mid-hand Kill Hand
      // visibility window (StreetABetting through the close of betting
      // on the last face-up street, per the active preset's own
      // `pattern`) -- eliminates the client-side duplicate
      // (`railTables.js`'s own hand-maintained copy) that caused the 8.3
      // regression (the client's copy never received the 8.2/8.3 fixes,
      // since it was never actually reading this server-side
      // computation in the first place). The client now just reads this
      // value directly instead of re-deriving it; there is exactly one
      // implementation of this window, in stud.js's
      // `isWithinKillHandWindow`, consulted here. Always `false` for a
      // non-`hasKillCard` preset or a non-Stud profile, same as before.
      killHandWindowOpen: this.hasKillCard ? !!getProfileTable(this.profile)?.isWithinKillHandWindow?.(this) : false,
      killHandConfirmPending: this.killHandConfirmPending, // NEW 8.2 (§6.9) -- drives the table-wide "about to kill" notice for everyone but the Dealer
      pendingDealInterrupt: this._pendingDealInterrupt, // NEW 8.1 (§5.10 extension) -- { playerId, triggerRank } | null; drives the affected player's Pay/Fold or Buy/Decline dialog
      burnedThisHand: this.burnedThisHand,
      rabbitHuntAvailable: this.rabbitHuntAvailable,
      rabbitHuntCards: this.rabbitHuntCards,
      idle: this.idle,
      bettingRoundsThisHand: this.bettingRoundsThisHand,
      discardWindowOpen: this.discardWindowOpen,
      handPhase: this.handPhase,
      // CHANGED 10.1 (the-cut-spec_v10-1.md §8.2/§8.3 defect 9): each pot
      // now also carries `liveEligiblePlayerIds` -- eligiblePlayerIds
      // (the raw, contribution-threshold Side-Pot *computation* result,
      // untouched) minus provenLosers. The per-pot hover text previously
      // read eligiblePlayerIds directly and never reflected a Player
      // excluded after losing a higher pot; this is the server-computed
      // answer the client now reads instead of re-deriving it.
      pots: Array.isArray(this.pots)
        ? this.pots.map((p) => ({ ...p, liveEligiblePlayerIds: p.eligiblePlayerIds.filter((id) => !this.provenLosers.has(id)) }))
        : this.pots, // NEW 9.0 (§6.10), Hold'em only -- null unless a genuine side-pot tier exists
      provenLosers: Array.from(this.provenLosers), // NEW 9.6 (§6.10) -- Set doesn't serialize over the wire, sent as an array
      // NEW 10.1 (the-cut-spec_v10-1.md §8.2, defects 7/8/9): the single
      // shared answer to "who can currently claim/receive the current
      // pot" and "is there actually a claimable pot right now" -- see
      // _currentClaimEligiblePlayerIds()/_claimWindowOpen()'s own doc
      // comments. The client reads these directly; it must never
      // re-derive either from folded/sittingOut/pot data itself.
      claimEligiblePlayerIds: this._currentClaimEligiblePlayerIds(),
      claimWindowOpen: this._claimWindowOpen(),
      // NEW 10.1 (defect 5): who can currently be selected as Stud's
      // opening bettor -- the exact same _canAct() the server itself
      // enforces in setOpeningBettor(). The client dropdown reads this
      // instead of independently re-deriving the same eligibility.
      eligibleOpeningBettorIds: this.players.filter((p) => this._canAct(p)).map((p) => p.id),
      // NEW 10.4 (the-cut-spec_v10-4.md Part E): whether ANY current hand
      // participant can act at all right now -- the same question
      // openBetting() itself now checks before enforcing Stud's opener
      // requirement (see its own comment). Exposed generally, not
      // Stud-specific in computation, so the client's Open Betting
      // control can distinguish "nobody selected yet" (still correctly
      // disabled) from "nobody CAN act -- betting will auto-skip"
      // (should be enabled, with different explanatory text), instead
      // of both cases looking identical (disabled, empty dropdown, no
      // explanation) the way they did before this version.
      anyHandParticipantCanAct: this.players.some((p) => this._isHandParticipant(p) && this._canAct(p)),
      // NEW 11.0 (Part I/Standing Convention): the same answer
      // startGame()/newHand() enforce server-side -- exposed so the
      // client can disable Start/New Hand with an explanation instead of
      // leaving them clickable and rejected after the fact.
      anyoneDisconnected: this._anyoneDisconnected(),
      // NEW 10.4 (B.2 replacement): who's stuck (owes more than they
      // have) right now, if anyone -- drives the Dealer's Misdeal
      // control visibility/enablement, per the Standing Convention
      // (never left disabled-with-no-explanation).
      stuckAntePlayerIds: this._stuckAntePlayers().map((p) => p.id),
      raiseCountThisRound: this.raiseCountThisRound, // NEW 9.0 (§6.10) -- Fixed-Limit raise-cap UI
      raiseCap: this.gameOptions?.raiseCap ?? null, // NEW 9.0
      bettingStructure: this.gameOptions?.bettingStructure ?? null, // NEW 9.0
      minRaiseIncrement: this._minRaiseIncrement, // NEW 9.0 (§6.10) -- UI surfacing of the current legal minimum raise
      // NEW 10.3 (the-cut-spec_v10-3.md Part A §3.3): a simple boolean,
      // true for every seated Player while a Pot Distribution batch is
      // open -- drives a standing "Table Owner functions have been
      // invoked, please stand by" banner for everyone but the Table
      // Owner themselves. A deliberately simplified stand-in for the
      // spec's own richer, sustained live-preview view (every staged
      // allocation, updated in real time, visible to every seated
      // Player) -- Mike explicitly authorized dropping that richer view
      // for this release if it proved to be too much, in favor of this
      // minimal indicator; see the README for why that trade was made.
      tableOwnerDistributionInProgress: !!this._pendingAllocationBatch,
      // The Table Owner's own full detail -- staged entries plus a live
      // preview of the resulting pot and every affected Player's chips,
      // computed fresh on every read, never persisted. `null` for every
      // other Player, and `null` when no batch is currently open, even
      // for the Table Owner themselves.
      pendingAllocationBatch: forPlayerId === this.creatorId && this._pendingAllocationBatch ? this._buildAllocationBatchPreview() : null,
      players: this.players.map((p) => ({
        id: p.id,
        name: p.name,
        isDealer: p.isDealer,
        handCount: p.hand.length,
        hand: this._redactedHand(p, forPlayerId),
        chips: p.chips,
        totalBuyIn: p.totalBuyIn,
        currentBet: p.currentBet,
        folded: p.folded,
        revealed: p.revealed,
        sittingOut: p.sittingOut,
        // NEW 11.0 (Part A/B): server-computed, client reads directly --
        // per the Standing Convention, never re-derived. `disconnectDeadline`
        // is a wall-clock ms timestamp (or null) so the client can render a
        // live countdown without the server needing to push a tick.
        connected: p.connected,
        disconnectDeadline: p.connected ? null : p.disconnectedAt + this.reconnectGraceSeconds * 1000,
        // NEW 9.6 (§9): computed, not persisted -- true whenever this
        // player's own $0 chips is why they're excluded from the current/
        // next hand, distinct from a genuine (voluntary or disconnected)
        // sittingOut. Server exposes this computed result directly
        // (rather than making the client re-derive "excluded because of
        // $0 chips" from chips/allIn/folded/sittingOut itself) per this
        // project's own standing principle: whenever a computation exists
        // on both server and client, the server computes it once and the
        // client just reads the result.
        excludedForZeroChips: !p.folded && !p.sittingOut && !p.allIn && p.chips === 0,
        // NEW 10.0 (the-cut-spec_v10-0.md §2.1): computed, not persisted --
        // see _isPending()'s own comment for the full definition. Drives
        // the client's Buy-Chips gating (§5.5) and is independent of
        // `allIn`/`bettingCapped` below, which answer different questions.
        pending: this._isPending(p),
        // NEW 10.4 (Standing Convention / B.3): the client's Buy Chips
        // button reads this directly instead of reconstructing it from
        // `pending` alone -- see _canBuyChips()'s own doc comment.
        canBuyChips: this._canBuyChips(p),
        // NEW 11.4 (Part D.3): same Standing Convention pattern as
        // canBuyChips above -- the client's Bet/All-In buttons read this
        // directly instead of reconstructing the check themselves. See
        // _canBetOrRaise()'s own doc comment, including the
        // GATE_BETTING_BUTTONS_WHEN_UNCALLABLE revert story.
        canBetOrRaise: this._canBetOrRaise(p),
        // NEW 10.1 (the-cut-spec_v10-1.md §8.2): the raw
        // _isHandParticipant() answer, exposed directly so the client
        // never has to reconstruct "dealt in, not folded, not sitting
        // out" from folded/sittingOut/handCount itself -- used for
        // Declare-eligibility display and the raise-cap/opponent-ceiling
        // hints, which previously re-derived the same combination inline
        // and (for the latter two) would have silently miscounted a
        // never-dealt $0-chip Player the same way the now-fixed
        // server-side call sites did.
        isHandParticipant: this._isHandParticipant(p),
        sitInPending: p.sitInPending,
        pendingDeparture: p.pendingDeparture, // NEW 11.0 (Part F.4)
        oweAnte: p.oweAnte,
        discardCountThisHand: p.discardCountThisHand,
        discardPhaseActed: p.discardPhaseActed,
        standingPat: p.standingPat,
        mucked: p.mucked,
        allIn: p.allIn, // NEW 9.0 (§3, §6.11), CLARIFIED 9.1 -- display-only as of 9.1, drives the "All-In" seat badge
        bettingCapped: p.bettingCapped, // NEW 9.1 (§3, §6.10) -- the functional turn-order exclusion, independent of allIn's own value
        totalContributedThisHand: p.totalContributedThisHand, // NEW 9.0 (§6.10)
        // NEW 8.1 (§5.11): redacted the same way hand contents are --
        // visible to the declaring player themselves always, and to
        // everyone else only once that player has used Show Cards
        // (p.revealed), matching the spec's own visibility rule ("shown
        // alongside their cards once they use Show Cards, not before").
        declaration: p.id === forPlayerId || p.revealed ? p.declaration : null,
      })),
    };
  }
}

// NEW 8.0 (ARCHITECTURE_v8.md §3): installs the action-dispatch wrapper
// on every state-changing action method, once, at module load time --
// see actionDispatch.js for the full reasoning and the exact method
// list. Deliberately done here (after the class body, before export)
// rather than via decorators on each method individually, so the
// manifest of wrapped methods lives in one place, visibly complete,
// instead of one `@dispatched`-style annotation per method that could
// individually be forgotten -- the same "a table wants an entry for
// everything, a gap is visible" reasoning as §2's profile tables,
// applied to actions instead of phases.
installActionDispatch(GameTable.prototype);

module.exports = { GameTable, MAX_PLAYERS, MIN_PLAYERS_TO_DEAL, GAME_CHOICES, DEFAULT_PRESET_FLAGS };
