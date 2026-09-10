// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

// The five compliance modules the export tool understands.
//
// Names, getters and EVENT SIGNATURES match T-REX v4.1.6 exactly, because
// `tools/export-compliance.js` keys on `name()`, probes the getters through
// `ComplianceReader`, and -- for MaxBalance, which upstream gives no getter at
// all -- reconstructs the cap from `MaxBalanceSet` logs. A near-miss in any of
// those and the export silently produces a spec that does not match the chain.
//
// Each module keys its configuration on the COMPLIANCE address, as upstream
// does, so one module deployment can serve several tokens.

interface IIdentityLookup {
    function investorCountry(address account) external view returns (uint16);
}

interface IComplianceToken {
    function tokenBound() external view returns (address);
}

/// Shared ownership + the no-op hooks a module that tracks nothing still needs.
abstract contract ModuleBase {
    address public owner;

    error NotOwner();

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    constructor(address owner_) {
        owner = owner_;
    }

    function moduleTransferAction(address, address, uint256) external virtual {}
    function moduleMintAction(address, uint256) external virtual {}
    function moduleBurnAction(address, uint256) external virtual {}
}

// ── CountryAllowModule ───────────────────────────────────────────────────────
/// An allow-list: only listed countries may RECEIVE. An empty list allows
/// everyone, matching upstream -- a module bound with nothing configured must
/// not brick the token.
contract CountryAllowModule is ModuleBase {
    mapping(address => mapping(uint16 => bool)) private _allowed;
    mapping(address => uint256) public allowedCount;

    event CountryAllowed(address _compliance, uint16 _country);
    event CountryUnallowed(address _compliance, uint16 _country);

    constructor(address owner_) ModuleBase(owner_) {}

    function name() external pure returns (string memory) {
        return "CountryAllowModule";
    }

    function addAllowedCountry(address compliance, uint16 country) public onlyOwner {
        if (!_allowed[compliance][country]) {
            _allowed[compliance][country] = true;
            allowedCount[compliance] += 1;
            emit CountryAllowed(compliance, country);
        }
    }

    function batchAllowCountries(address compliance, uint16[] calldata countries)
        external
        onlyOwner
    {
        for (uint256 i = 0; i < countries.length; i++) addAllowedCountry(compliance, countries[i]);
    }

    function removeAllowedCountry(address compliance, uint16 country) external onlyOwner {
        if (_allowed[compliance][country]) {
            _allowed[compliance][country] = false;
            allowedCount[compliance] -= 1;
            emit CountryUnallowed(compliance, country);
        }
    }

    function isCountryAllowed(address compliance, uint16 country) external view returns (bool) {
        return _allowed[compliance][country];
    }

    function moduleCheck(address, address to, uint256, address compliance)
        external view returns (bool)
    {
        if (allowedCount[compliance] == 0) return true;   // unconfigured = open
        if (to == address(0)) return true;                // burn
        address registry = _registryOf(compliance);
        if (registry == address(0)) return true;
        return _allowed[compliance][IIdentityLookup(registry).investorCountry(to)];
    }

    function _registryOf(address compliance) internal view returns (address) {
        address token = IComplianceToken(compliance).tokenBound();
        if (token == address(0)) return address(0);
        (bool ok, bytes memory ret) =
            token.staticcall(abi.encodeWithSignature("identityRegistry()"));
        return (ok && ret.length >= 32) ? abi.decode(ret, (address)) : address(0);
    }
}

// ── CountryRestrictModule ────────────────────────────────────────────────────
/// A deny-list: listed countries may not RECEIVE.
contract CountryRestrictModule is ModuleBase {
    mapping(address => mapping(uint16 => bool)) private _restricted;

    event AddedRestrictedCountry(address indexed _compliance, uint16 _country);
    event RemovedRestrictedCountry(address indexed _compliance, uint16 _country);

    constructor(address owner_) ModuleBase(owner_) {}

    function name() external pure returns (string memory) {
        return "CountryRestrictModule";
    }

    function addCountryRestriction(address compliance, uint16 country) public onlyOwner {
        _restricted[compliance][country] = true;
        emit AddedRestrictedCountry(compliance, country);
    }

    function batchRestrictCountries(address compliance, uint16[] calldata countries)
        external
        onlyOwner
    {
        for (uint256 i = 0; i < countries.length; i++) {
            addCountryRestriction(compliance, countries[i]);
        }
    }

    function removeCountryRestriction(address compliance, uint16 country) external onlyOwner {
        _restricted[compliance][country] = false;
        emit RemovedRestrictedCountry(compliance, country);
    }

    function isCountryRestricted(address compliance, uint16 country) external view returns (bool) {
        return _restricted[compliance][country];
    }

    function moduleCheck(address, address to, uint256, address compliance)
        external view returns (bool)
    {
        if (to == address(0)) return true;
        address token = IComplianceToken(compliance).tokenBound();
        if (token == address(0)) return true;
        (bool ok, bytes memory ret) =
            token.staticcall(abi.encodeWithSignature("identityRegistry()"));
        if (!ok || ret.length < 32) return true;
        address registry = abi.decode(ret, (address));
        return !_restricted[compliance][IIdentityLookup(registry).investorCountry(to)];
    }
}

