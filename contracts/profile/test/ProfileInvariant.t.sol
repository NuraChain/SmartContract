// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {NuraProfile} from "../NuraProfile.sol";
import {NuraProfileProxy} from "../NuraProfileProxy.sol";
import {FieldInput} from "../ProfileTypes.sol";

interface Vm {
    function prank(address sender) external;
}

/**
 * Drives one profile's item collections through random sequences on behalf of the invariant
 * runner: typed and generic adds, typed and generic removes, attribute writes, and the
 * occasional username change and transfer, so the id bookkeeping is exercised under every
 * path that touches it.
 *
 * Every action guards its own preconditions and returns early instead of reverting, so the
 * fuzzer spends its budget on sequences that reach the contract.
 */
contract ProfileHandler {
    Vm private constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));

    NuraProfile public immutable profile;
    uint256 public immutable profileId;

    /// @dev The kinds in play. Two have typed paths (website, image); the third only the generic one.
    string[3] public kinds = ["website", "image", "wallet"];

    /// @dev Ceiling on live items, so the invariant walks stay cheap.
    uint256 private constant MAX_LIVE = 40;

    /// @notice Live item ids per kind, mirrored off-chain for the set invariants.
    mapping(uint256 kindIndex => uint256[] ids) private live;
    /// @notice Every id ever handed out, in order, so retired ids can be checked too.
    uint256[] public everAdded;
    mapping(uint256 itemId => bool) public isLive;
    mapping(uint256 itemId => uint256 kindIndex) public kindOf;

    /// @notice Who currently owns the profile (transfers move it between these two).
    address public owner;
    address private constant OTHER = address(0x0DD);

    constructor(NuraProfile profile_) {
        profile = profile_;
        owner = address(this);
        profileId = profile_.createProfile("handler", "Handler", "", "");
    }

    function liveCount(uint256 kindIndex) external view returns (uint256) {
        return live[kindIndex].length;
    }

    function liveIds(uint256 kindIndex) external view returns (uint256[] memory) {
        return live[kindIndex];
    }

    function everAddedCount() external view returns (uint256) {
        return everAdded.length;
    }

    function _track(uint256 itemId, uint256 kindIndex) private {
        live[kindIndex].push(itemId);
        everAdded.push(itemId);
        isLive[itemId] = true;
        kindOf[itemId] = kindIndex;
    }

    function _forget(uint256 itemId) private {
        uint256[] storage ids = live[kindOf[itemId]];
        for (uint256 i = 0; i < ids.length; i++) {
            if (ids[i] == itemId) {
                ids[i] = ids[ids.length - 1];
                ids.pop();
                break;
            }
        }
        isLive[itemId] = false;
    }

    function _totalLive() private view returns (uint256 n) {
        for (uint256 k = 0; k < 3; k++) n += live[k].length;
    }

    // -------------------------------------------------------------------------------
    // Actions
    // -------------------------------------------------------------------------------

    function addTyped(uint256 seed) external {
        if (_totalLive() >= MAX_LIVE) return;
        uint256 kindIndex = seed % 2;
        vm.prank(owner);
        uint256 itemId = kindIndex == 0
            ? profile.addWebsite(profileId, "https://example", "Example")
            : profile.addImage(profileId, "ipfs://example", "gallery", "Example");
        _track(itemId, kindIndex);
    }

    function addGeneric(uint256 seed, uint8 attrCount) external {
        if (_totalLive() >= MAX_LIVE) return;
        uint256 kindIndex = seed % 3;
        uint256 n = attrCount % 4;
        FieldInput[] memory attrs = new FieldInput[](n);
        for (uint256 i = 0; i < n; i++) {
            attrs[i] = FieldInput({key: i == 0 ? "url" : "label", lang: i % 2 == 0 ? "" : "fa", value: "v"});
        }
        vm.prank(owner);
        uint256 itemId = profile.addItem(profileId, kinds[kindIndex], attrs);
        _track(itemId, kindIndex);
    }

    function removeTyped(uint256 seed) external {
        uint256 kindIndex = seed % 2;
        uint256[] storage ids = live[kindIndex];
        if (ids.length == 0) return;
        uint256 itemId = ids[(seed / 2) % ids.length];
        vm.prank(owner);
        if (kindIndex == 0) profile.removeWebsite(profileId, itemId);
        else profile.removeImage(profileId, itemId);
        _forget(itemId);
    }

    function removeGeneric(uint256 seed) external {
        uint256 kindIndex = seed % 3;
        uint256[] storage ids = live[kindIndex];
        if (ids.length == 0) return;
        uint256 itemId = ids[(seed / 3) % ids.length];
        vm.prank(owner);
        profile.removeItem(profileId, itemId);
        _forget(itemId);
    }

    function setAttribute(uint256 seed) external {
        uint256 kindIndex = seed % 3;
        uint256[] storage ids = live[kindIndex];
        if (ids.length == 0) return;
        uint256 itemId = ids[(seed / 3) % ids.length];
        vm.prank(owner);
        profile.setItemAttribute(profileId, itemId, "title", seed % 2 == 0 ? "" : "de", seed % 5 == 0 ? "" : "t");
    }

    function rename(uint256 seed) external {
        string memory name = seed % 2 == 0 ? "handler" : "handler_two";
        if (keccak256(bytes(profile.usernameOf(profileId))) == keccak256(bytes(name))) return;
        vm.prank(owner);
        profile.setUsername(profileId, name);
    }

    function transfer() external {
        address to = owner == address(this) ? OTHER : address(this);
        vm.prank(owner);
        profile.transferProfile(profileId, to);
        vm.prank(to);
        profile.acceptProfile(profileId);
        owner = to;
    }
}

