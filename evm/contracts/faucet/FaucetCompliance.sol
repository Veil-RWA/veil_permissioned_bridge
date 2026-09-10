// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IComplianceModule {
    function moduleCheck(address from, address to, uint256 amount, address compliance)
        external view returns (bool);
    function moduleTransferAction(address from, address to, uint256 amount) external;
    function moduleMintAction(address to, uint256 amount) external;
    function moduleBurnAction(address from, uint256 amount) external;
    function name() external pure returns (string memory);
}

/// Modular compliance for the testnet faucet assets, shaped like T-REX's.
///
/// `getModules()` is the entry point `ComplianceReader.readModules` uses and
/// `tools/export-compliance.js` walks, so the export -> `apply_spec` path that
/// replicates rules onto the Starknet twin works against this exactly as it
/// would against a production token.
///
/// Modules are asked in order and ALL must agree: T-REX's own semantics, and
/// the reason a single restrictive module can block a transfer the others allow.
contract FaucetCompliance {
    address public owner;
    address public tokenBound;
    address[] private _modules;
    mapping(address => bool) public isModuleBound;

    event OwnerChanged(address indexed previous, address indexed current);
    event TokenBound(address indexed token);
    event ModuleAdded(address indexed module);
    event ModuleRemoved(address indexed module);

    error NotOwner();
    error NotToken();
    error ZeroAddress();
    error AlreadyBound();
    error NotBound();

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    /// Only the bound token may report movements, or a caller could desync the
    /// per-identity ledger MaxBalance keeps.
    modifier onlyToken() {
        if (msg.sender != tokenBound) revert NotToken();
        _;
    }

    constructor(address owner_) {
        if (owner_ == address(0)) revert ZeroAddress();
        owner = owner_;
        emit OwnerChanged(address(0), owner_);
    }

    function transferOwnership(address next) external onlyOwner {
        if (next == address(0)) revert ZeroAddress();
        emit OwnerChanged(owner, next);
        owner = next;
    }

    function bindToken(address token) external onlyOwner {
        if (token == address(0)) revert ZeroAddress();
        tokenBound = token;
        emit TokenBound(token);
    }

    function addModule(address module) external onlyOwner {
        if (module == address(0)) revert ZeroAddress();
        if (isModuleBound[module]) revert AlreadyBound();
        isModuleBound[module] = true;
        _modules.push(module);
        emit ModuleAdded(module);
    }

    function removeModule(address module) external onlyOwner {
        if (!isModuleBound[module]) revert NotBound();
        isModuleBound[module] = false;
        for (uint256 i = 0; i < _modules.length; i++) {
            if (_modules[i] == module) {
                _modules[i] = _modules[_modules.length - 1];
                _modules.pop();
                break;
            }
        }
        emit ModuleRemoved(module);
    }

    /// What the reader and the export tool enumerate.
    function getModules() external view returns (address[] memory) {
        return _modules;
    }

    /// Every bound module must allow the transfer.
    ///
    /// A module that reverts or is not a module at all counts as a REFUSAL, not
    /// as silent approval: compliance failing open is the one direction that
    /// must never happen.
    function canTransfer(address from, address to, uint256 amount) external view returns (bool) {
        for (uint256 i = 0; i < _modules.length; i++) {
            (bool ok, bytes memory ret) = _modules[i].staticcall(
                abi.encodeWithSelector(
                    IComplianceModule.moduleCheck.selector, from, to, amount, address(this)
                )
            );
            if (!ok || ret.length < 32 || !abi.decode(ret, (bool))) return false;
        }
        return true;
    }

    // ── Movement hooks. MaxBalance's ledger is only correct if every one fires.
    function transferred(address from, address to, uint256 amount) external onlyToken {
        for (uint256 i = 0; i < _modules.length; i++) {
            IComplianceModule(_modules[i]).moduleTransferAction(from, to, amount);
        }
    }

    function created(address to, uint256 amount) external onlyToken {
        for (uint256 i = 0; i < _modules.length; i++) {
            IComplianceModule(_modules[i]).moduleMintAction(to, amount);
        }
    }

    function destroyed(address from, uint256 amount) external onlyToken {
        for (uint256 i = 0; i < _modules.length; i++) {
            IComplianceModule(_modules[i]).moduleBurnAction(from, amount);
        }
    }
}
