// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {ERC20} from "solady/tokens/ERC20.sol";
import {LibClone} from "solady/utils/LibClone.sol";
import {LibString} from "solady/utils/LibString.sol";
import {DateTimeLib} from "solady/utils/DateTimeLib.sol";
import {MetadataReaderLib} from "solady/utils/MetadataReaderLib.sol";
import {IConfluere} from "../interfaces/IConfluere.sol";
import {PoolKey} from "../libraries/PoolKey.sol";

/// @notice ERC-20 view of one Confluere ERC-6909 id (a C-Token or an R-Token), 1:1, for AMMs and other protocols.
/// Deployed as a deterministic clone per id; the core address and id are immutable clone arguments.
/// @dev Name and symbol follow the app's position names, derived from the pool key on every call:
/// symbol `C-WHYPE-16OCT` (lender token) / `R-WHYPE-16OCT` (buy-back right), name `Confluere C WHYPE/USDC 16 Oct 2026`.
/// On a grid whose expiries are less than a day apart (demo grids) both carry the UTC time, `-1400` / `, 14:00 UTC`.
/// Token symbols are read best-effort (100k gas, string or bytes32, anything else falls back to `?`) and filtered to
/// [A-Za-z0-9.], at most 16 characters, so a hostile asset can neither revert nor spoof these strings.
contract ERC6909Wrapper is ERC20 {
    error NotClone();

    function core() public view returns (IConfluere c) {
        (c,) = _args();
    }

    function id() public view returns (uint256 i) {
        (, i) = _args();
    }

    function name() public view override returns (string memory s) {
        (IConfluere c, uint256 i, PoolKey memory k) = _key();
        (uint256 y, uint256 mo, uint256 d, uint256 h, uint256 mi,) = DateTimeLib.timestampToDateTime(k.expiry);
        s = string.concat(
            "Confluere ",
            _side(i),
            " ",
            _sym(k.asset),
            "/",
            _sym(k.quote),
            " ",
            LibString.toString(d),
            " ",
            LibString.slice(_MONTHS, 3 * (mo - 1), 3 * mo),
            " ",
            LibString.toString(y)
        );
        if (_subDaily(c)) s = string.concat(s, ", ", _two(h), ":", _two(mi), " UTC");
    }

    function symbol() public view override returns (string memory s) {
        (IConfluere c, uint256 i, PoolKey memory k) = _key();
        (, uint256 mo, uint256 d, uint256 h, uint256 mi,) = DateTimeLib.timestampToDateTime(k.expiry);
        s = string.concat(
            _side(i), "-", _sym(k.asset), "-", _two(d), LibString.upper(LibString.slice(_MONTHS, 3 * (mo - 1), 3 * mo))
        );
        if (_subDaily(c)) s = string.concat(s, "-", _two(h), _two(mi));
    }

    function decimals() public view override returns (uint8) {
        (IConfluere c, uint256 i) = _args();
        return c.pool(bytes32(i & ~uint256(1))).assetDecimals;
    }

    /// @notice Lock `amount` of the id (the caller must have approved this wrapper on the core) and mint ERC-20.
    function wrap(uint256 amount, address to) external {
        (IConfluere c, uint256 i) = _args();
        IERC6909Min(address(c)).transferFrom(msg.sender, address(this), i, amount);
        _mint(to, amount);
    }

    function unwrap(uint256 amount, address to) external {
        (IConfluere c, uint256 i) = _args();
        _burn(msg.sender, amount);
        IERC6909Min(address(c)).transfer(to, i, amount);
    }

    string private constant _MONTHS = "JanFebMarAprMayJunJulAugSepOctNovDec";

    function _key() internal view returns (IConfluere c, uint256 i, PoolKey memory k) {
        (c, i) = _args();
        k = c.pool(bytes32(i & ~uint256(1))).key;
    }

    function _side(uint256 i) internal pure returns (string memory) {
        return i & 1 == 1 ? "R" : "C";
    }

    /// @dev Expiries less than a day apart can share a UTC day, so the time is part of the name.
    function _subDaily(IConfluere c) internal view returns (bool) {
        return c.grid().period < 1 days;
    }

    function _two(uint256 n) internal pure returns (string memory) {
        return n < 10 ? string.concat("0", LibString.toString(n)) : LibString.toString(n);
    }

    /// @dev The token's symbol filtered to [A-Za-z0-9.] and cut at 16 characters; `?` when nothing is left.
    function _sym(address t) internal view returns (string memory r) {
        bytes memory b = bytes(MetadataReaderLib.readSymbol(t, 64));
        bytes memory o = new bytes(b.length < 16 ? b.length : 16);
        uint256 n;
        for (uint256 j; j < b.length && n < o.length; ++j) {
            bytes1 x = b[j];
            if ((x >= "0" && x <= "9") || (x >= "A" && x <= "Z") || (x >= "a" && x <= "z") || x == ".") o[n++] = x;
        }
        if (n == 0) return "?";
        assembly ("memory-safe") {
            mstore(o, n)
        }
        r = string(o);
    }

    function _args() internal view returns (IConfluere c, uint256 i) {
        bytes memory a = LibClone.argsOnClone(address(this));
        if (a.length != 64) revert NotClone();
        (c, i) = abi.decode(a, (IConfluere, uint256));
    }
}

interface IERC6909Min {
    function transfer(address receiver, uint256 id, uint256 amount) external returns (bool);
    function transferFrom(address sender, address receiver, uint256 id, uint256 amount) external returns (bool);
}

/// @notice Creates one wrapper per id at a predictable address.
contract ERC6909WrapperFactory {
    address public immutable implementation;
    IConfluere public immutable core;

    event WrapperCreated(uint256 indexed id, address wrapper);

    constructor(IConfluere core_) {
        core = core_;
        implementation = address(new ERC6909Wrapper());
    }

    function wrapperOf(uint256 id) public view returns (address) {
        return LibClone.predictDeterministicAddress(implementation, abi.encode(core, id), bytes32(id), address(this));
    }

    function create(uint256 id) external returns (address w) {
        w = wrapperOf(id);
        if (w.code.length != 0) return w;
        w = LibClone.cloneDeterministic(implementation, abi.encode(core, id), bytes32(id));
        emit WrapperCreated(id, w);
    }
}
