// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {ERC721} from "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/**
 * @title CollateralizedNFT
 * @notice An ERC721 where every token is a claim on a fixed amount of one ERC20, held by
 *         this contract. Minting reserves the current `lockAmount` for the new token id;
 *         redeeming burns the token and pays that exact amount to its owner.
 *
 * The reserved amount is recorded per token id at mint time and never changes afterwards.
 * `setLockAmount` only decides what the *next* mint reserves, so an admin cannot inflate
 * or deflate what an outstanding NFT is worth:
 *
 *   lockAmount = 250e18  ->  NFT #1 = 250e18, NFT #2 = 250e18
 *   setLockAmount(500e18)
 *   lockAmount = 500e18  ->  NFT #3 = 500e18, NFT #4 = 500e18
 *   NFT #1 and #2 still redeem for 250e18 each.
 *
 * Solvency rests on two invariants, both enforced by construction rather than checked:
 *
 *   1. totalReserved == sum(lockedAmount[id]) over outstanding ids. Every write to
 *      `lockedAmount` moves `totalReserved` by the same amount in the same call.
 *   2. totalReserved <= backingToken.balanceOf(this). Minting is the only thing that
 *      raises `totalReserved`, and it first checks the unreserved balance covers it.
 *      Nothing can move tokens out except redemption, which lowers both sides equally,
 *      and `withdrawExcessTokens`, which cannot touch the reserved part.
 *
 * @dev Deliberate omissions, each of which would be a way to take collateral from holders:
 *
 *      - No pausing. A pausable `redeem` is an admin switch for freezing other people's
 *        collateral inside the contract. Minting can be closed instead: revoke MINTER_ROLE
 *        and turn off public minting, which stops new positions without touching existing ones.
 *      - No ERC721Burnable. Its `burn` destroys a token without releasing the lock, which
 *        would strand that NFT's collateral and break invariant 1 permanently. `redeem` is
 *        the only path that burns.
 *      - No upgradeability. There is no proxy, so the redemption rule that holders are
 *        trusting cannot be rewritten under them.
 *      - `backingToken` is immutable. Repointing it would leave every outstanding NFT
 *        claiming a token this contract no longer holds.
 */