/**
 * Invariants over the item bookkeeping: whatever the sequence, every kind's on-chain list is
 * exactly the set of live ids of that kind, every live id reports its kind, every retired id
 * reports none, ids are unique and never reused, and the profile's counter is the number of
 * ids ever issued.
 */
contract ProfileInvariantTest {
    NuraProfile private profile;
    ProfileHandler private handler;

    function setUp() public {
        NuraProfile impl = new NuraProfile();
        NuraProfileProxy proxy =
            new NuraProfileProxy(address(impl), abi.encodeCall(NuraProfile.initialize, (address(this))));
        profile = NuraProfile(address(proxy));
        handler = new ProfileHandler(profile);
    }

    function targetContracts() public view returns (address[] memory targets) {
        targets = new address[](1);
        targets[0] = address(handler);
    }

    function invariant_kindListsMatchLiveSets() public view {
        uint256 pid = handler.profileId();
        for (uint256 k = 0; k < 3; k++) {
            uint256[] memory onChain = profile.getItemIds(pid, handler.kinds(k));
            uint256[] memory expected = handler.liveIds(k);
            assert(onChain.length == expected.length);
            assert(profile.getItemCount(pid, handler.kinds(k)) == expected.length);
            for (uint256 i = 0; i < onChain.length; i++) {
                assert(handler.isLive(onChain[i]));
                assert(handler.kindOf(onChain[i]) == k);
                for (uint256 j = i + 1; j < onChain.length; j++) assert(onChain[i] != onChain[j]);
            }
        }
    }

    function invariant_kindsAreReportedPerId() public view {
        uint256 pid = handler.profileId();
        uint256 n = handler.everAddedCount();
        for (uint256 i = 0; i < n; i++) {
            uint256 itemId = handler.everAdded(i);
            string memory kind = profile.getItemKind(pid, itemId);
            if (handler.isLive(itemId)) {
                assert(keccak256(bytes(kind)) == keccak256(bytes(handler.kinds(handler.kindOf(itemId)))));
            } else {
                assert(bytes(kind).length == 0);
            }
        }
    }

    function invariant_idsAreSequentialAndNeverReused() public view {
        uint256 pid = handler.profileId();
        uint256 n = handler.everAddedCount();
        for (uint256 i = 0; i < n; i++) assert(handler.everAdded(i) == i + 1);
        assert(profile.getProfileRecord(pid).itemsCreated == n);
    }

    function invariant_ownershipIndexIsConsistent() public view {
        uint256 pid = handler.profileId();
        address owner = handler.owner();
        assert(profile.ownerOf(pid) == owner);
        assert(profile.profileIdOf(owner) == pid);
        assert(profile.pendingOwnerOf(pid) == address(0));
        (uint256 resolved, address resolvedOwner) = profile.resolveUsername(profile.usernameOf(pid));
        assert(resolved == pid && resolvedOwner == owner);
    }
}
