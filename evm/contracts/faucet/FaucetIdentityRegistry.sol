// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// The identity registry for the testnet faucet assets.
///
/// T-REX shaped, so the bridge, the lockbox and `tools/export-compliance.js`
/// read it exactly as they would a production deployment: `isVerified` and
/// `investorCountry` are the two calls the whole bridge turns on.
///
/// Not a full ONCHAINID stack. A real T-REX registry resolves an address to an
/// identity contract and checks claims signed by trusted issuers; that machinery
/// is what an ISSUER brings, and reproducing it would test their KYC provider
/// rather than this bridge. Here an agent records the verdict directly. The
/// SURFACE is identical, which is the part the bridge depends on.
contract FaucetIdentityRegistry {
    address public owner;
    mapping(address => bool) public isAgent;

    struct Identity {
        bool registered;
        uint16 country;   // ISO-3166 numeric
    }
    mapping(address => Identity) private _identities;

    event OwnerChanged(address indexed previous, address indexed current);
    event AgentAdded(address indexed agent);
    event AgentRemoved(address indexed agent);
    event IdentityRegistered(address indexed account, uint16 country);
    event IdentityRemoved(address indexed account);
    event CountryUpdated(address indexed account, uint16 country);

    error NotOwner();
    error NotAgent();
    error ZeroAddress();

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    /// Agents include the owner, so a one-account testnet deploy needs no extra
    /// wiring before it can register anybody.
    modifier onlyAgent() {
        if (msg.sender != owner && !isAgent[msg.sender]) revert NotAgent();
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

    /// The faucet token is added here so its `claim()` can register a caller.
    function addAgent(address agent) external onlyOwner {
        if (agent == address(0)) revert ZeroAddress();
        isAgent[agent] = true;
        emit AgentAdded(agent);
    }

    function removeAgent(address agent) external onlyOwner {
        isAgent[agent] = false;
        emit AgentRemoved(agent);
    }

    function registerIdentity(address account, uint16 country) external onlyAgent {
        if (account == address(0)) revert ZeroAddress();
        _identities[account] = Identity({registered: true, country: country});
        emit IdentityRegistered(account, country);
    }

    function batchRegisterIdentity(address[] calldata accounts, uint16[] calldata countries)
        external
        onlyAgent
    {
        require(accounts.length == countries.length, "length mismatch");
        for (uint256 i = 0; i < accounts.length; i++) {
            _identities[accounts[i]] = Identity({registered: true, country: countries[i]});
            emit IdentityRegistered(accounts[i], countries[i]);
        }
    }

    /// Revocation. The bridge treats a revoked holder as ineligible on both
    /// legs, so this is how that path gets exercised on testnet.
    function deleteIdentity(address account) external onlyAgent {
        delete _identities[account];
        emit IdentityRemoved(account);
    }

    function updateCountry(address account, uint16 country) external onlyAgent {
        _identities[account].country = country;
        emit CountryUpdated(account, country);
    }

    // ── The two calls the bridge actually makes ─────────────────────────────
    function isVerified(address account) external view returns (bool) {
        return _identities[account].registered;
    }

    function investorCountry(address account) external view returns (uint16) {
        return _identities[account].country;
    }

    function identity(address account) external view returns (bool registered, uint16 country) {
        Identity memory id = _identities[account];
        return (id.registered, id.country);
    }
}
