// Backs the "Swap Group" self-service flow (tourney_wizard_selfservice_swap,
// posted in the Slot-Manager panel). A player picks another team to swap
// places with; this tracks that request from the moment it's created until
// both team owners have responded.
//
// In-memory only, same pattern as pending-tournament-registrations.js — if
// the bot restarts mid-request, both owners just see the confirmation
// message go stale and someone can start a new swap from the panel again.
// Keyed by a short random ID (not a user ID) since two different owners'
// buttons both need to reference the same record.

const crypto = require('crypto');

const swaps = new Map();
const SWAP_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours for both owners to respond

function createSwap(data) {
  let swapId;
  do {
    swapId = crypto.randomBytes(4).toString('hex');
  } while (swaps.has(swapId));

  const timer = setTimeout(() => swaps.delete(swapId), SWAP_TTL_MS);
  // data first, defaults after — lets a caller pass an initial aDecision
  // (the self-service flow marks the requesting side accepted immediately,
  // since picking a team from the dropdown *is* that side's confirmation)
  // without it being clobbered by the default.
  swaps.set(swapId, { aDecision: null, bDecision: null, ...data, timer });
  return swapId;
}

function getSwap(swapId) {
  return swaps.get(swapId) || null;
}

function updateSwap(swapId, fields) {
  const entry = swaps.get(swapId);
  if (!entry) return null;
  Object.assign(entry, fields);
  return entry;
}

function deleteSwap(swapId) {
  const entry = swaps.get(swapId);
  if (entry && entry.timer) clearTimeout(entry.timer);
  swaps.delete(swapId);
}

module.exports = { createSwap, getSwap, updateSwap, deleteSwap };
