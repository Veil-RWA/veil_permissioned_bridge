// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// Read-only introspection of a live T-REX deployment, for the export tool.
///
/// `tools/export-compliance.js` turns a deployed ERC-3643 token into a
/// `ComplianceSpec` that `MirroredCompliance.apply_spec` consumes, so the twin
/// enforces the same rules as the original. This contract batches the reads
/// that would otherwise be hundreds of RPC round trips.
///
/// The awkward part of T-REX, and why this exists: the modules expose almost no
/// enumeration. `IModularCompliance.getModules()` lists module addresses and
/// `IModule.name()` identifies them, but the configuration inside each module
/// is reachable only through per-item queries:
///
///   CountryAllowModule     `isCountryAllowed(compliance, country)` -- one
///                          country at a time, no list.
///   CountryRestrictModule  `isCountryRestricted(compliance, country)` -- same.
///   TransferRestrictModule `isUserAllowed(compliance, user)` -- one user.
///   SupplyLimitModule      `getSupplyLimit(compliance)` -- readable.
///   MaxBalanceModule       NO GETTER AT ALL. `_maxBalance` is private and only
///                          the `MaxBalanceSet` event ever reveals it.
///
/// So the tool works in two passes: it reconstructs CANDIDATES from event logs
/// (which is the only way to learn the max balance at all), then confirms each
/// candidate against live state through the probes below. Events alone would be
/// wrong -- they show history, including entries since removed -- and probes
/// alone cannot enumerate. Together they give a spec that matches the chain.
///
/// Every probe is `view` and tolerates a module that reverts or is not the type
/// claimed, returning false rather than failing the whole export.
contract ComplianceReader {
    struct TokenInfo {
        address compliance;
        address identityRegistry;
        bool paused;
        uint256 totalSupply;
    }

    function readToken(address token) external view returns (TokenInfo memory info) {
        info.compliance = _addr(token, abi.encodeWithSignature("compliance()"));
        info.identityRegistry = _addr(token, abi.encodeWithSignature("identityRegistry()"));
        info.paused = _bool(token, abi.encodeWithSignature("paused()"));
        info.totalSupply = _uint(token, abi.encodeWithSignature("totalSupply()"));
    }

    /// Module addresses bound to `compliance`, with each module's `name()`.
    function readModules(address compliance)
        external
        view
        returns (address[] memory modules, string[] memory names)
    {
        (bool ok, bytes memory ret) =
            compliance.staticcall(abi.encodeWithSignature("getModules()"));
        if (!ok || ret.length < 64) return (new address[](0), new string[](0));
        modules = abi.decode(ret, (address[]));

        names = new string[](modules.length);
        for (uint256 i = 0; i < modules.length; i++) {
            (bool nameOk, bytes memory nameRet) =
                modules[i].staticcall(abi.encodeWithSignature("name()"));
            names[i] = (nameOk && nameRet.length >= 64) ? abi.decode(nameRet, (string)) : "";
        }
    }

    /// Which of `countries` the module currently allows.
    function probeCountriesAllowed(address module, address compliance, uint16[] calldata countries)
        external
        view
        returns (bool[] memory out)
    {
        out = new bool[](countries.length);
        for (uint256 i = 0; i < countries.length; i++) {
            out[i] = _bool(
                module,
                abi.encodeWithSignature("isCountryAllowed(address,uint16)", compliance, countries[i])
            );
        }
    }

    /// Which of `countries` the module currently restricts.
    function probeCountriesRestricted(
        address module,
        address compliance,
        uint16[] calldata countries
    ) external view returns (bool[] memory out) {
        out = new bool[](countries.length);
        for (uint256 i = 0; i < countries.length; i++) {
            out[i] = _bool(
                module,
                abi.encodeWithSignature(
                    "isCountryRestricted(address,uint16)", compliance, countries[i]
                )
            );
        }
    }

    /// Which of `users` the transfer-restrict module currently allows.
    function probeUsersAllowed(address module, address compliance, address[] calldata users)
        external
        view
        returns (bool[] memory out)
    {
        out = new bool[](users.length);
        for (uint256 i = 0; i < users.length; i++) {
            out[i] = _bool(
                module,
                abi.encodeWithSignature("isUserAllowed(address,address)", compliance, users[i])
            );
        }
    }

    function readSupplyLimit(address module, address compliance) external view returns (uint256) {
        return _uint(module, abi.encodeWithSignature("getSupplyLimit(address)", compliance));
    }

    /// The per-identity balance MaxBalanceModule tracks, used to sanity-check a
    /// reconstructed cap against real holdings before it is applied.
    function readIdBalance(address module, address compliance, address identity)
        external
        view
        returns (uint256)
    {
        return _uint(
            module, abi.encodeWithSignature("getIDBalance(address,address)", compliance, identity)
        );
    }

    // ------------------------------------------------------------- internals

    function _bool(address target, bytes memory data) private view returns (bool) {
        (bool ok, bytes memory ret) = target.staticcall(data);
        return ok && ret.length == 32 && abi.decode(ret, (bool));
    }

    function _uint(address target, bytes memory data) private view returns (uint256) {
        (bool ok, bytes memory ret) = target.staticcall(data);
        return (ok && ret.length == 32) ? abi.decode(ret, (uint256)) : 0;
    }

    function _addr(address target, bytes memory data) private view returns (address) {
        (bool ok, bytes memory ret) = target.staticcall(data);
        return (ok && ret.length == 32) ? abi.decode(ret, (address)) : address(0);
    }
}
