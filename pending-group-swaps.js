// Backs the "Swap Group" admin flow (tourney_wizard_swap_group).
//
// Two separate things are tracked here, both in-memory only (same pattern
// as pending-tournament-registrations.js — if the bot restarts mid-flow,
// whoever was mid-way through just starts over, nothing is lost from
// data.json since nothing is written there until a swap actually executes):
//
//   1. "Draft" — one admin picking Team A then Team B from the two
//      dropdowns. Keyed by the admin's own user ID since only they are
//      filling it in; short TTL because it's just two clicks.
//   2. "Swap request" — once both teams are picked, a confirmation embed
//      goes out with Accept/Reject buttons for each team owner. Keyed by a
//      short random ID (both owners' buttons reference the same record, so
//      it can't be keyed by a single user). Longer TTL since an owner might
//      not see the ping right away.

const crypto = require('crypto');

const drafts = new Map();
const DRAFT_TTL_MS = 10 * 60 * 1000; // 10 minutes to pick Team A + Team B

const swaps = new Map();
const SWAP_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours for both owners to respond

function setDraft(adminId, data) {
  clearDraft(adminId);
  const entry = {
    data,
    timer: setTimeout(() => drafts.delete(adminId), DRAFT_TTL_MS),
  };
  drafts.set(adminId, entry);
  return entry;
}

function getDraft(adminId) {
  const entry = drafts.get(adminId);
  return entry ? entry.data : null;
}

function clearDraft(adminId) {
  const entry = drafts.get(adminId);
  if (entry && entry.timer) clearTimeout(entry.timer);
  drafts.delete(adminId);
}

function createSwap(data) {
  let swapId;
  do {
    swapId = crypto.randomBytes(4).toString('hex');
  } while (swaps.has(swapId));

  const timer = setTimeout(() => swaps.delete(swapId), SWAP_TTL_MS);
  swaps.set(swapId, { ...data, aDecision: null, bDecision: null, timer });
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

module.exports = { setDraft, getDraft, clearDraft, createSwap, getSwap, updateSwap, deleteSwap };