contract CollateralizedNFT is ERC721, AccessControl, ReentrancyGuard {
    using SafeERC20 for IERC20;

    /**
     * @notice May call `mint` and `mintBatch` while public minting is off.
     * @dev Worth being blunt about what this role is worth: minting is free and redeeming
     *      pays out, so a minter can mint to itself and redeem, walking away with the
     *      unreserved balance. That is the same reach `withdrawExcessTokens` gives the admin,
     *      by a longer route. What neither can reach is collateral already behind someone
     *      else's NFT — that is what the reserve accounting protects.
     */
    bytes32 public constant MINTER_ROLE = keccak256("MINTER_ROLE");

    /// @notice The ERC20 locked behind every NFT. Immutable, see the note on the contract.
    IERC20 public immutable backingToken;

    /// @notice Amount reserved for the next NFT minted, in the backing token's own decimals.
    uint256 public lockAmount;

    /// @notice Sum of `lockedAmount` over every outstanding NFT. Never exceeds the balance.
    uint256 public totalReserved;

    /// @notice NFTs minted since deployment. Doubles as the id counter: ids run 1..totalMinted.
    uint256 public totalMinted;

    /// @notice NFTs redeemed since deployment.
    uint256 public totalRedeemed;

    /// @notice Whether anyone may mint, or only MINTER_ROLE. Off at deployment.
    bool public publicMintEnabled;

    /// @notice Amount this NFT redeems for. Zero for ids never minted or already redeemed.
    mapping(uint256 tokenId => uint256 amount) public lockedAmount;

    string private _baseTokenURI;

    /// @notice Emitted when backing tokens arrive through `deposit`.
    event Deposited(address indexed from, uint256 amount, uint256 newBalance);

    /// @notice Emitted on mint, recording the amount permanently reserved for this token id.
    event NFTMinted(address indexed recipient, uint256 indexed tokenId, uint256 lockedAmount);

    /// @notice Emitted on redemption, recording what the owner was paid.
    event NFTRedeemed(address indexed owner, uint256 indexed tokenId, uint256 returnedAmount);

    /// @notice Emitted when the amount for future mints changes. Outstanding NFTs are unaffected.
    event LockAmountUpdated(uint256 previousAmount, uint256 newAmount);

    /// @notice Emitted when minting opens to everyone, or closes back to MINTER_ROLE.
    event PublicMintUpdated(bool enabled);

    /// @notice Emitted when the metadata base URI changes.
    event BaseURIUpdated(string newBaseURI);

    /// @notice Emitted when the admin withdraws unreserved backing tokens.
    event ExcessTokensWithdrawn(address indexed to, uint256 amount);

    /// @notice Emitted when the admin sweeps a token that is not the backing token.
    event TokensRescued(address indexed token, address indexed to, uint256 amount);

    error ZeroAddress();
    error ZeroAmount();
    error ZeroQuantity();
    error InsufficientBacking(uint256 available, uint256 required);
    error NotTokenOwner(uint256 tokenId, address owner, address caller);
    error MintNotPermitted(address caller);
    error BackingTokenNotRescuable();

    /**
     * @param admin         Receives DEFAULT_ADMIN_ROLE and MINTER_ROLE. Cannot be the zero address.
     * @param backingToken_ The ERC20 locked behind each NFT. Fixed for the life of the contract.
     * @param lockAmount_   Starting reservation per NFT, already scaled, e.g. 250e18 for a
     *                      250-token lock on an 18-decimal token.
     * @param name_         ERC721 name.
     * @param symbol_       ERC721 symbol.
     * @param baseURI_      Metadata prefix; `tokenURI` appends the decimal token id. May be empty
     *                      and set later with `setBaseURI`.
     */
    constructor(
        address admin,
        IERC20 backingToken_,
        uint256 lockAmount_,
        string memory name_,
        string memory symbol_,
        string memory baseURI_
    ) ERC721(name_, symbol_) {
        if (admin == address(0) || address(backingToken_) == address(0)) revert ZeroAddress();
        if (lockAmount_ == 0) revert ZeroAmount();

        backingToken = backingToken_;
        lockAmount = lockAmount_;
        _baseTokenURI = baseURI_;

        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(MINTER_ROLE, admin);
    }

    // ---------------------------------------------------------------------------------
    // Funding
    // ---------------------------------------------------------------------------------

    /**
     * @notice Pulls `amount` backing tokens from the caller into the reserve.
     * @dev Open to anyone, because restricting it would achieve nothing: a plain ERC20
     *      `transfer` to this address adds backing just as well, it only skips the event.
     *      Depositing can never take anything away. It raises the unreserved balance, which
     *      is what `mint` spends against and what `withdrawExcessTokens` is bounded by.
     *
     *      The event reports the balance actually gained, so a fee-on-transfer token records
     *      what arrived rather than what was asked for. Requires an allowance for this contract.
     */
    function deposit(uint256 amount) external nonReentrant {
        if (amount == 0) revert ZeroAmount();

        uint256 balanceBefore = backingToken.balanceOf(address(this));
        backingToken.safeTransferFrom(_msgSender(), address(this), amount);
        uint256 balanceAfter = backingToken.balanceOf(address(this));

        emit Deposited(_msgSender(), balanceAfter - balanceBefore, balanceAfter);
    }

    // ---------------------------------------------------------------------------------
    // Minting
    // ---------------------------------------------------------------------------------

    /**
     * @notice Mints one NFT to `recipient` and reserves the current `lockAmount` for it.
     * @dev Reverts unless the unreserved balance covers the reservation, so an NFT can never
     *      exist without the tokens to redeem it sitting in this contract.
     * @return tokenId The id minted.
     */
    function mint(address recipient) external nonReentrant returns (uint256 tokenId) {
        _requireCanMint();
        if (recipient == address(0)) revert ZeroAddress();

        uint256 amount = _reserve(1);
        tokenId = _mintOne(recipient, amount);
    }

    /**
     * @notice Mints `quantity` NFTs to `recipient`, each reserving the current `lockAmount`.
     * @dev Reserves `quantity * lockAmount` up front and checks it in one go, so a batch that
     *      cannot be fully backed reverts rather than minting a partially backed prefix. The
     *      multiplication reverts on overflow under 0.8 checked arithmetic, and no product large
     *      enough to overflow could pass the backing check anyway. Batch size is bounded by the
     *      block gas limit, not by a cap here.
     * @return firstTokenId The first id minted; the batch runs to `firstTokenId + quantity - 1`.
     */
    function mintBatch(
        address recipient,
        uint256 quantity
    ) external nonReentrant returns (uint256 firstTokenId) {
        _requireCanMint();
        if (recipient == address(0)) revert ZeroAddress();
        if (quantity == 0) revert ZeroQuantity();

        uint256 amount = _reserve(quantity);

        firstTokenId = totalMinted + 1;
        for (uint256 i = 0; i < quantity; ++i) {
            _mintOne(recipient, amount);
        }
    }

    // ---------------------------------------------------------------------------------
    // Redemption
    // ---------------------------------------------------------------------------------

    /**
     * @notice Burns `tokenId` and pays its locked amount to the caller.
     * @dev Only the current owner may call this, and the payout address is that same owner.
     *      There is no recipient argument, so a refund cannot be redirected. Approvals and
     *      operators deliberately do not qualify: approval is permission to move the NFT, not
     *      permission to cash it out.
     */
    function redeem(uint256 tokenId) external nonReentrant {
        _redeem(tokenId);
    }

    /**
     * @notice Alias for `redeem`, for callers that think of it as burning the position.
     * @dev Identical in every respect, including the refund. Nothing in this contract burns an
     *      NFT without paying out its lock.
     */
    function burn(uint256 tokenId) external nonReentrant {
        _redeem(tokenId);
    }

    // ---------------------------------------------------------------------------------
    // Views
    // ---------------------------------------------------------------------------------

    /// @notice Backing tokens held by this contract, reserved and unreserved together.
    function tokenBalance() public view returns (uint256) {
        return backingToken.balanceOf(address(this));
    }

    /**
     * @notice Backing tokens not spoken for by an outstanding NFT.
     * @dev Saturates at zero instead of reverting, so a token that somehow shrinks the balance
     *      below `totalReserved` still leaves this and every caller of it readable.
     */
    function availableBacking() public view returns (uint256) {
        uint256 balance = tokenBalance();
        uint256 reserved = totalReserved;

        return balance > reserved ? balance - reserved : 0;
    }

    /// @notice How many more NFTs the unreserved balance can back at the current `lockAmount`.
    function remainingMintCapacity() public view returns (uint256) {
        return availableBacking() / lockAmount;
    }

    /**
     * @notice NFTs currently outstanding.
     * @dev This contract is not IERC721Enumerable. There is no `tokenByIndex` or
     *      `tokenOfOwnerByIndex`, since per-transfer enumeration costs every holder gas to
     *      serve something an indexer reconstructs from Transfer logs for free.
     */
    function totalSupply() external view returns (uint256) {
        return totalMinted - totalRedeemed;
    }

    /// @notice The whole accounting picture in one call, for dashboards and deploy checks.
    function vaultState()
        external
        view
        returns (
            uint256 balance,
            uint256 reserved,
            uint256 available,
            uint256 minted,
            uint256 redeemed,
            uint256 outstanding,
            uint256 currentLockAmount,
            uint256 mintCapacity
        )
    {
        balance = tokenBalance();
        reserved = totalReserved;
        available = availableBacking();
        minted = totalMinted;
        redeemed = totalRedeemed;
        outstanding = minted - redeemed;
        currentLockAmount = lockAmount;
        mintCapacity = available / currentLockAmount;
    }

    // ---------------------------------------------------------------------------------
    // Administration
    // ---------------------------------------------------------------------------------

    /**
     * @notice Sets the amount reserved for NFTs minted from now on.
     * @dev Does not touch `lockedAmount` for any existing id, so outstanding NFTs keep the
     *      amount they were minted with. Raising this lowers `remainingMintCapacity` without
     *      moving a token.
     */
    function setLockAmount(uint256 newAmount) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (newAmount == 0) revert ZeroAmount();

        emit LockAmountUpdated(lockAmount, newAmount);
        lockAmount = newAmount;
    }

    /**
     * @notice Opens minting to any caller, or closes it back to MINTER_ROLE.
     * @dev Off at deployment, and think hard before turning it on. Minting is free here: the
     *      NFT is backed out of the reserve rather than paid for. With this on, anyone can mint
     *      and immediately redeem, so the entire reserve is claimable by whoever asks first.
     *      That is only sensible if eligibility is enforced somewhere else, such as a minting
     *      contract holding MINTER_ROLE that takes payment, which is what leaving this off is for.
     */
    function setPublicMintEnabled(bool enabled) external onlyRole(DEFAULT_ADMIN_ROLE) {
        publicMintEnabled = enabled;
        emit PublicMintUpdated(enabled);
    }

    /// @notice Sets the metadata prefix that `tokenURI` appends the token id to.
    function setBaseURI(string calldata newBaseURI) external onlyRole(DEFAULT_ADMIN_ROLE) {
        _baseTokenURI = newBaseURI;
        emit BaseURIUpdated(newBaseURI);
    }

    /**
     * @notice Withdraws backing tokens that are not reserved for an outstanding NFT.
     * @dev Bounded by `availableBacking()`, so the collateral behind every live NFT is out of
     *      reach here no matter who holds the admin role. Use it to recover the tail of the
     *      reserve once the programme closes, or an overfunded amount.
     */
    function withdrawExcessTokens(
        address to,
        uint256 amount
    ) external onlyRole(DEFAULT_ADMIN_ROLE) nonReentrant {
        if (to == address(0)) revert ZeroAddress();
        if (amount == 0) revert ZeroAmount();

        uint256 available = availableBacking();
        if (amount > available) revert InsufficientBacking(available, amount);

        emit ExcessTokensWithdrawn(to, amount);
        backingToken.safeTransfer(to, amount);
    }

    /**
     * @notice Sweeps some other ERC20 that was sent here by mistake.
     * @dev Rejects the backing token outright. That token has reserved and unreserved parts and
     *      only `withdrawExcessTokens` knows the difference, so routing it here would be a way
     *      around the reserve bound.
     */
    function rescueERC20(
        IERC20 token,
        address to,
        uint256 amount
    ) external onlyRole(DEFAULT_ADMIN_ROLE) nonReentrant {
        if (token == backingToken) revert BackingTokenNotRescuable();
        if (to == address(0)) revert ZeroAddress();

        emit TokensRescued(address(token), to, amount);
        token.safeTransfer(to, amount);
    }

    // ---------------------------------------------------------------------------------
    // Internals
    // ---------------------------------------------------------------------------------

    /// @dev Reverts unless public minting is on or the caller holds MINTER_ROLE.
    function _requireCanMint() private view {
        if (!publicMintEnabled && !hasRole(MINTER_ROLE, _msgSender())) {
            revert MintNotPermitted(_msgSender());
        }
    }

    /**
     * @dev Books `quantity` reservations at the current rate and returns that per-NFT rate, so
     *      the caller mints with the same number the reserve was moved by. Reading `lockAmount`
     *      once is what keeps the two in step.
     */
    function _reserve(uint256 quantity) private returns (uint256 amountEach) {
        amountEach = lockAmount;
        uint256 required = amountEach * quantity;

        uint256 available = availableBacking();
        if (available < required) revert InsufficientBacking(available, required);

        totalReserved += required;
    }

    /**
     * @dev Assigns the next id and mints it. Every state change lands before `_safeMint`, whose
     *      `onERC721Received` callback hands control to the recipient: by then the reservation
     *      is fully booked, so a re-entrant view of this contract sees a solvent one. Re-entering
     *      `mint` or `redeem` from that callback is blocked by `nonReentrant` on the entry points.
     */
    function _mintOne(address recipient, uint256 amount) private returns (uint256 tokenId) {
        tokenId = ++totalMinted;
        lockedAmount[tokenId] = amount;

        emit NFTMinted(recipient, tokenId, amount);
        _safeMint(recipient, tokenId);
    }

    /// @dev Shared body of `redeem` and `burn`. Both entry points are `nonReentrant`.
    function _redeem(uint256 tokenId) private {
        address owner = _requireOwned(tokenId);
        address caller = _msgSender();
        if (owner != caller) revert NotTokenOwner(tokenId, owner, caller);

        uint256 amount = lockedAmount[tokenId];

        // Effects first: the lock is cleared and the NFT burned before any token moves, so a
        // token with a transfer hook re-entering finds nothing left to claim for this id.
        delete lockedAmount[tokenId];
        totalReserved -= amount;
        ++totalRedeemed;
        _burn(tokenId);

        emit NFTRedeemed(owner, tokenId, amount);
        backingToken.safeTransfer(owner, amount);
    }

    /// @inheritdoc ERC721
    function _baseURI() internal view override returns (string memory) {
        return _baseTokenURI;
    }

    /// @dev Resolves `supportsInterface`, declared by both ERC721 and AccessControl.
    function supportsInterface(
        bytes4 interfaceId
    ) public view override(ERC721, AccessControl) returns (bool) {
        return super.supportsInterface(interfaceId);
    }
}
