// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

// Book sides. Competitive sides are sorted by limit; non-competitive sides are FIFO queues.
// BID holds abandonment-auction bids, sorted by surplus per unit, highest first.
uint8 constant SELL = 0;
uint8 constant BUY = 1;
uint8 constant NC_SELL = 2;
uint8 constant NC_BUY = 3;
uint8 constant BID = 4;

uint8 constant FLAG_ROLLOVER = 1;
uint8 constant FLAG_LOCKED = 2; // cannot be cancelled while it can still trade (commitment orders, e.g. seats)
uint8 constant FLAG_AUTOSELL = 4; // a closed pool's defaulted asset offered in the next expiry's pool; owner is the core

/// @notice One resting order. Ids are global and never reused.
/// - SELL / NC_SELL: `units` of asset escrowed; `limit` is the minimum price (0 for NC).
/// - BUY: `escrow` quote covers `units` at `limit` plus a 1-wei-per-remaining-batch rounding reserve.
/// - NC_BUY: `escrow` is the quote budget; `units` is unused.
/// - BID: `units` wanted, `limit` is surplus per whole asset, `escrow` covers units * (K + limit).
/// - ROLLOVER sells keep their asset in the old pool; `escrow` is the pre-funded top-up.
struct Order {
    address owner;
    uint32 deadline; // live while pool.settleCount < deadline
    uint8 side;
    uint8 flags;
    uint96 units;
    uint96 limit;
    uint64 prev;
    uint64 next;
    uint128 escrow;
}

struct Book {
    uint64 head;
    uint64 tail;
    uint32 count;
}

/// @notice Doubly linked ordered set with caller-supplied predecessor hints (Gnosis EasyAuction style).
/// The contract only verifies the position, so insertion is O(1) given a correct hint.
library OrderSet {
    /// @dev A hint may be stale because others inserted after it was computed; probe this many nodes forward.
    uint256 internal constant MAX_PROBE = 3;

    error InvalidHint();

    /// @notice Whether a new order with `limit` belongs after `existing`. Ties keep time priority (new goes after).
    function goesAfter(uint8 side, uint96 existingLimit, uint96 limit) internal pure returns (bool) {
        return side == SELL ? existingLimit <= limit : existingLimit >= limit;
    }

    function sorted(uint8 side) internal pure returns (bool) {
        return side == SELL || side == BUY || side == BID;
    }

    /// @notice Insert `id` into a sorted book after the position found from `hint` (0 = head).
    function insertSorted(Book storage b, mapping(uint64 => Order) storage os, uint64 id, uint64 hint) internal {
        Order storage o = os[id];
        uint8 side = o.side;
        uint96 limit = o.limit;
        uint64 prev;
        if (hint == 0) {
            if (b.head != 0 && goesAfter(side, os[b.head].limit, limit)) {
                // stale "insert at head" hint: probe from the head
                prev = b.head;
            } else {
                _link(b, os, id, 0);
                return;
            }
        } else {
            Order storage h = os[hint];
            if (h.owner == address(0) || h.side != side || !goesAfter(side, h.limit, limit)) revert InvalidHint();
            prev = hint;
        }
        uint256 probes;
        while (true) {
            uint64 nxt = os[prev].next;
            if (nxt == 0 || !goesAfter(side, os[nxt].limit, limit)) break;
            if (++probes > MAX_PROBE) revert InvalidHint();
            prev = nxt;
        }
        _link(b, os, id, prev);
    }

    function pushBack(Book storage b, mapping(uint64 => Order) storage os, uint64 id) internal {
        _link(b, os, id, b.tail);
    }

    function remove(Book storage b, mapping(uint64 => Order) storage os, uint64 id) internal {
        Order storage o = os[id];
        uint64 p = o.prev;
        uint64 n = o.next;
        if (p == 0) b.head = n;
        else os[p].next = n;
        if (n == 0) b.tail = p;
        else os[n].prev = p;
        b.count--;
        delete os[id];
    }

    /// @notice O(n) search for the correct predecessor. For off-chain use through eth_call.
    function findHint(Book storage b, mapping(uint64 => Order) storage os, uint8 side, uint96 limit)
        internal
        view
        returns (uint64 prev)
    {
        uint64 cur = b.head;
        while (cur != 0 && goesAfter(side, os[cur].limit, limit)) {
            prev = cur;
            cur = os[cur].next;
        }
    }

    function _link(Book storage b, mapping(uint64 => Order) storage os, uint64 id, uint64 prev) private {
        Order storage o = os[id];
        uint64 nxt = prev == 0 ? b.head : os[prev].next;
        o.prev = prev;
        o.next = nxt;
        if (prev == 0) b.head = id;
        else os[prev].next = id;
        if (nxt == 0) b.tail = id;
        else os[nxt].prev = id;
        b.count++;
    }
}
