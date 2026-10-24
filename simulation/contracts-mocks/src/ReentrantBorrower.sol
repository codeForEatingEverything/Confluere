// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

interface IERC20Min {
    function approve(address, uint256) external returns (bool);
}

/// @notice Flash borrower that tries to re-enter the core during the callback. Records whether the inner
/// call succeeded; always repays so the outer loan would otherwise go through.
contract ReentrantBorrower {
    address public core;
    bytes public innerCall;
    bool public innerSucceeded;
    bytes public innerRevert;

    constructor(address core_) {
        core = core_;
    }

    function setInner(bytes calldata data) external {
        innerCall = data;
    }

    function onFlashLoan(address, address token, uint256 amount, uint256 fee, bytes calldata) external returns (bytes32) {
        (bool ok, bytes memory ret) = core.call(innerCall);
        innerSucceeded = ok;
        innerRevert = ret;
        IERC20Min(token).approve(msg.sender, amount + fee);
        return keccak256("ERC3156FlashBorrower.onFlashLoan");
    }
}

/// @notice ERC-20 whose transfer re-enters the core (a hostile token used as asset or quote).
contract ReentrantToken {
    string public name = "Evil";
    string public symbol = "EVIL";
    uint8 public decimals = 18;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;
    address public core;
    bytes public innerCall;
    bool public innerSucceeded;
    bool public armed;

    function setCore(address c, bytes calldata data) external {
        core = c;
        innerCall = data;
    }
    function arm(bool a) external {
        armed = a;
    }
    function mint(address to, uint256 amt) external {
        balanceOf[to] += amt;
    }
    function approve(address s, uint256 a) external returns (bool) {
        allowance[msg.sender][s] = a;
        return true;
    }
    function _move(address f, address t, uint256 a) internal {
        require(balanceOf[f] >= a, "bal");
        balanceOf[f] -= a;
        balanceOf[t] += a;
        if (armed && core != address(0)) {
            (bool ok,) = core.call(innerCall);
            innerSucceeded = ok;
        }
    }
    function transfer(address t, uint256 a) external returns (bool) {
        _move(msg.sender, t, a);
        return true;
    }
    function transferFrom(address f, address t, uint256 a) external returns (bool) {
        uint256 al = allowance[f][msg.sender];
        require(al >= a, "allow");
        if (al != type(uint256).max) allowance[f][msg.sender] = al - a;
        _move(f, t, a);
        return true;
    }
}
