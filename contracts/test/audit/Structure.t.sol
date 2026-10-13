// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {Base} from "../utils/Base.sol";

/// @notice Invariant 6 (ARCHITECTURE §2.11), checked on the deployed bytecode: no SELFDESTRUCT anywhere in the core
/// or its logic libraries, and the core's only DELEGATECALLs are the linked-library calls (no owner, no proxy).
contract StructureTest is Base {
    function _opcodes(bytes memory code) internal pure returns (bool selfdestruct, uint256 delegatecalls) {
        uint256 i;
        while (i < code.length) {
            uint8 op = uint8(code[i]);
            if (op == 0xff) selfdestruct = true;
            if (op == 0xf4) delegatecalls++;
            i += 1 + (op >= 0x60 && op <= 0x7f ? op - 0x5f : 0);
        }
    }

    function test_invariant6_noSelfdestruct_delegatecallOnlyIntoLibraries() public view {
        (bool sd, uint256 dc) = _opcodes(address(core).code);
        assertFalse(sd, "core has no SELFDESTRUCT");
        assertGt(dc, 0, "core delegates into the logic libraries");

        // every library the core links must itself be free of SELFDESTRUCT and DELEGATECALL
        address[3] memory libs = _linkedLibraries();
        for (uint256 i; i < 3; ++i) {
            assertGt(libs[i].code.length, 0, "library deployed");
            (bool lsd, uint256 ldc) = _opcodes(libs[i].code);
            assertFalse(lsd, "library has no SELFDESTRUCT");
            assertEq(ldc, 0, "library makes no DELEGATECALL");
        }
    }

    /// @dev Library addresses are PUSH20 immediates right before each DELEGATECALL in the core's code.
    function _linkedLibraries() internal view returns (address[3] memory out) {
        bytes memory code = address(core).code;
        uint256 n;
        address last;
        uint256 i;
        while (i < code.length && n < 3) {
            uint8 op = uint8(code[i]);
            if (op == 0x73) {
                uint160 a;
                for (uint256 j = 1; j <= 20; ++j) {
                    a = (a << 8) | uint8(code[i + j]);
                }
                address cand = address(a);
                if (cand != last && cand.code.length > 0 && cand != address(core)) {
                    bool seen;
                    for (uint256 k; k < n; ++k) {
                        if (out[k] == cand) seen = true;
                    }
                    if (!seen) out[n++] = cand;
                    last = cand;
                }
            }
            i += 1 + (op >= 0x60 && op <= 0x7f ? op - 0x5f : 0);
        }
        require(n == 3, "expected three linked libraries");
    }
}