// ── TransferRestrictModule ───────────────────────────────────────────────────
/// An allow-list of addresses. Upstream clears a transfer when EITHER party is
/// listed, and mints and burns pass unconditionally.
contract TransferRestrictModule is ModuleBase {
    mapping(address => mapping(address => bool)) private _allowedUsers;
    mapping(address => uint256) public allowedUserCount;

    event UserAllowed(address _compliance, address _userAddress);
    event UserDisallowed(address _compliance, address _userAddress);

    constructor(address owner_) ModuleBase(owner_) {}

    function name() external pure returns (string memory) {
        return "TransferRestrictModule";
    }

    function allowUser(address compliance, address user) public onlyOwner {
        if (!_allowedUsers[compliance][user]) {
            _allowedUsers[compliance][user] = true;
            allowedUserCount[compliance] += 1;
            emit UserAllowed(compliance, user);
        }
    }

    function batchAllowUsers(address compliance, address[] calldata users) external onlyOwner {
        for (uint256 i = 0; i < users.length; i++) allowUser(compliance, users[i]);
    }

    function disallowUser(address compliance, address user) external onlyOwner {
        if (_allowedUsers[compliance][user]) {
            _allowedUsers[compliance][user] = false;
            allowedUserCount[compliance] -= 1;
            emit UserDisallowed(compliance, user);
        }
    }

    function isUserAllowed(address compliance, address user) external view returns (bool) {
        return _allowedUsers[compliance][user];
    }

    function moduleCheck(address from, address to, uint256, address compliance)
        external view returns (bool)
    {
        if (allowedUserCount[compliance] == 0) return true;
        if (from == address(0) || to == address(0)) return true;   // mint / burn
        return _allowedUsers[compliance][from] || _allowedUsers[compliance][to];
    }
}

// ── SupplyLimitModule ────────────────────────────────────────────────────────
/// A cap on total supply, checked on mint only.
contract SupplyLimitModule is ModuleBase {
    mapping(address => uint256) private _limits;

    event SupplyLimitSet(address _compliance, uint256 _limit);

    constructor(address owner_) ModuleBase(owner_) {}

    function name() external pure returns (string memory) {
        return "SupplyLimitModule";
    }

    function setSupplyLimit(address compliance, uint256 limit) external onlyOwner {
        _limits[compliance] = limit;
        emit SupplyLimitSet(compliance, limit);
    }

    function getSupplyLimit(address compliance) external view returns (uint256) {
        return _limits[compliance];
    }

    function moduleCheck(address from, address, uint256 amount, address compliance)
        external view returns (bool)
    {
        uint256 limit = _limits[compliance];
        if (limit == 0) return true;
        if (from != address(0)) return true;   // mints only
        address token = IComplianceToken(compliance).tokenBound();
        if (token == address(0)) return true;
        (bool ok, bytes memory ret) = token.staticcall(abi.encodeWithSignature("totalSupply()"));
        if (!ok || ret.length < 32) return true;
        return abi.decode(ret, (uint256)) + amount <= limit;
    }
}

// ── MaxBalanceModule ─────────────────────────────────────────────────────────
/// A per-holder cap.
///
/// Upstream exposes NO getter for the cap -- `_maxBalance` is private and only
/// `MaxBalanceSet` ever reveals it -- which is the whole reason the export tool
/// reads event logs. That quirk is reproduced deliberately: a faucet that
/// helpfully added a getter would let the tool's event path go untested, and
/// that path is the one that runs against a real issuer's token.
contract MaxBalanceModule is ModuleBase {
    mapping(address => uint256) private _maxBalance;
    mapping(address => mapping(address => uint256)) private _idBalance;

    event MaxBalanceSet(address indexed _compliance, uint256 indexed _maxBalance);

    constructor(address owner_) ModuleBase(owner_) {}

    function name() external pure returns (string memory) {
        return "MaxBalanceModule";
    }

    function setMaxBalance(address compliance, uint256 max) external onlyOwner {
        _maxBalance[compliance] = max;
        emit MaxBalanceSet(compliance, max);
    }

    /// The per-identity ledger IS readable upstream, and the reader uses it.
    function getIDBalance(address compliance, address identity) external view returns (uint256) {
        return _idBalance[compliance][identity];
    }

    function moduleCheck(address, address to, uint256 amount, address compliance)
        external view returns (bool)
    {
        uint256 max = _maxBalance[compliance];
        if (max == 0) return true;
        if (to == address(0)) return true;
        if (amount > max) return false;
        return _idBalance[compliance][to] + amount <= max;
    }

    // The ledger only stays correct if every movement is reported, so all three
    // hooks are implemented here rather than inherited as no-ops.
    function moduleTransferAction(address from, address to, uint256 amount) external override {
        _idBalance[msg.sender][from] -= amount;
        _idBalance[msg.sender][to] += amount;
    }

    function moduleMintAction(address to, uint256 amount) external override {
        _idBalance[msg.sender][to] += amount;
    }

    function moduleBurnAction(address from, uint256 amount) external override {
        uint256 held = _idBalance[msg.sender][from];
        _idBalance[msg.sender][from] = held > amount ? held - amount : 0;
    }
}
